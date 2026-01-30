import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

try:
    import psycopg2
except ImportError:  # pragma: no cover - optional dependency
    psycopg2 = None

DEFAULT_DB_PATH = Path(__file__).resolve().parent / 'data' / 'subscriptions.db'


def _get_backend():
    database_url = os.getenv('DATABASE_URL')
    if database_url:
        return 'postgres', database_url
    db_path = os.getenv('SUBSCRIPTIONS_DB_PATH')
    return 'sqlite', str(Path(db_path) if db_path else DEFAULT_DB_PATH)


def _connect(backend, target):
    if backend == 'postgres':
        if psycopg2 is None:
            raise RuntimeError('psycopg2-binary is required when DATABASE_URL is set')
        return psycopg2.connect(target)
    db_path = Path(target)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _execute(conn, backend, sql, params=None):
    if backend == 'postgres':
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
        conn.commit()
        return None
    conn.execute(sql, params or ())
    conn.commit()
    return None


def _query(conn, backend, sql, params=None):
    if backend == 'postgres':
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            columns = [desc[0] for desc in cur.description]
            rows = cur.fetchall()
        return [dict(zip(columns, row)) for row in rows]
    cursor = conn.execute(sql, params or ())
    rows = cursor.fetchall()
    return [dict(row) for row in rows]


def init_subscription_db():
    backend, target = _get_backend()
    conn = _connect(backend, target)
    try:
        if backend == 'postgres':
            sql = """
            CREATE TABLE IF NOT EXISTS subscription_signups (
                id SERIAL PRIMARY KEY,
                paypal_subscription_id TEXT UNIQUE NOT NULL,
                paypal_plan_id TEXT,
                paypal_status TEXT,
                paypal_status_updated_at TEXT,
                paypal_start_time TEXT,
                user_sub TEXT,
                user_email TEXT,
                user_name TEXT,
                created_at TEXT,
                updated_at TEXT
            );
            """
        else:
            sql = """
            CREATE TABLE IF NOT EXISTS subscription_signups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paypal_subscription_id TEXT UNIQUE NOT NULL,
                paypal_plan_id TEXT,
                paypal_status TEXT,
                paypal_status_updated_at TEXT,
                paypal_start_time TEXT,
                user_sub TEXT,
                user_email TEXT,
                user_name TEXT,
                created_at TEXT,
                updated_at TEXT
            );
            """
        _execute(conn, backend, sql)

        if backend == 'postgres':
            sql = """
            CREATE TABLE IF NOT EXISTS subscription_plans (
                id SERIAL PRIMARY KEY,
                paypal_plan_id TEXT UNIQUE NOT NULL,
                paypal_product_id TEXT,
                plan_name TEXT,
                plan_description TEXT,
                plan_status TEXT,
                billing_interval_unit TEXT,
                billing_interval_count INTEGER,
                currency_code TEXT,
                price_value TEXT,
                created_by_email TEXT,
                raw_product_json TEXT,
                raw_plan_json TEXT,
                created_at TEXT,
                updated_at TEXT
            );
            """
        else:
            sql = """
            CREATE TABLE IF NOT EXISTS subscription_plans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paypal_plan_id TEXT UNIQUE NOT NULL,
                paypal_product_id TEXT,
                plan_name TEXT,
                plan_description TEXT,
                plan_status TEXT,
                billing_interval_unit TEXT,
                billing_interval_count INTEGER,
                currency_code TEXT,
                price_value TEXT,
                created_by_email TEXT,
                raw_product_json TEXT,
                raw_plan_json TEXT,
                created_at TEXT,
                updated_at TEXT
            );
            """
        _execute(conn, backend, sql)
    finally:
        conn.close()


def record_subscription_signup(user, subscription):
    backend, target = _get_backend()
    conn = _connect(backend, target)
    try:
        now = datetime.now(timezone.utc).isoformat()
        values = (
            subscription.get('id'),
            subscription.get('plan_id'),
            subscription.get('status'),
            subscription.get('status_update_time'),
            subscription.get('start_time'),
            user.get('sub'),
            user.get('email'),
            user.get('name'),
            now,
            now,
        )
        placeholder = '%s' if backend == 'postgres' else '?'
        placeholders = ', '.join([placeholder] * len(values))
        sql = f"""
        INSERT INTO subscription_signups (
            paypal_subscription_id,
            paypal_plan_id,
            paypal_status,
            paypal_status_updated_at,
            paypal_start_time,
            user_sub,
            user_email,
            user_name,
            created_at,
            updated_at
        )
        VALUES ({placeholders})
        ON CONFLICT (paypal_subscription_id)
        DO UPDATE SET
            paypal_plan_id = EXCLUDED.paypal_plan_id,
            paypal_status = EXCLUDED.paypal_status,
            paypal_status_updated_at = EXCLUDED.paypal_status_updated_at,
            paypal_start_time = EXCLUDED.paypal_start_time,
            user_sub = EXCLUDED.user_sub,
            user_email = EXCLUDED.user_email,
            user_name = EXCLUDED.user_name,
            updated_at = EXCLUDED.updated_at
        """
        _execute(conn, backend, sql, values)
    finally:
        conn.close()


def record_subscription_plan(user, product, plan, price, currency, interval_unit, interval_count):
    backend, target = _get_backend()
    conn = _connect(backend, target)
    try:
        now = datetime.now(timezone.utc).isoformat()
        raw_product = json.dumps(product, separators=(',', ':'), ensure_ascii=True)
        raw_plan = json.dumps(plan, separators=(',', ':'), ensure_ascii=True)
        values = (
            plan.get('id'),
            product.get('id'),
            plan.get('name'),
            plan.get('description'),
            plan.get('status'),
            interval_unit,
            interval_count,
            currency,
            price,
            user.get('email'),
            raw_product,
            raw_plan,
            now,
            now,
        )
        placeholder = '%s' if backend == 'postgres' else '?'
        placeholders = ', '.join([placeholder] * len(values))
        sql = f"""
        INSERT INTO subscription_plans (
            paypal_plan_id,
            paypal_product_id,
            plan_name,
            plan_description,
            plan_status,
            billing_interval_unit,
            billing_interval_count,
            currency_code,
            price_value,
            created_by_email,
            raw_product_json,
            raw_plan_json,
            created_at,
            updated_at
        )
        VALUES ({placeholders})
        ON CONFLICT (paypal_plan_id)
        DO UPDATE SET
            paypal_product_id = EXCLUDED.paypal_product_id,
            plan_name = EXCLUDED.plan_name,
            plan_description = EXCLUDED.plan_description,
            plan_status = EXCLUDED.plan_status,
            billing_interval_unit = EXCLUDED.billing_interval_unit,
            billing_interval_count = EXCLUDED.billing_interval_count,
            currency_code = EXCLUDED.currency_code,
            price_value = EXCLUDED.price_value,
            created_by_email = EXCLUDED.created_by_email,
            raw_product_json = EXCLUDED.raw_product_json,
            raw_plan_json = EXCLUDED.raw_plan_json,
            updated_at = EXCLUDED.updated_at
        """
        _execute(conn, backend, sql, values)
    finally:
        conn.close()


def list_subscription_plans():
    backend, target = _get_backend()
    conn = _connect(backend, target)
    try:
        sql = """
        SELECT
            paypal_plan_id,
            paypal_product_id,
            plan_name,
            plan_description,
            plan_status,
            billing_interval_unit,
            billing_interval_count,
            currency_code,
            price_value,
            created_by_email,
            created_at,
            updated_at
        FROM subscription_plans
        ORDER BY created_at DESC
        """
        return _query(conn, backend, sql)
    finally:
        conn.close()
