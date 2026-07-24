# -*- coding: utf-8 -*-
"""
Compatibility shim: regkit / browser.token_harvester import ``grok_register_ttk``.

本仓库主引擎是 DrissionPage_example，在此转发常用符号，避免 hybrid 因缺模块失败。

重要：runner.py 用 runpy 以 __main__ 加载引擎时，sys.modules['__main__'] 才有 page/browser；
若只 import DrissionPage_example 会得到另一份空模块 → hybrid 误起第二浏览器。
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType
from typing import Any, Optional

_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _resolve_engine() -> ModuleType:
    """Prefer the live process engine (__main__ or already-loaded module)."""
    main = sys.modules.get("__main__")
    if main is not None and (
        hasattr(main, "start_browser") or getattr(main, "page", None) is not None
    ):
        return main  # type: ignore[return-value]
    eng = sys.modules.get("DrissionPage_example")
    if eng is not None and (
        hasattr(eng, "start_browser") or getattr(eng, "page", None) is not None
    ):
        return eng  # type: ignore[return-value]
    import DrissionPage_example as eng  # noqa: E402

    return eng


def _engine() -> ModuleType:
    return _resolve_engine()


def _with_log_callback(fn_name: str):
    def _wrap(*args, log_callback=None, **kwargs):
        kwargs.pop("log_callback", None)
        fn = getattr(_engine(), fn_name)
        return fn(*args, **kwargs)

    return _wrap


def start_browser(*args, log_callback=None, **kwargs):
    kwargs.pop("log_callback", None)
    return _engine().start_browser(*args, **kwargs)


def stop_browser(*args, **kwargs):
    return _engine().stop_browser(*args, **kwargs)


def restart_browser(*args, **kwargs):
    eng = _engine()
    fn = getattr(eng, "restart_browser", None)
    if callable(fn):
        return fn(*args, **kwargs)
    stop_browser()
    return start_browser()


def open_signup_page(*args, log_callback=None, **kwargs):
    kwargs.pop("log_callback", None)
    return _engine().open_signup_page(*args, **kwargs)


def click_email_signup_button(timeout=10, log_callback=None, **kwargs):
    kwargs.pop("log_callback", None)
    return _engine().click_email_signup_button(timeout=timeout, **kwargs)


def getTurnstileToken(timeout=50, log_callback=None, **kwargs):
    kwargs.pop("log_callback", None)
    return _engine().getTurnstileToken(timeout=timeout, log_callback=None, **kwargs)


def refresh_active_page(*args, **kwargs):
    fn = getattr(_engine(), "refresh_active_page", None)
    if callable(fn):
        return fn(*args, **kwargs)
    return None


def shutdown_browser(*_a, **_k):
    return stop_browser()


def _get_page():
    eng = _engine()
    page = getattr(eng, "page", None)
    if page is not None:
        return page
    # secondary: scan modules that expose page
    for name, mod in list(sys.modules.items()):
        if mod is None:
            continue
        if name in ("__main__", "DrissionPage_example") or (
            hasattr(mod, "start_browser") and hasattr(mod, "page")
        ):
            p = getattr(mod, "page", None)
            if p is not None:
                return p
    return None


def _get_browser():
    eng = _engine()
    b = getattr(eng, "browser", None)
    if b is not None:
        return b
    for name in ("__main__", "DrissionPage_example"):
        mod = sys.modules.get(name)
        if mod is not None:
            b = getattr(mod, "browser", None)
            if b is not None:
                return b
    return None


# 邮件（若引擎侧无同名则从 email_register 兜底）
try:
    from email_register import create_temp_email, get_oai_code  # noqa: F401
except Exception:  # pragma: no cover
    create_temp_email = None  # type: ignore
    get_oai_code = None  # type: ignore

schedule_post_registration = None
wait_post_success_queue = None
cleanup_runtime_memory = None
apply_resolved_proxy_to_config = None
sleep_with_cancel = None
cli_log = print
config: dict = {}


class CliStopController:
    def __init__(self):
        self._stop = False

    def stop(self):
        self._stop = True

    def should_stop(self):
        return bool(self._stop)


def now_beijing(fmt: str = "%Y%m%d_%H%M%S") -> str:
    try:
        from datetime import datetime, timezone, timedelta

        return datetime.now(timezone(timedelta(hours=8))).strftime(fmt)
    except Exception:
        from datetime import datetime

        return datetime.now().strftime(fmt)


def build_profile():
    """返回 (given_name, family_name, password)。"""
    import secrets
    import string

    given_pool = [
        "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Avery", "Quinn",
        "Jamie", "Skyler", "Cameron", "Drew", "Reese", "Blake", "Hayden",
    ]
    family_pool = [
        "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
        "Davis", "Wilson", "Anderson", "Thomas", "Jackson", "White", "Harris",
    ]
    alphabet = string.ascii_letters + string.digits
    password = "".join(secrets.choice(alphabet) for _ in range(12)) + "aA1!"
    return secrets.choice(given_pool), secrets.choice(family_pool), password


def get_email_and_token():
    """返回 (email, mail_token/jwt)。按 config.mail_provider 分流（duckmail/yyds/gptmail/cf）。"""
    from email_register import get_email_and_token as _get

    email, tok = _get()
    if not email:
        raise RuntimeError("create email failed: empty address")
    return str(email), str(tok or "")
