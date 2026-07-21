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
    """Map ssoCheck → SQLite alive column.

    1 = alive, 0 = dead(401/403 only), 2 = unknown, None = unchecked.
    Legacy rows with alive=false but non-401/403 status reclassified as unknown(2).
    """
    if not isinstance(sso_check, dict):
        return None
    if "alive" not in sso_check and not sso_check.get("checkedAt"):
        return None
    v = sso_check.get("alive")
    try:
        status = int(sso_check.get("status") or 0)
    except Exception:
        status = 0
    if v is True:
        return 1
    if v is False:
        if status in (401, 403):
            return 0
        # 历史网络/超时假死 → 未知
        return 2
    if v is None:
        return 2
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


_UPSERT_SQL = """
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
"""


def upsert_one(rec: dict[str, Any]) -> bool:
    if not isinstance(rec, dict):
        return False
    params = _record_to_params(rec)
    if not params[0]:
        return False
    with transaction(immediate=True) as conn:
        conn.execute(_UPSERT_SQL, params)
    return True


def upsert_many(records: list[dict[str, Any]]) -> int:
    """批量 upsert（一次事务，供 Node 单次 spawn）。"""
    items = [
        _record_to_params(r)
        for r in (records or [])
        if isinstance(r, dict) and str(r.get("id") or "").strip()
    ]
    if not items:
        return 0
    with transaction(immediate=True) as conn:
        conn.executemany(_UPSERT_SQL, items)
    return len(items)


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


def _chunked(seq: list[str], size: int = 400) -> list[list[str]]:
    return [seq[i : i + size] for i in range(0, len(seq), size)] or [[]]


def _build_where(
    *,
    q: str = "",
    sso: str = "all",
    alive: str = "all",
    auth: str = "all",
    require_sso: bool = False,
    auth_emails: Optional[list[str]] = None,
    auth_hashes: Optional[list[str]] = None,
) -> tuple[str, list[Any]]:
    """构造 WHERE；auth 筛选用 email_lc / sso_hash IN 列表。"""
    clauses: list[str] = []
    params: list[Any] = []

    sso_mode = str(sso or "all").strip().lower()
    if sso_mode == "has_sso" or require_sso:
        clauses.append("has_sso = 1")
    elif sso_mode == "no_sso":
        clauses.append("has_sso = 0")

    alive_mode = str(alive or "all").strip().lower()
    if alive_mode == "unchecked":
        clauses.append("alive IS NULL")
    elif alive_mode == "alive":
        clauses.append("alive = 1")
    elif alive_mode == "dead":
        # 仅明确 401/403；兼容旧库 alive=0 但 status 非 401/403
        clauses.append(
            "("
            "alive = 0 AND ("
            "CAST(json_extract(sso_check_json, '$.status') AS INTEGER) IN (401, 403)"
            ")"
            ")"
        )
    elif alive_mode == "unknown":
        clauses.append(
            "("
            "alive = 2 OR ("
            "alive = 0 AND ("
            "json_extract(sso_check_json, '$.status') IS NULL OR "
            "CAST(json_extract(sso_check_json, '$.status') AS INTEGER) NOT IN (401, 403)"
            ")"
            ")"
            ")"
        )

    auth_mode = str(auth or "all").strip().lower()
    emails = [str(e).strip().lower() for e in (auth_emails or []) if str(e).strip()]
    hashes = [str(h).strip().lower() for h in (auth_hashes or []) if str(h).strip()]
    if auth_mode in ("converted", "unconverted") and (emails or hashes):
        # (email_lc IN (...) OR sso_hash IN (...))
        parts: list[str] = []
        for chunk in _chunked(emails, 400):
            if not chunk:
                continue
            ph = ",".join("?" * len(chunk))
            parts.append(f"email_lc IN ({ph})")
            params.extend(chunk)
        for chunk in _chunked(hashes, 400):
            if not chunk:
                continue
            ph = ",".join("?" * len(chunk))
            parts.append(f"sso_hash IN ({ph})")
            params.extend(chunk)
        if parts:
            expr = "(" + " OR ".join(parts) + ")"
            if auth_mode == "converted":
                clauses.append(expr)
            else:
                clauses.append(f"NOT {expr}")
        elif auth_mode == "converted":
            # 无 Auth 索引时视为无人已转
            clauses.append("0 = 1")
        # unconverted + 空索引：全部未转，不加条件

    qq = str(q or "").strip().lower()
    if qq:
        # email / id；长查询再扫 sso 列（加密后可能匹配不到明文 JWT，与 Node 行为一致）
        if len(qq) >= 12:
            clauses.append("(email_lc LIKE ? OR id LIKE ? OR lower(sso) LIKE ?)")
            like = f"%{qq}%"
            params.extend([like, f"%{qq}%", like])
        else:
            clauses.append("(email_lc LIKE ? OR id LIKE ?)")
            like = f"%{qq}%"
            params.extend([like, f"%{qq}%"])

    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


def query_page(
    *,
    page: int = 1,
    page_size: int = 20,
    q: str = "",
    sso: str = "all",
    alive: str = "all",
    auth: str = "all",
    auth_emails: Optional[list[str]] = None,
    auth_hashes: Optional[list[str]] = None,
) -> dict[str, Any]:
    """SQL 筛选 + 分页 + 全局 facets（含 auth 交叉）。"""
    page_size = max(1, min(2000, int(page_size or 20)))
    page = max(1, int(page or 1))
    where, params = _build_where(
        q=q,
        sso=sso,
        alive=alive,
        auth=auth,
        auth_emails=auth_emails,
        auth_hashes=auth_hashes,
    )

    with transaction(immediate=False) as conn:
        # facets：全库（不受 q/sso/alive/auth 筛选）
        fac = conn.execute(
            """
            SELECT
              COUNT(*) AS all_n,
              COALESCE(SUM(has_sso), 0) AS has_sso,
              COALESCE(SUM(CASE WHEN alive IS NULL THEN 1 ELSE 0 END), 0) AS unchecked,
              COALESCE(SUM(CASE WHEN alive = 1 THEN 1 ELSE 0 END), 0) AS alive_n,
              COALESCE(SUM(CASE
                WHEN alive = 0 AND CAST(json_extract(sso_check_json, '$.status') AS INTEGER) IN (401, 403)
                THEN 1 ELSE 0 END), 0) AS dead_n,
              COALESCE(SUM(CASE
                WHEN alive = 2 THEN 1
                WHEN alive = 0 AND (
                  json_extract(sso_check_json, '$.status') IS NULL
                  OR CAST(json_extract(sso_check_json, '$.status') AS INTEGER) NOT IN (401, 403)
                ) THEN 1
                ELSE 0 END), 0) AS unknown_n
            FROM accounts
            """
        ).fetchone()
        all_n = int(fac["all_n"] or 0)
        has_sso_n = int(fac["has_sso"] or 0)
        unchecked = int(fac["unchecked"] or 0)
        alive_n = int(fac["alive_n"] or 0)
        dead_n = int(fac["dead_n"] or 0)
        unknown_n = int(fac["unknown_n"] or 0)

        emails = [str(e).strip().lower() for e in (auth_emails or []) if str(e).strip()]
        hashes = [str(h).strip().lower() for h in (auth_hashes or []) if str(h).strip()]
        auth_converted = 0
        if emails or hashes:
            # 已转 = email 或 sso_hash 命中
            parts: list[str] = []
            ap: list[Any] = []
            for chunk in _chunked(emails, 400):
                if not chunk:
                    continue
                ph = ",".join("?" * len(chunk))
                parts.append(f"email_lc IN ({ph})")
                ap.extend(chunk)
            for chunk in _chunked(hashes, 400):
                if not chunk:
                    continue
                ph = ",".join("?" * len(chunk))
                parts.append(f"sso_hash IN ({ph})")
                ap.extend(chunk)
            if parts:
                sql = f"SELECT COUNT(*) AS n FROM accounts WHERE ({' OR '.join(parts)})"
                row = conn.execute(sql, ap).fetchone()
                auth_converted = int(row["n"] or 0)

        total_row = conn.execute(
            f"SELECT COUNT(*) AS n FROM accounts{where}", params
        ).fetchone()
        total = int(total_row["n"] or 0)
        total_pages = max(1, (total + page_size - 1) // page_size if page_size else 1)
        page = min(page, total_pages)
        offset = (page - 1) * page_size
        rows = conn.execute(
            f"""
            SELECT * FROM accounts
            {where}
            ORDER BY created_at DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            [*params, page_size, offset],
        ).fetchall()

    items = [_row_to_record(r) for r in rows]
    return {
        "items": items,
        "total": total,
        "page": page,
        "pageSize": page_size,
        "totalPages": total_pages,
        "facets": {
            "all": all_n,
            "hasSso": has_sso_n,
            "noSso": max(0, all_n - has_sso_n),
            "unchecked": unchecked,
            "alive": alive_n,
            "dead": dead_n,
            "unknown": unknown_n,
            "authConverted": auth_converted,
            "authUnconverted": max(0, all_n - auth_converted),
        },
    }


def query_match(
    *,
    q: str = "",
    sso: str = "all",
    alive: str = "all",
    auth: str = "all",
    limit: int = 500,
    require_sso: bool = False,
    auth_emails: Optional[list[str]] = None,
    auth_hashes: Optional[list[str]] = None,
) -> dict[str, Any]:
    """SQL 筛选后截断返回（批量验活/导出）。"""
    limit = max(1, min(2000, int(limit or 500)))
    where, params = _build_where(
        q=q,
        sso=sso,
        alive=alive,
        auth=auth,
        require_sso=require_sso,
        auth_emails=auth_emails,
        auth_hashes=auth_hashes,
    )
    with transaction(immediate=False) as conn:
        total_row = conn.execute(
            f"SELECT COUNT(*) AS n FROM accounts{where}", params
        ).fetchone()
        total = int(total_row["n"] or 0)
        rows = conn.execute(
            f"""
            SELECT * FROM accounts
            {where}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            [*params, limit],
        ).fetchall()
    items = [
        {
            "id": rec["id"],
            "email": rec["email"],
            "password": rec["password"],
            "sso": rec["sso"],
            "createdAt": rec["createdAt"],
        }
        for rec in (_row_to_record(r) for r in rows)
    ]
    return {
        "items": items,
        "total": total,
        "returned": len(items),
        "truncated": total > len(items),
        "limit": limit,
    }
