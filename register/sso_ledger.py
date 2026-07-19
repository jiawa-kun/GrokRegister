# -*- coding: utf-8 -*-
"""
W3 · SSO 指纹账本：跨进程 SQLite 原子去重。

表: sso_ledger（$DATA_DIR/gra_store.sqlite）
兼容迁移: register/data/sso_identities.json
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from gra_sqlite import dumps_json, loads_json, transaction

_ROOT = Path(__file__).resolve().parent
_DEFAULT_PATH = _ROOT / "data" / "sso_identities.json"
_MIGRATE_LOCK = threading.Lock()
_MIGRATED = False


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sso_fingerprint(sso: str) -> str:
    t = str(sso or "").strip()
    if t.lower().startswith("sso="):
        t = t[4:].strip()
    if not t or len(t) < 8:
        return ""
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def ledger_path() -> Path:
    env = os.environ.get("SSO_LEDGER_PATH", "").strip()
    if env:
        return Path(env)
    data = (os.environ.get("DATA_DIR") or "").strip()
    if data:
        return Path(data) / "sso_identities.json"
    return _DEFAULT_PATH


def _ensure_migrated(path: Optional[Path] = None) -> None:
    global _MIGRATED
    if _MIGRATED:
        return
    with _MIGRATE_LOCK:
        if _MIGRATED:
            return
        try:
            with transaction() as conn:
                row = conn.execute("SELECT COUNT(*) AS c FROM sso_ledger").fetchone()
                if int(row["c"] if row else 0) > 0:
                    _MIGRATED = True
                    return
                p = path or ledger_path()
                if not p.is_file():
                    _MIGRATED = True
                    return
                try:
                    raw = json.loads(p.read_text(encoding="utf-8"))
                except Exception:
                    _MIGRATED = True
                    return
                bh = raw.get("by_hash") if isinstance(raw, dict) else {}
                if not isinstance(bh, dict):
                    _MIGRATED = True
                    return
                for fp, entry in bh.items():
                    if not isinstance(entry, dict):
                        continue
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO sso_ledger(
                          fingerprint, email, first_seen, last_seen, count, data_json
                        ) VALUES(?, ?, ?, ?, ?, ?)
                        """,
                        (
                            str(fp),
                            str(entry.get("email") or ""),
                            str(entry.get("first_seen") or ""),
                            str(entry.get("last_seen") or ""),
                            int(entry.get("count") or 1),
                            dumps_json(entry),
                        ),
                    )
        except Exception:
            pass
        _MIGRATED = True


def is_duplicate(sso: str, path: Optional[Path] = None) -> bool:
    fp = sso_fingerprint(sso)
    if not fp:
        return False
    _ensure_migrated(path)
    with transaction(immediate=False) as conn:
        row = conn.execute(
            "SELECT 1 FROM sso_ledger WHERE fingerprint=?", (fp,)
        ).fetchone()
        return row is not None


def register_sso(
    sso: str,
    *,
    email: str = "",
    path: Optional[Path] = None,
    allow_duplicate: bool = False,
) -> dict[str, Any]:
    """
    登记 SSO 指纹。

    返回:
      { ok, duplicate, fingerprint, email, count }
    若 duplicate 且 not allow_duplicate：ok=False。
    """
    fp = sso_fingerprint(sso)
    if not fp:
        return {"ok": False, "duplicate": False, "error": "empty sso", "fingerprint": ""}

    _ensure_migrated(path)
    email_n = str(email or "").strip().lower()
    now = _now_iso()

    with transaction() as conn:
        row = conn.execute(
            "SELECT email, first_seen, last_seen, count, data_json FROM sso_ledger WHERE fingerprint=?",
            (fp,),
        ).fetchone()
        if row and not allow_duplicate:
            count = int(row["count"] or 1) + 1
            email_keep = str(row["email"] or email_n)
            if email_n and not row["email"]:
                email_keep = email_n
            prev = loads_json(row["data_json"])
            prev.update(
                {
                    "email": email_keep,
                    "first_seen": row["first_seen"] or now,
                    "last_seen": now,
                    "count": count,
                }
            )
            conn.execute(
                """
                UPDATE sso_ledger
                SET email=?, last_seen=?, count=?, data_json=?
                WHERE fingerprint=?
                """,
                (email_keep, now, count, dumps_json(prev), fp),
            )
            return {
                "ok": False,
                "duplicate": True,
                "fingerprint": fp,
                "email": email_keep,
                "count": count,
                "first_seen": row["first_seen"] or now,
            }

        if row:
            count = int(row["count"] or 1) + 1
            email_keep = email_n or str(row["email"] or "")
            first = str(row["first_seen"] or now)
            entry = {
                "email": email_keep,
                "first_seen": first,
                "last_seen": now,
                "count": count,
            }
            conn.execute(
                """
                UPDATE sso_ledger
                SET email=?, last_seen=?, count=?, data_json=?
                WHERE fingerprint=?
                """,
                (email_keep, now, count, dumps_json(entry), fp),
            )
            return {
                "ok": True,
                "duplicate": True,
                "fingerprint": fp,
                "email": email_keep,
                "count": count,
                "first_seen": first,
            }

        entry = {
            "email": email_n,
            "first_seen": now,
            "last_seen": now,
            "count": 1,
        }
        conn.execute(
            """
            INSERT INTO sso_ledger(fingerprint, email, first_seen, last_seen, count, data_json)
            VALUES(?, ?, ?, ?, 1, ?)
            """,
            (fp, email_n, now, now, dumps_json(entry)),
        )
        return {
            "ok": True,
            "duplicate": False,
            "fingerprint": fp,
            "email": email_n,
            "count": 1,
            "first_seen": now,
        }


def claim_sso(
    sso: str,
    *,
    email: str = "",
    path: Optional[Path] = None,
) -> dict[str, Any]:
    """原子：若未见过则登记并 ok=True；若已见过则 duplicate=True, ok=False。"""
    return register_sso(sso, email=email, path=path, allow_duplicate=False)
