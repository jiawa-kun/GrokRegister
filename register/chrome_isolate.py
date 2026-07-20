# -*- coding: utf-8 -*-
"""并行安全：为副 Chromium（mint/consent/login）独占 debug 端口 + profile。

DrissionPage 的 set_user_data_path() 会关闭 auto_port；若不再 set_local_port，
会回落到默认 9222，与注册主浏览器互附着。
"""
from __future__ import annotations

import random
import socket
from typing import Any, Optional


def pick_free_local_port(lo: int = 39000, hi: int = 59000) -> int:
    """跨进程拿空闲端口。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", 0))
            return int(s.getsockname()[1])
    except Exception:
        pass
    for _ in range(60):
        p = random.randint(lo, hi)
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", p))
                return p
        except OSError:
            continue
    return 0


def bind_exclusive_debug_port(opts: Any, port: Optional[int] = None) -> int:
    """在 set_user_data_path 之后调用：set_local_port + remote-debugging-port 参数。"""
    p = int(port or 0)
    if p <= 0:
        p = pick_free_local_port()
    if p <= 0:
        try:
            opts.auto_port()
        except Exception:
            pass
        return 0
    try:
        opts.set_local_port(int(p))
    except Exception:
        try:
            opts.set_address(f"127.0.0.1:{int(p)}")
        except Exception:
            pass
    try:
        opts.set_argument(f"--remote-debugging-port={int(p)}")
    except Exception:
        pass
    return int(p)


def isolate_chromium_options(
    opts: Any,
    *,
    user_data_path: str,
    port: Optional[int] = None,
) -> int:
    """先 user_data，再独占端口。返回实际端口（0=auto 回退）。"""
    try:
        opts.set_user_data_path(user_data_path)
    except Exception:
        pass
    return bind_exclusive_debug_port(opts, port)
