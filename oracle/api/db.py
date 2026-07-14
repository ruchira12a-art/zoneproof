"""
Database connection for Oracle API — reuses oracle/scrapers config.
"""
import psycopg2
import psycopg2.extras
from oracle.scrapers.config import DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME


def get_conn():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT,
        user=DB_USER, password=DB_PASSWORD,
        dbname=DB_NAME, sslmode="require",
        connect_timeout=10,
    )
    conn.autocommit = True
    return conn


def query(sql: str, params=None) -> list:
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()
