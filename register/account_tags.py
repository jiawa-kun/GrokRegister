# -*- coding: utf-8 -*-
"""账号侧车标签（NSFW / 推送等），跨进程 SQLite 持久化。

落盘: $DATA_DIR/gra_store.sqlite（account_tags 表）
兼容读旧 JSON: account_tags.json（启动时惰性迁移一次）
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from gra_sqlite import dumps_json, loads_json, now_ts, transaction

_MIGRATE_LOCK = threading.Lock()
_MIGRATED = False

_DEFAULT_DATA_DIR = "/data"


def _data_dir() -> Path:
    raw = (os.environ.get("DATA_DIR") or "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path(_DEFAULT_DATA_DIR)


def _json_path_candidates() -> list[Path]:
    out: list[Path] = []
    out.append(_data_dir() / "account_tags.json")
    reg = Path(__file__).resolve().parent
    out.append(reg / "data" / "account_tags.json")
    out.append(reg / "account_tags.json")
    seen: set[str] = set()
    uniq: list[Path] = []
    for p in out:
        try:
            k = str(p.resolve())
        except Exception:
            k = str(p)
        if k not in seen:
            seen.add(k)
            uniq.append(p)
    return uniq


def _primary_path() -> Path:
    return _data_dir() / "account_tags.json"


def primary_tags_path() -> str:
    return str(_primary_path())


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_sso(sso: str) -> str:
    s = str(sso or "").strip()
    if s.lower().startswith("sso="):
        s = s[4:].strip()
    return s


def sso_hash(sso: str) -> str:
    t = normalize_sso(sso)
    if not t or len(t) < 8:
        return ""
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def _merge_tag_maps(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    out = {
        "by_email": dict(base.get("by_email") or {}),
        "by_sso_hash": dict(base.get("by_sso_hash") or {}),
    }
    for k, v in (extra.get("by_email") or {}).items():
        if isinstance(v, dict):
            prev = dict(out["by_email"].get(k) or {})
            prev.update(v)
            out["by_email"][k] = prev
    for k, v in (extra.get("by_sso_hash") or {}).items():
        if isinstance(v, dict):
            prev = dict(out["by_sso_hash"].get(k) or {})
            prev.update(v)
            out["by_sso_hash"][k] = prev
    return out


def _ensure_migrated() -> None:
    global _MIGRATED
    if _MIGRATED:
        return
    with _MIGRATE_LOCK:
        if _MIGRATED:
            return
        try:
            with transaction() as conn:
                row = conn.execute("SELECT COUNT(*) AS c FROM account_tags").fetchone()
                count = int(row["c"] if row else 0)
                if count > 0:
                    _MIGRATED = True
                    return
                merged: dict[str, Any] = {"by_email": {}, "by_sso_hash": {}}
                for path in reversed(_json_path_candidates()):
                    try:
                        if not path.is_file():
                            continue
                        data = json.loads(path.read_text(encoding="utf-8"))
                        if isinstance(data, dict):
                            data.setdefault("by_email", {})
                            data.setdefault("by_sso_hash", {})
                            merged = _merge_tag_maps(merged, data)
                    except Exception:
                        continue
                ts = now_ts()
                for email, tag in (merged.get("by_email") or {}).items():
                    if not isinstance(tag, dict):
                        continue
                    conn.execute(
                        """
                        INSERT INTO account_tags(key_type, key_value, data_json, updated_at)
                        VALUES('email', ?, ?, ?)
                        ON CONFLICT(key_type, key_value) DO UPDATE SET
                          data_json=excluded.data_json,
                          updated_at=excluded.updated_at
                        """,
                        (str(email).strip().lower(), dumps_json(tag), ts),
                    )
                for h, tag in (merged.get("by_sso_hash") or {}).items():
                    if not isinstance(tag, dict):
                        continue
                    conn.execute(
                        """
                        INSERT INTO account_tags(key_type, key_value, data_json, updated_at)
                        VALUES('sso_hash', ?, ?, ?)
                        ON CONFLICT(key_type, key_value) DO UPDATE SET
                          data_json=excluded.data_json,
                          updated_at=excluded.updated_at
                        """,
                        (str(h).strip().lower(), dumps_json(tag), ts),
                    )
        except Exception:
            pass
        _MIGRATED = True


def _patch_keys(
    *,
    email: str = "",
    sso: str = "",
    patch: dict[str, Any],
) -> dict[str, Any]:
    _ensure_migrated()
    email_k = str(email or "").strip().lower()
    h = sso_hash(sso)
    if not email_k and not h:
        raise ValueError("tag write requires email or sso")
    written: dict[str, Any] = dict(patch)
    with transaction() as conn:
        ts = now_ts()
        if email_k:
            row = conn.execute(
                "SELECT data_json FROM account_tags WHERE key_type='email' AND key_value=?",
                (email_k,),
            ).fetchone()
            prev = loads_json(row["data_json"] if row else {})
            prev.update(patch)
            conn.execute(
                """
                INSERT INTO account_tags(key_type, key_value, data_json, updated_at)
                VALUES('email', ?, ?, ?)
                ON CONFLICT(key_type, key_value) DO UPDATE SET
                  data_json=excluded.data_json,
                  updated_at=excluded.updated_at
                """,
                (email_k, dumps_json(prev), ts),
            )
            written = prev
        if h:
            row = conn.execute(
                "SELECT data_json FROM account_tags WHERE key_type='sso_hash' AND key_value=?",
                (h,),
            ).fetchone()
            prev = loads_json(row["data_json"] if row else {})
            prev.update(patch)
            conn.execute(
                """
                INSERT INTO account_tags(key_type, key_value, data_json, updated_at)
                VALUES('sso_hash', ?, ?, ?)
                ON CONFLICT(key_type, key_value) DO UPDATE SET
                  data_json=excluded.data_json,
                  updated_at=excluded.updated_at
                """,
                (h, dumps_json(prev), ts),
            )
            if not email_k:
                written = prev
    written["_written_to"] = primary_tags_path()
    return written


def set_nsfw_tag(
    *,
    enabled: bool,
    email: str = "",
    sso: str = "",
    error: str = "",
    steps: Any = None,
) -> dict[str, Any]:
    tag = {
        "nsfw_enabled": bool(enabled),
        "nsfw_attempted": True,
        "nsfw_at": _now_iso(),
        "nsfw_error": (error or "")[:300] if not enabled else "",
    }
    if steps is not None:
        try:
            tag["nsfw_steps"] = steps
        except Exception:
            pass
    return _patch_keys(email=email, sso=sso, patch=tag)


def get_tag(*, email: str = "", sso: str = "") -> dict[str, Any]:
    _ensure_migrated()
    email_k = str(email or "").strip().lower()
    with transaction(immediate=False) as conn:
        if email_k:
            row = conn.execute(
                "SELECT data_json FROM account_tags WHERE key_type='email' AND key_value=?",
                (email_k,),
            ).fetchone()
            if row:
                return loads_json(row["data_json"])
        h = sso_hash(sso)
        if h:
            row = conn.execute(
                "SELECT data_json FROM account_tags WHERE key_type='sso_hash' AND key_value=?",
                (h,),
            ).fetchone()
            if row:
                return loads_json(row["data_json"])
    return {}


def dump_all() -> dict[str, Any]:
    _ensure_migrated()
    out: dict[str, Any] = {"by_email": {}, "by_sso_hash": {}}
    with transaction(immediate=False) as conn:
        for row in conn.execute(
            "SELECT key_type, key_value, data_json FROM account_tags"
        ):
            tag = loads_json(row["data_json"])
            if row["key_type"] == "email":
                out["by_email"][row["key_value"]] = tag
            elif row["key_type"] == "sso_hash":
                out["by_sso_hash"][row["key_value"]] = tag
    return out


NSFW_AUTH_KEYS = (
    "nsfw_enabled",
    "nsfw_attempted",
    "nsfw_at",
    "nsfw_error",
    "nsfw_steps",
)


def preserve_nsfw_fields(
    new_doc: dict[str, Any],
    old_doc: dict[str, Any] | None,
) -> dict[str, Any]:
    if not isinstance(new_doc, dict):
        return new_doc
    if new_doc.get("nsfw_attempted") is True:
        return new_doc
    if not isinstance(old_doc, dict):
        return new_doc
    if old_doc.get("nsfw_attempted") is not True:
        return new_doc
    for k in NSFW_AUTH_KEYS:
        if k in old_doc:
            new_doc[k] = old_doc[k]
    return new_doc


def patch_auth_file_nsfw(path: str | Path, *, enabled: bool, error: str = "") -> bool:
    p = Path(path)
    if not p.is_file():
        return False
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            return False
        doc["nsfw_enabled"] = bool(enabled)
        doc["nsfw_attempted"] = True
        doc["nsfw_at"] = _now_iso()
        if not enabled and error:
            doc["nsfw_error"] = str(error)[:300]
        elif enabled:
            doc.pop("nsfw_error", None)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(p)
        return True
    except Exception:
        return False


def set_zdr_tag(
    *,
    closed: bool,
    email: str = "",
    sso: str = "",
    error: str = "",
    steps: Any = None,
) -> dict[str, Any]:
    tag = {
        "zdr_closed": bool(closed),
        "zdr_attempted": True,
        "zdr_at": _now_iso(),
        "zdr_error": (error or "")[:300] if not closed else "",
    }
    if steps is not None:
        try:
            tag["zdr_steps"] = steps
        except Exception:
            pass
    try:
        return _patch_keys(email=email, sso=sso, patch=tag)
    except ValueError:
        return tag


def patch_auth_file_zdr(path: str | Path, *, closed: bool, error: str = "") -> bool:
    p = Path(path)
    if not p.is_file():
        return False
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            return False
        doc["zdr_closed"] = bool(closed)
        doc["zdr_attempted"] = True
        doc["zdr_at"] = _now_iso()
        if not closed and error:
            doc["zdr_error"] = str(error)[:300]
        elif closed:
            doc.pop("zdr_error", None)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(p)
        return True
    except Exception:
        return False


PUSH_CHANNELS = ("sso_g2", "auth_cpa", "auth_sub2api")


def _push_ok_key(channel: str) -> str:
    return f"push_{channel}_ok"


def _push_at_key(channel: str) -> str:
    return f"push_{channel}_at"


def _push_attempted_key(channel: str) -> str:
    return f"push_{channel}_attempted"


def _push_error_key(channel: str) -> str:
    return f"push_{channel}_error"


def _normalize_push_channel(channel: str) -> str:
    c = str(channel or "").strip().lower()
    aliases = {
        "sso_g2": "sso_g2",
        "sso-g2": "sso_g2",
        "grok2api": "sso_g2",
        "g2": "sso_g2",
        "auth_cpa": "auth_cpa",
        "cpa": "auth_cpa",
        "auth-cpa": "auth_cpa",
        "auth_sub2api": "auth_sub2api",
        "sub2api": "auth_sub2api",
        "auth-sub2api": "auth_sub2api",
        "s2a": "auth_sub2api",
    }
    return aliases.get(c, c)


def is_push_ok(*, channel: str, email: str = "", sso: str = "") -> bool:
    ch = _normalize_push_channel(channel)
    if not ch:
        return False
    tag = get_tag(email=email, sso=sso)
    return tag.get(_push_ok_key(ch)) is True


def set_push_tag(
    *,
    channel: str,
    ok: bool,
    email: str = "",
    sso: str = "",
    error: str = "",
    detail: Any = None,
) -> dict[str, Any]:
    ch = _normalize_push_channel(channel)
    if not ch:
        raise ValueError("set_push_tag requires channel")
    tag = {
        _push_ok_key(ch): bool(ok),
        _push_attempted_key(ch): True,
        _push_at_key(ch): _now_iso(),
        _push_error_key(ch): (error or "")[:300] if not ok else "",
    }
    if detail is not None:
        try:
            tag[f"push_{ch}_detail"] = detail
        except Exception:
            pass
    written = _patch_keys(email=email, sso=sso, patch=tag)
    written["channel"] = ch
    return written


def patch_auth_file_push(
    path: str | Path,
    *,
    channel: str,
    ok: bool,
    error: str = "",
) -> bool:
    ch = _normalize_push_channel(channel)
    p = Path(path)
    if not p.is_file() or not ch:
        return False
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            return False
        doc[_push_ok_key(ch)] = bool(ok)
        doc[_push_attempted_key(ch)] = True
        doc[_push_at_key(ch)] = _now_iso()
        if not ok and error:
            doc[_push_error_key(ch)] = str(error)[:300]
        elif ok:
            doc.pop(_push_error_key(ch), None)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(p)
        return True
    except Exception:
        return False


def clear_push_tag(*, channel: str, email: str = "", sso: str = "") -> bool:
    ch = _normalize_push_channel(channel)
    keys = [
        _push_ok_key(ch),
        _push_attempted_key(ch),
        _push_at_key(ch),
        _push_error_key(ch),
        f"push_{ch}_detail",
    ]
    _ensure_migrated()
    email_k = str(email or "").strip().lower()
    h = sso_hash(sso)
    changed = False
    with transaction() as conn:
        ts = now_ts()
        for key_type, key_value in (("email", email_k), ("sso_hash", h)):
            if not key_value:
                continue
            row = conn.execute(
                "SELECT data_json FROM account_tags WHERE key_type=? AND key_value=?",
                (key_type, key_value),
            ).fetchone()
            if not row:
                continue
            prev = loads_json(row["data_json"])
            for k in keys:
                if k in prev:
                    prev.pop(k, None)
                    changed = True
            conn.execute(
                """
                UPDATE account_tags SET data_json=?, updated_at=?
                WHERE key_type=? AND key_value=?
                """,
                (dumps_json(prev), ts, key_type, key_value),
            )
    return changed
