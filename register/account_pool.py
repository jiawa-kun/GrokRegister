# -*- coding: utf-8 -*-
"""号池账号表（gra_store.sqlite accounts）。

Node 经 gra_store_cli 读写；password/sso 按 Node 侧加密后的不透明字符串存盘。
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Optional

from gra_sqlite import dumps_json, loads_json, transaction


def _sso_hash(sso: str) -> str:
    t = str(sso or "").strip()
    if t.lower().startswith("sso="):
        t = t[4:].strip()
    if not t or len(t) < 8:
        return ""
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def _alive_from_check(sso_check: Any) -> Optional[int]:
    if not isinstance(sso_check, dict):
        return None
    v = sso_check.get("alive")
    if v is True:
        return 1
    if v is False:
        return 0
    return None


def _row_to_record(row: Any) -> dict[str, Any]:
    sc_raw = row["sso_check_json"] if "sso_check_json" in row.keys() else ""
    sso_check = None
    if sc_raw:
        try:
            parsed = json.loads(str(sc_raw))
            if isinstance(parsed, dict) and "alive" in parsed:
                sso_check = parsed
        except Exception:
            sso_check = None
    extra = loads_json(row["data_json"] if "data_json" in row.keys() else {})
    rec: dict[str, Any] = {
        "id": str(row["id"] or ""),
        "runId": str(row["run_id"] or ""),
        "email": str(row["email"] or ""),
        "password": str(row["password"] or ""),
        "sso": str(row["sso"] or ""),
        "createdAt": str(row["created_at"] or ""),
    }
    if sso_check is not None:
        rec["ssoCheck"] = sso_check
    # 透传额外字段（若有）
    for k, v in extra.items():
        if k not in rec:
            rec[k] = v
    return rec


def _record_to_params(rec: dict[str, Any]) -> tuple:
    rid = str(rec.get("id") or "").strip()
    email = str(rec.get("email") or "")
    password = str(rec.get("password") or "")
    sso = str(rec.get("sso") or "")
    created = str(rec.get("createdAt") or rec.get("created_at") or "")
    run_id = str(rec.get("runId") or rec.get("run_id") or "")
    sc = rec.get("ssoCheck") or rec.get("sso_check")
    sc_json = ""
    if isinstance(sc, dict):
        sc_json = json.dumps(sc, ensure_ascii=False, separators=(",", ":"))
    email_lc = email.strip().lower()
    h = _sso_hash(sso)
    has_sso = 1 if str(sso).strip() else 0
    alive = _alive_from_check(sc if isinstance(sc, dict) else None)
    # 仅存非核心扩展字段
    core = {
        "id",
        "runId",
        "run_id",
        "email",
        "password",
        "sso",
        "createdAt",
        "created_at",
        "ssoCheck",
        "sso_check",
        "hasPassword",
        "hasSso",
        "nsfwEnabled",
        "nsfwAttempted",
        "nsfwAt",
        "nsfwError",
        "nsfwStatus",
        "zdrClosed",
        "zdrAttempted",
        "zdrAt",
        "zdrError",
        "zdrStatus",
    }
    extra = {k: v for k, v in rec.items() if k not in core}
    return (
        rid,
        run_id,
        email,
        password,
        sso,
        created,
        sc_json,
        email_lc,
        h,
        has_sso,
        alive,
        dumps_json(extra),
    )


def count_accounts() -> int:
    with transaction(immediate=False) as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM accounts").fetchone()
        return int(row["n"] if row else 0)


def dump_all() -> list[dict[str, Any]]:
    with transaction(immediate=False) as conn:
        rows = conn.execute(
            "SELECT * FROM accounts ORDER BY created_at DESC, id DESC"
        ).fetchall()
    return [_row_to_record(r) for r in rows]


def get_by_id(account_id: str) -> Optional[dict[str, Any]]:
    aid = str(account_id or "").strip()
    if not aid:
        return None
    with transaction(immediate=False) as conn:
        row = conn.execute(
            "SELECT * FROM accounts WHERE id = ?", (aid,)
        ).fetchone()
    return _row_to_record(row) if row else None


def replace_all(records: list[dict[str, Any]]) -> int:
    """整表替换（JSON 迁移 / 全量写回）。"""
    items = [r for r in (records or []) if isinstance(r, dict) and str(r.get("id") or "").strip()]
    with transaction(immediate=True) as conn:
        conn.execute("DELETE FROM accounts")
        if items:
            conn.executemany(
                """
                INSERT INTO accounts(
                  id, run_id, email, password, sso, created_at,
                  sso_check_json, email_lc, sso_hash, has_sso, alive, data_json
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                [_record_to_params(r) for r in items],
            )
    return len(items)


def upsert_one(rec: dict[str, Any]) -> bool:
    if not isinstance(rec, dict):
        return False
    params = _record_to_params(rec)
    if not params[0]:
        return False
    with transaction(immediate=True) as conn:
        conn.execute(
            """
            INSERT INTO accounts(
              id, run_id, email, password, sso, created_at,
              sso_check_json, email_lc, sso_hash, has_sso, alive, data_json
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
              run_id=excluded.run_id,
              email=excluded.email,
              password=excluded.password,
              sso=excluded.sso,
              created_at=excluded.created_at,
              sso_check_json=excluded.sso_check_json,
              email_lc=excluded.email_lc,
              sso_hash=excluded.sso_hash,
              has_sso=excluded.has_sso,
              alive=excluded.alive,
              data_json=excluded.data_json
            """,
            params,
        )
    return True


def delete_ids(ids: list[str]) -> int:
    id_list = [str(x or "").strip() for x in (ids or []) if str(x or "").strip()]
    if not id_list:
        return 0
    deleted = 0
    with transaction(immediate=True) as conn:
        for aid in id_list:
            cur = conn.execute("DELETE FROM accounts WHERE id = ?", (aid,))
            deleted += int(cur.rowcount or 0)
    return deleted


def find_id_by_sso(sso: str) -> Optional[str]:
    h = _sso_hash(sso)
    if not h:
        return None
    with transaction(immediate=False) as conn:
        row = conn.execute(
            "SELECT id FROM accounts WHERE sso_hash = ? LIMIT 1", (h,)
        ).fetchone()
    return str(row["id"]) if row else None
