# -*- coding: utf-8 -*-
"""长驻 stdin NDJSON worker：一行请求 → 一行 JSON 响应，减少 Node spawn 冷启动。

协议：
  stdin:  {"id":1,"cmd":"count_accounts","body":{...}}\n
  stdout: {"id":1,"ok":true,"data":...}\n
  cmd=quit 退出
"""
from __future__ import annotations

import json
import sys
import traceback


def _handle(cmd: str, body: dict):
    if not isinstance(body, dict):
        body = {}
    if cmd == "ping":
        return {"ok": True, "data": {"pong": True}}
    if cmd == "quit":
        return {"ok": True, "data": {"bye": True}, "_quit": True}

    # 复用 CLI 同一套命令
    if cmd == "dump_tags":
        from account_tags import dump_all

        return {"ok": True, "data": dump_all()}
    if cmd == "get_tag":
        from account_tags import get_tag

        tag = get_tag(email=str(body.get("email") or ""), sso=str(body.get("sso") or ""))
        return {"ok": True, "data": tag}
    if cmd == "set_push_tag":
        from account_tags import set_push_tag

        tag = set_push_tag(
            channel=str(body.get("channel") or ""),
            ok=bool(body.get("ok")),
            email=str(body.get("email") or ""),
            sso=str(body.get("sso") or ""),
            error=str(body.get("error") or ""),
        )
        return {"ok": True, "data": tag}
    if cmd == "count_accounts":
        from account_pool import count_accounts

        return {"ok": True, "data": {"count": count_accounts()}}
    if cmd == "dump_accounts":
        from account_pool import dump_all

        return {"ok": True, "data": dump_all()}
    if cmd == "get_account":
        from account_pool import get_by_id

        return {"ok": True, "data": get_by_id(str(body.get("id") or ""))}
    if cmd == "replace_accounts":
        from account_pool import replace_all

        raw_items = body.get("items") or body.get("accounts") or []
        if not isinstance(raw_items, list):
            raw_items = []
        n = replace_all([x for x in raw_items if isinstance(x, dict)])
        return {"ok": True, "data": {"count": n}}
    if cmd == "upsert_account":
        from account_pool import upsert_one

        rec = body.get("account") or body.get("record") or body
        ok = upsert_one(rec if isinstance(rec, dict) else {})
        return {"ok": bool(ok), "data": {"ok": bool(ok)}}
    if cmd == "upsert_accounts":
        from account_pool import upsert_many

        raw_items = body.get("items") or body.get("accounts") or []
        if not isinstance(raw_items, list):
            raw_items = []
        n = upsert_many([x for x in raw_items if isinstance(x, dict)])
        return {"ok": True, "data": {"count": n}}
    if cmd == "delete_accounts":
        from account_pool import delete_ids

        ids = body.get("ids") or []
        if not isinstance(ids, list):
            ids = []
        n = delete_ids([str(x) for x in ids])
        return {"ok": True, "data": {"deleted": n}}
    if cmd == "find_account_by_sso":
        from account_pool import find_id_by_sso

        aid = find_id_by_sso(str(body.get("sso") or ""))
        return {"ok": True, "data": {"id": aid}}
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
        return {"ok": True, "data": data}
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
        return {"ok": True, "data": data}
    return {"ok": False, "error": f"unknown cmd: {cmd}"}


def main() -> int:
    # 预热 SQLite 连接
    try:
        from gra_sqlite import get_conn

        get_conn()
    except Exception:
        pass

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            cmd = str(req.get("cmd") or "").strip()
            body = req.get("body") if isinstance(req.get("body"), dict) else {}
            result = _handle(cmd, body)
            quit_flag = bool(result.pop("_quit", False))
            out = {"id": req_id, **result}
            sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            if quit_flag:
                return 0
        except Exception as e:
            err = {"id": req_id, "ok": False, "error": str(e)[:500]}
            try:
                err["trace"] = traceback.format_exc()[-400:]
            except Exception:
                pass
            sys.stdout.write(json.dumps(err, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
