import base64
import hashlib
import hmac
import json
import os
import time
from functools import wraps
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, g, jsonify, request, send_from_directory
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token
import requests

try:
    from server.subscriptions import (
        init_subscription_db,
        list_subscription_plans,
        record_subscription_plan,
        record_subscription_signup,
    )
except ModuleNotFoundError:
    from subscriptions import (
        init_subscription_db,
        list_subscription_plans,
        record_subscription_plan,
        record_subscription_signup,
    )

load_dotenv()

app = Flask(__name__)

PORT = int(os.getenv('PORT', '3000'))


def parse_number(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def parse_origins(raw):
    return [part.strip() for part in str(raw or '').split(',') if part.strip()]


allowed_origins = set(parse_origins(os.getenv('CORS_ORIGIN')) + parse_origins(os.getenv('CORS_ORIGINS')))
if not allowed_origins and os.getenv('NODE_ENV') != 'production':
    allowed_origins.add('http://localhost:5173')

SESSION_COOKIE_NAME = 'lt_auth'
SESSION_MAX_AGE_MS = parse_number(os.getenv('AUTH_SESSION_TTL_MS'), 1000 * 60 * 60 * 24 * 7)
SESSION_SECRET = (
    os.getenv('AUTH_SESSION_SECRET')
    or os.getenv('SESSION_SECRET')
    or os.getenv('COOKIE_SECRET')
)
GOOGLE_CLIENT_ID = os.getenv('GOOGLE_CLIENT_ID') or os.getenv('VITE_GOOGLE_CLIENT_ID')
SESSION_ISSUER = 'logintemplate'

ADMIN_EMAILS = set(parse_origins(os.getenv('ADMIN_EMAILS')))

PAYPAL_CLIENT_ID = os.getenv('PAYPAL_CLIENT_ID')
PAYPAL_CLIENT_SECRET = os.getenv('PAYPAL_CLIENT_SECRET')
PAYPAL_ENV = (os.getenv('PAYPAL_ENV') or 'sandbox').lower()
PAYPAL_BASE_URL = os.getenv('PAYPAL_API_BASE_URL')
SUBSCRIPTION_NAME = os.getenv('SUBSCRIPTION_NAME') or 'Prototype Subscription'
SUBSCRIPTION_PRICE = os.getenv('SUBSCRIPTION_PRICE') or ''
SUBSCRIPTION_CURRENCY = os.getenv('SUBSCRIPTION_CURRENCY') or 'USD'

PAYPAL_ACCESS_TOKEN = None
PAYPAL_ACCESS_TOKEN_EXP = 0

SUBSCRIPTIONS_DB_READY = False


def init_subscriptions():
    global SUBSCRIPTIONS_DB_READY
    try:
        init_subscription_db()
        SUBSCRIPTIONS_DB_READY = True
    except Exception as exc:
        SUBSCRIPTIONS_DB_READY = False
        print(f'Failed to init subscriptions DB: {exc}')


init_subscriptions()


def base64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode('utf-8').rstrip('=')


def base64url_decode_bytes(value: str) -> bytes:
    padding = '=' * (-len(value) % 4)
    return base64.urlsafe_b64decode(f'{value}{padding}')


def create_session_token(payload: dict) -> str:
    if not SESSION_SECRET:
        raise RuntimeError('Missing AUTH_SESSION_SECRET for session signing')
    exp = int(time.time() * 1000) + SESSION_MAX_AGE_MS
    session_payload = {**payload, 'iss': SESSION_ISSUER, 'exp': exp}
    body = json.dumps(session_payload, separators=(',', ':'))
    signature = hmac.new(
        SESSION_SECRET.encode('utf-8'), body.encode('utf-8'), hashlib.sha256
    ).digest()
    return f'{base64url_encode(body.encode("utf-8"))}.{base64url_encode(signature)}'


def verify_session_token(token: str):
    if not token or not SESSION_SECRET:
        return None
    parts = token.split('.')
    if len(parts) != 2:
        return None
    body_part, sig_part = parts
    try:
        body = base64url_decode_bytes(body_part).decode('utf-8')
        signature = base64url_decode_bytes(sig_part)
    except Exception:
        return None
    expected_sig = hmac.new(
        SESSION_SECRET.encode('utf-8'), body.encode('utf-8'), hashlib.sha256
    ).digest()
    if not hmac.compare_digest(expected_sig, signature):
        return None
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return None
    if parsed.get('iss') != SESSION_ISSUER:
        return None
    if not parsed.get('exp') or parsed['exp'] < int(time.time() * 1000):
        return None
    return parsed


def get_session_from_request():
    token = request.cookies.get(SESSION_COOKIE_NAME)
    return verify_session_token(token)


def set_session_cookie(response, token: str, clear: bool = False):
    secure = os.getenv('NODE_ENV') == 'production' or os.getenv('COOKIE_SECURE') == 'true'
    max_age = 0 if clear else int(SESSION_MAX_AGE_MS / 1000)
    response.set_cookie(
        SESSION_COOKIE_NAME,
        '' if clear else token,
        max_age=max_age,
        path='/',
        httponly=True,
        secure=secure,
        samesite='Lax',
    )
    return response


def is_admin(session):
    if not session:
        return False
    email = session.get('email')
    if not email:
        return False
    if not ADMIN_EMAILS:
        return False
    return email.lower() in {value.lower() for value in ADMIN_EMAILS}


def paypal_configured():
    return bool(PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET)


def get_paypal_base_url():
    if PAYPAL_BASE_URL:
        return PAYPAL_BASE_URL.rstrip('/')
    if PAYPAL_ENV == 'live':
        return 'https://api-m.paypal.com'
    return 'https://api-m.sandbox.paypal.com'


def get_paypal_access_token():
    global PAYPAL_ACCESS_TOKEN, PAYPAL_ACCESS_TOKEN_EXP
    now = time.time()
    if PAYPAL_ACCESS_TOKEN and (PAYPAL_ACCESS_TOKEN_EXP - 60) > now:
        return PAYPAL_ACCESS_TOKEN
    if not PAYPAL_CLIENT_ID or not PAYPAL_CLIENT_SECRET:
        raise RuntimeError('PayPal credentials are missing')

    response = requests.post(
        f'{get_paypal_base_url()}/v1/oauth2/token',
        auth=(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET),
        data={'grant_type': 'client_credentials'},
        timeout=15,
    )
    response.raise_for_status()
    data = response.json()
    PAYPAL_ACCESS_TOKEN = data.get('access_token')
    PAYPAL_ACCESS_TOKEN_EXP = now + int(data.get('expires_in') or 0)
    if not PAYPAL_ACCESS_TOKEN:
        raise RuntimeError('Failed to fetch PayPal access token')
    return PAYPAL_ACCESS_TOKEN


def fetch_paypal_subscription(subscription_id: str):
    token = get_paypal_access_token()
    response = requests.get(
        f'{get_paypal_base_url()}/v1/billing/subscriptions/{subscription_id}',
        headers={'Authorization': f'Bearer {token}'},
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def create_paypal_product(payload: dict):
    token = get_paypal_access_token()
    response = requests.post(
        f'{get_paypal_base_url()}/v1/catalogs/products',
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
        json=payload,
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def create_paypal_plan(payload: dict):
    token = get_paypal_access_token()
    response = requests.post(
        f'{get_paypal_base_url()}/v1/billing/plans',
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
        json=payload,
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        session = get_session_from_request()
        if not session:
            return jsonify({'error': 'Authentication required'}), 401
        g.user = session
        return fn(*args, **kwargs)

    return wrapper


def add_cors_headers(response):
    origin = request.headers.get('Origin')
    if origin and (not allowed_origins or origin in allowed_origins):
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Vary'] = 'Origin'
        response.headers['Access-Control-Allow-Credentials'] = 'true'
        response.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
        req_headers = request.headers.get('Access-Control-Request-Headers')
        response.headers['Access-Control-Allow-Headers'] = req_headers or 'Content-Type'
    return response


@app.before_request
def handle_options():
    if request.method == 'OPTIONS':
        response = app.make_response('')
        response.status_code = 204
        return add_cors_headers(response)
    return None


@app.after_request
def apply_cors(response):
    return add_cors_headers(response)


@app.get('/health')
def health():
    return jsonify({'status': 'ok'})


@app.get('/api/auth/config')
def auth_config():
    return jsonify(
        {
            'googleAuthConfigured': bool(GOOGLE_CLIENT_ID),
            'googleClientId': GOOGLE_CLIENT_ID or None,
            'sessionTtlMs': SESSION_MAX_AGE_MS,
        }
    )


@app.get('/api/admin/config')
def admin_config():
    session = get_session_from_request()
    return jsonify(
        {
            'authenticated': bool(session),
            'isAdmin': bool(session and is_admin(session)),
            'paypalConfigured': paypal_configured(),
        }
    )


@app.get('/api/subscription/config')
def subscription_config():
    return jsonify(
        {
            'paypalConfigured': paypal_configured(),
            'paypalClientId': PAYPAL_CLIENT_ID or None,
            'paypalEnv': PAYPAL_ENV,
            'subscription': {
                'name': SUBSCRIPTION_NAME,
                'price': SUBSCRIPTION_PRICE,
                'currency': SUBSCRIPTION_CURRENCY,
            },
        }
    )


@app.get('/api/subscription/plans')
def subscription_plans():
    if not SUBSCRIPTIONS_DB_READY:
        return jsonify({'error': 'Subscriptions database not available'}), 500
    try:
        plans = list_subscription_plans()
    except Exception as exc:
        print(f'Failed to load subscription plans: {exc}')
        return jsonify({'error': 'Unable to load subscription plans'}), 500
    return jsonify({'plans': plans})


@app.get('/api/auth/me')
def auth_me():
    session = get_session_from_request()
    if not session:
        return jsonify({'authenticated': False})
    return jsonify(
        {
            'authenticated': True,
            'user': {
                'sub': session.get('sub'),
                'email': session.get('email'),
                'name': session.get('name'),
                'picture': session.get('picture'),
            },
            'issuer': session.get('iss'),
            'expiresAt': session.get('exp'),
        }
    )


@app.post('/api/auth/logout')
def auth_logout():
    response = jsonify({'authenticated': False})
    return set_session_cookie(response, '', clear=True)


@app.post('/api/auth/google')
def auth_google():
    if not GOOGLE_CLIENT_ID:
        return jsonify({'error': 'Google auth not configured'}), 500
    if not SESSION_SECRET:
        return jsonify({'error': 'Missing AUTH_SESSION_SECRET'}), 500

    payload = request.get_json(silent=True) or {}
    credential = payload.get('credential')
    if not credential or not isinstance(credential, str):
        return jsonify({'error': 'Missing Google credential'}), 400

    try:
        request_adapter = google_requests.Request()
        token_payload = id_token.verify_oauth2_token(
            credential, request_adapter, GOOGLE_CLIENT_ID
        )
        if not token_payload:
            return jsonify({'error': 'Invalid Google credential'}), 401
        user = {
            'sub': token_payload.get('sub'),
            'email': token_payload.get('email'),
            'name': token_payload.get('name'),
            'picture': token_payload.get('picture'),
        }
        token = create_session_token(user)
        response = jsonify({'authenticated': True, 'user': user})
        return set_session_cookie(response, token)
    except Exception as exc:
        print(f'Google auth failed: {exc}')
        return jsonify({'error': 'Google authentication failed'}), 401


@app.post('/api/subscription/verify')
@require_auth
def subscription_verify():
    if not paypal_configured():
        return jsonify({'error': 'PayPal is not configured'}), 500
    if not SUBSCRIPTIONS_DB_READY:
        return jsonify({'error': 'Subscriptions database not available'}), 500

    payload = request.get_json(silent=True) or {}
    subscription_id = payload.get('subscriptionId')
    if not subscription_id or not isinstance(subscription_id, str):
        return jsonify({'error': 'Missing subscriptionId'}), 400

    try:
        details = fetch_paypal_subscription(subscription_id)
    except requests.RequestException as exc:
        print(f'PayPal subscription fetch failed: {exc}')
        return jsonify({'error': 'Unable to verify subscription'}), 502
    except Exception as exc:
        print(f'PayPal subscription verification error: {exc}')
        return jsonify({'error': 'Unable to verify subscription'}), 502

    plan_id = details.get('plan_id')
    if not plan_id:
        return jsonify({'error': 'Subscription plan missing'}), 400

    allowed_plan_ids = set()
    try:
        known_plans = list_subscription_plans()
        for plan in known_plans:
            if plan.get('paypal_plan_id'):
                allowed_plan_ids.add(plan['paypal_plan_id'])
    except Exception as exc:
        print(f'Failed to check subscription plans: {exc}')
        return jsonify({'error': 'Unable to verify subscription plan'}), 500

    if allowed_plan_ids and plan_id not in allowed_plan_ids:
        return jsonify({'error': 'Subscription plan mismatch'}), 400

    if not details.get('id'):
        details['id'] = subscription_id

    try:
        record_subscription_signup(g.user, details)
    except Exception as exc:
        print(f'Failed to record subscription: {exc}')
        return jsonify({'error': 'Failed to record subscription'}), 500

    return jsonify(
        {
            'ok': True,
            'subscriptionId': details.get('id') or subscription_id,
            'status': details.get('status'),
            'planId': plan_id,
            'statusUpdatedAt': details.get('status_update_time'),
            'startTime': details.get('start_time'),
        }
    )


@app.get('/api/admin/plans')
@require_auth
def admin_plans():
    if not is_admin(g.user):
        return jsonify({'error': 'Admin access required'}), 403
    if not SUBSCRIPTIONS_DB_READY:
        return jsonify({'error': 'Subscriptions database not available'}), 500
    try:
        plans = list_subscription_plans()
    except Exception as exc:
        print(f'Failed to load plans: {exc}')
        return jsonify({'error': 'Unable to load plans'}), 500
    return jsonify({'plans': plans})


@app.post('/api/admin/plans/create')
@require_auth
def admin_create_plan():
    if not is_admin(g.user):
        return jsonify({'error': 'Admin access required'}), 403
    if not PAYPAL_CLIENT_ID or not PAYPAL_CLIENT_SECRET:
        return jsonify({'error': 'PayPal credentials are missing'}), 500
    if not SUBSCRIPTIONS_DB_READY:
        return jsonify({'error': 'Subscriptions database not available'}), 500

    payload = request.get_json(silent=True) or {}
    product_name = (payload.get('productName') or '').strip()
    product_description = (payload.get('productDescription') or '').strip()
    plan_name = (payload.get('planName') or '').strip() or product_name
    plan_description = (payload.get('planDescription') or '').strip()
    currency = (payload.get('currency') or 'USD').strip().upper()
    interval_unit = (payload.get('intervalUnit') or 'MONTH').strip().upper()
    interval_count = parse_number(payload.get('intervalCount'), 1)
    price_value = str(payload.get('price') or '').strip()

    if not product_name:
        return jsonify({'error': 'Product name is required'}), 400
    if not plan_name:
        return jsonify({'error': 'Plan name is required'}), 400
    if not price_value:
        return jsonify({'error': 'Price is required'}), 400
    if interval_count <= 0:
        return jsonify({'error': 'Interval count must be at least 1'}), 400
    allowed_units = {'DAY', 'WEEK', 'MONTH', 'YEAR'}
    if interval_unit not in allowed_units:
        return jsonify({'error': 'Interval unit must be DAY, WEEK, MONTH, or YEAR'}), 400

    product_payload = {
        'name': product_name,
        'type': 'SERVICE',
        'category': 'SOFTWARE',
    }
    if product_description:
        product_payload['description'] = product_description

    plan_payload = {
        'product_id': None,
        'name': plan_name,
        'billing_cycles': [
            {
                'frequency': {
                    'interval_unit': interval_unit,
                    'interval_count': interval_count,
                },
                'tenure_type': 'REGULAR',
                'sequence': 1,
                'total_cycles': 0,
                'pricing_scheme': {
                    'fixed_price': {
                        'value': price_value,
                        'currency_code': currency,
                    }
                },
            }
        ],
        'payment_preferences': {
            'auto_bill_outstanding': True,
            'setup_fee_failure_action': 'CANCEL',
            'payment_failure_threshold': 3,
        },
    }
    if plan_description:
        plan_payload['description'] = plan_description

    try:
        product = create_paypal_product(product_payload)
        plan_payload['product_id'] = product.get('id')
        plan = create_paypal_plan(plan_payload)
    except requests.RequestException as exc:
        print(f'PayPal plan creation failed: {exc}')
        return jsonify({'error': 'PayPal plan creation failed'}), 502
    except Exception as exc:
        print(f'PayPal plan creation error: {exc}')
        return jsonify({'error': 'PayPal plan creation failed'}), 502

    try:
        record_subscription_plan(
            g.user,
            product,
            plan,
            price_value,
            currency,
            interval_unit,
            interval_count,
        )
    except Exception as exc:
        print(f'Failed to record plan: {exc}')
        return jsonify({'error': 'Failed to record plan'}), 500

    return jsonify(
        {
            'ok': True,
            'product': {'id': product.get('id'), 'name': product.get('name')},
            'plan': {
                'id': plan.get('id'),
                'name': plan.get('name'),
                'status': plan.get('status'),
            },
        }
    )


@app.get('/api/secret')
@require_auth
def secret():
    email = g.user.get('email') if hasattr(g, 'user') else None
    sub = g.user.get('sub') if hasattr(g, 'user') else None
    identifier = email or sub or 'unknown user'
    return jsonify({'message': f'You are authenticated as {identifier}.'})


CLIENT_DIST = Path(__file__).resolve().parent.parent / 'client' / 'dist'
if CLIENT_DIST.exists():

    @app.route('/', defaults={'path': ''})
    @app.route('/<path:path>')
    def serve_client(path):
        file_path = CLIENT_DIST / path
        if path and file_path.exists():
            return send_from_directory(CLIENT_DIST, path)
        return send_from_directory(CLIENT_DIST, 'index.html')


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=PORT, debug=os.getenv('NODE_ENV') != 'production')
