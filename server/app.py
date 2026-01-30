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
