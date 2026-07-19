# -*- coding: utf-8 -*-
"""跨进程共享 SQLite 存储（WAL + busy_timeout + 事务）。

路径: $DATA_DIR/gra_store.sqlite（默认 /data/gra_store.sqlite）
供 account_tags / sso_ledger / delivery_store 共用，避免 JSON 覆盖写丢数据。
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

_DEFAULT_DATA_DIR = "/data"
_LOCK = threading.RLock()
_CONN: Optional[sqlite3.Connection] = None
_DB_PATH: Optional[Path] = None


def data_dir() -> Path:
    raw = (os.environ.get("DATA_DIR") or "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path(_DEFAULT_DATA_DIR)


def db_path() -> Path:
    env = (os.environ.get("GRA_SQLITE_PATH") or "").strip()
    if env:
        return Path(env).expanduser()
    return data_dir() / "gra_store.sqlite"


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        str(path),
        timeout=30.0,
        check_same_thread=False,
        isolation_level=None,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    _init_schema(conn)
    return conn


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS account_tags (
          key_type TEXT NOT NULL,
          key_value TEXT NOT NULL,
          data_json TEXT NOT NULL DEFAULT '{}',
          updated_at REAL NOT NULL,
          PRIMARY KEY (key_type, key_value)
        );

        CREATE TABLE IF NOT EXISTS sso_ledger (
          fingerprint TEXT PRIMARY KEY,
          email TEXT NOT NULL DEFAULT '',
          first_seen TEXT NOT NULL DEFAULT '',
          last_seen TEXT NOT NULL DEFAULT '',
          count INTEGER NOT NULL DEFAULT 1,
          data_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS delivery_jobs (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          sso_fp TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 5,
          error TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT '',
          next_retry_at REAL NOT NULL DEFAULT 0,
          lease_owner TEXT NOT NULL DEFAULT '',
          lease_until REAL NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_delivery_status
          ON delivery_jobs(status, next_retry_at);
        """
    )


def get_conn() -> sqlite3.Connection:
    global _CONN, _DB_PATH
    with _LOCK:
        path = db_path()
        if _CONN is not None and _DB_PATH == path:
            return _CONN
        if _CONN is not None:
            try:
                _CONN.close()
            except Exception:
                pass
        _CONN = _connect(path)
        _DB_PATH = path
        return _CONN


@contextmanager
def transaction(immediate: bool = True) -> Iterator[sqlite3.Connection]:
    """跨进程安全事务：BEGIN IMMEDIATE 拿写锁。"""
    conn = get_conn()
    with _LOCK:
        started = False
        try:
            conn.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            started = True
            yield conn
            conn.execute("COMMIT")
        except Exception:
            if started:
                try:
                    conn.execute("ROLLBACK")
                except Exception:
                    pass
            raise


def dumps_json(obj: Any) -> str:
    return json.dumps(obj if obj is not None else {}, ensure_ascii=False)


def loads_json(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        data = json.loads(str(raw))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def now_ts() -> float:
    return time.time()
