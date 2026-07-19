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
        _out({"ok": False, "error": f"unknown cmd: {cmd}"})
        return 2
    except Exception as e:
        _out({"ok": False, "error": str(e)[:500]})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
