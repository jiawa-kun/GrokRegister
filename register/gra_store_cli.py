# -*- coding: utf-8 -*-
"""Node ↔ Python 侧车 CLI：读写 gra_store（stdout 仅 JSON）。

用法:
  python gra_store_cli.py dump_tags
  python gra_store_cli.py set_push_tag   # stdin JSON
  python gra_store_cli.py get_tag        # stdin JSON
"""
from __future__ import annotations

import json
import sys


def _out(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def main() -> int:
    cmd = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    try:
        body = json.loads(raw) if raw.strip() else {}
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    try:
        if cmd == "dump_tags":
            from account_tags import dump_all

            _out({"ok": True, "data": dump_all()})
            return 0
        if cmd == "get_tag":
            from account_tags import get_tag

            tag = get_tag(email=str(body.get("email") or ""), sso=str(body.get("sso") or ""))
            _out({"ok": True, "data": tag})
            return 0
        if cmd == "set_push_tag":
            from account_tags import set_push_tag

            tag = set_push_tag(
                channel=str(body.get("channel") or ""),
                ok=bool(body.get("ok")),
                email=str(body.get("email") or ""),
                sso=str(body.get("sso") or ""),
                error=str(body.get("error") or ""),
            )
            _out({"ok": True, "data": tag})
            return 0
        if cmd == "count_accounts":
            from account_pool import count_accounts

            _out({"ok": True, "data": {"count": count_accounts()}})
            return 0
        if cmd == "dump_accounts":
            from account_pool import dump_all

            _out({"ok": True, "data": dump_all()})
            return 0
        if cmd == "get_account":
            from account_pool import get_by_id

            rec = get_by_id(str(body.get("id") or ""))
            _out({"ok": True, "data": rec})
            return 0
        if cmd == "replace_accounts":
            from account_pool import replace_all

            raw_items = body.get("items") or body.get("accounts") or []
            if not isinstance(raw_items, list):
                raw_items = []
            n = replace_all([x for x in raw_items if isinstance(x, dict)])
            _out({"ok": True, "data": {"count": n}})
            return 0
        if cmd == "upsert_account":
            from account_pool import upsert_one

            rec = body.get("account") or body.get("record") or body
            ok = upsert_one(rec if isinstance(rec, dict) else {})
            _out({"ok": bool(ok), "data": {"ok": bool(ok)}})
            return 0 if ok else 1
        if cmd == "upsert_accounts":
            from account_pool import upsert_many

            raw_items = body.get("items") or body.get("accounts") or []
            if not isinstance(raw_items, list):
                raw_items = []
            n = upsert_many([x for x in raw_items if isinstance(x, dict)])
            _out({"ok": True, "data": {"count": n}})
            return 0
        if cmd == "delete_accounts":
            from account_pool import delete_ids

            ids = body.get("ids") or []
            if not isinstance(ids, list):
                ids = []
            n = delete_ids([str(x) for x in ids])
            _out({"ok": True, "data": {"deleted": n}})
            return 0
        if cmd == "find_account_by_sso":
            from account_pool import find_id_by_sso

            aid = find_id_by_sso(str(body.get("sso") or ""))
            _out({"ok": True, "data": {"id": aid}})
            return 0
        if cmd == "query_accounts":
            from account_pool import query_page

            data = query_page(
                page=int(body.get("page") or 1),
                page_size=int(body.get("pageSize") or body.get("page_size") or 20),
                q=str(body.get("q") or ""),
                sso=str(body.get("sso") or "all"),
                alive=str(body.get("alive") or "all"),
                auth=str(body.get("auth") or "all"),
                auth_emails=body.get("authEmails") or body.get("auth_emails") or [],
                auth_hashes=body.get("authHashes") or body.get("auth_hashes") or [],
            )
            _out({"ok": True, "data": data})
            return 0
        if cmd == "match_accounts":
            from account_pool import query_match

            data = query_match(
                q=str(body.get("q") or ""),
                sso=str(body.get("sso") or "all"),
                alive=str(body.get("alive") or "all"),
                auth=str(body.get("auth") or "all"),
                limit=int(body.get("limit") or 500),
                require_sso=bool(body.get("requireSso") or body.get("require_sso")),
                auth_emails=body.get("authEmails") or body.get("auth_emails") or [],
                auth_hashes=body.get("authHashes") or body.get("auth_hashes") or [],
            )
            _out({"ok": True, "data": data})
            return 0
        _out({"ok": False, "error": f"unknown cmd: {cmd}"})
        return 2
    except Exception as e:
        _out({"ok": False, "error": str(e)[:500]})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
