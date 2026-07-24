# -*- coding: utf-8 -*-
"""
Plan C · Hybrid 注册：浏览器 harvest（Castle/CF/Turnstile）+ 协议 gRPC/Server Action。

对齐 regkit AuthManagementClient 真实流水线：
  open signup → harvest castle（UI 提交 CreateEmail）→ VerifyEmail → ValidatePassword
  → Turnstile → create_user_via_server_action → SSO materialize → 落盘

入口：
  run_hybrid_registration(output_path, extract_numbers=False)  # DrissionPage_example 调用
  hybrid_register(...) / register_one_hybrid(...)
"""
from __future__ import annotations

import json
import os
import secrets
import string
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]
ROOT = Path(__file__).resolve().parent

try:
    from runtime_config import runtime_config_path
except Exception:
    def runtime_config_path() -> Path:
        return ROOT / "config.json"


def _noop(_: str) -> None:
    return None


def protocol_available() -> bool:
    try:
        from protocol import ProtocolSession, AuthManagementClient  # noqa: F401

        return True
    except Exception:
        return False


def load_next_action_from_capture() -> str:
    rpc = ROOT / "capture_out" / "rpc"
    for name in ("03_SignUpSubmit.req.headers.json",):
        p = rpc / name
        if p.is_file():
            try:
                h = json.loads(p.read_text(encoding="utf-8"))
                return str(h.get("next-action") or h.get("Next-Action") or "")
            except Exception:
                pass
    if rpc.is_dir():
        for f in rpc.glob("*.req.headers.json"):
            try:
                h = json.loads(f.read_text(encoding="utf-8"))
                if h.get("next-action"):
                    return str(h["next-action"])
            except Exception:
                pass
    return ""


def _build_profile() -> tuple[str, str, str]:
    try:
        from grok_register_ttk import build_profile

        return build_profile()
    except Exception:
        given_pool = ["Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley"]
        family_pool = ["Smith", "Johnson", "Williams", "Brown", "Jones"]
        alphabet = string.ascii_letters + string.digits
        password = "".join(secrets.choice(alphabet) for _ in range(12)) + "aA1!"
        return secrets.choice(given_pool), secrets.choice(family_pool), password


def _get_email_and_token() -> tuple[str, str]:
    """按 mail_provider 创建邮箱（duckmail/yyds/gptmail/cloudflare），勿硬编码 CF。"""
    last_err: Exception | None = None
    try:
        from email_register import get_email_and_token as _get

        email, tok = _get()
        if email:
            return str(email), str(tok or "")
        raise RuntimeError("empty email from provider")
    except Exception as e:
        last_err = e
    try:
        from grok_register_ttk import get_email_and_token as _get2

        email, tok = _get2()
        if email:
            return str(email), str(tok or "")
    except Exception as e:
        last_err = e
    raise RuntimeError(f"create email failed: {last_err}")


def _get_mail_code(mail_token: str, email: str, log: LogFn) -> str:
    try:
        from email_register import get_oai_code

        code = get_oai_code(mail_token, email, timeout=90)
        return str(code or "").replace("-", "").strip()
    except Exception as e:
        log(f"[hybrid] get_oai_code: {e}")
        return ""


def _load_proxy() -> str:
    try:
        p = runtime_config_path()
        if not p.is_file():
            return ""
        conf = json.loads(p.read_text(encoding="utf-8"))
        p = str(
            conf.get("proxy")
            or conf.get("browser_proxy")
            or conf.get("resolved_proxy")
            or ""
        ).strip()
        if p:
            return p
        sb = conf.get("singbox_enabled")
        if sb is True or str(sb).strip().lower() in ("1", "true", "yes", "on"):
            port = conf.get("singbox_mixed_port") or conf.get("singBoxMixedPort") or 2080
            try:
                port = int(port)
            except Exception:
                port = 2080
            return f"http://127.0.0.1:{port}"
    except Exception:
        pass
    return ""


def hybrid_register(
    *,
    email: str = "",
    password: str = "",
    proxy: str = "",
    birth_year: int = 1995,
    name: str = "",
    page: Any = None,
    log: Optional[LogFn] = None,
    mail_token: str = "",
    should_stop: Optional[Callable[[], bool]] = None,
    create_email_done: bool = False,
    email_code: str = "",
) -> dict[str, Any]:
    """单账号 hybrid。可传入已有 email/password/mail_token，否则自建。

    create_email_done=True：跳过 CreateEmail（Plan A/B 协议已发码）。
    email_code：已有 OTP 时跳过收件箱轮询。
    """
    log = log or _noop
    stop = should_stop or (lambda: False)
    _ = birth_year  # 协议路径用 profile 生日字段时由 server action 隐式处理
    create_email_done = bool(create_email_done)
    email_code = str(email_code or "").replace("-", "").replace(" ", "").strip()

    if not protocol_available():
        return {
            "ok": False,
            "error": "hybrid protocol 未就绪：register/protocol 导入失败",
            "mode": "hybrid",
        }

    try:
        from browser.token_harvester import BrowserTokenSession
        from protocol.grpc_client import AuthManagementClient
        from protocol.session import ProtocolSession
    except Exception as e:
        return {"ok": False, "error": f"import: {e}", "mode": "hybrid"}

    t0 = time.time()
    proxy = (proxy or _load_proxy()).strip()
    action = load_next_action_from_capture()

    # 邮箱
    if not email or not mail_token:
        try:
            email, mail_token = _get_email_and_token()
        except Exception as e:
            return {"ok": False, "error": f"create email: {e}", "mode": "hybrid"}
    email = str(email).strip()
    log(f"[hybrid] email={email}")

    given, family, prof_password = _build_profile()
    if password:
        prof_password = password
    if name:
        parts = str(name).strip().split(None, 1)
        given = parts[0]
        if len(parts) > 1:
            family = parts[1]

    try:
        reuse_br = bool(create_email_done)
        with BrowserTokenSession(
            log=log, reuse=reuse_br, keep_alive=reuse_br
        ) as browser:
            if stop():
                return {"ok": False, "error": "stopped", "mode": "hybrid"}
            if create_email_done:
                try:
                    from grok_register_ttk import _get_page

                    pg = _get_page()
                    url = ""
                    try:
                        url = str(
                            getattr(pg, "url", "")
                            or pg.run_js("return location.href")
                            or ""
                        )
                    except Exception:
                        url = ""
                    if "sign-up" not in url.lower() and "accounts.x.ai" not in url.lower():
                        browser.open_signup()
                    else:
                        log(f"[hybrid] reuse page url={url[:80]}")
                except Exception as re:
                    log(f"[hybrid] reuse page check: {re}")
                    try:
                        browser.open_signup()
                    except Exception:
                        pass
            else:
                browser.open_signup()
            browser.install_network_hook()
            action = action or browser.scrape_next_action() or action

            # UI 提交邮箱：优先 harvest 原生 IBYIll castle。
            # 空 castle 的 CreateEmail 会触发 Castle bot_flag → SSO 可登录但 CPA mint 恒 Access denied。
            if create_email_done:
                castle = ""
                log("[hybrid] create_email_done=1 · skip castle harvest / CreateEmail RPC")
            else:
                log("[hybrid] harvest castle via UI email submit…")
                castle = browser.harvest_castle_via_email_submit(email, timeout=50) or ""
            browser_cookies = browser.export_cookies()
            # create_email_done 表示上游（Plan A/B 协议）已发码，不等于浏览器 UI 已发出 CreateEmail
            browser_sent = (not create_email_done) and bool(
                browser.create_email_sent_via_browser()
            )
            clen = len(str(castle or ""))
            if castle and clen >= 1000 and str(castle).startswith("IBYIll"):
                log(f"[hybrid] native castle ok len={clen}")
            else:
                # second chance: re-read capture + short native mint
                try:
                    if hasattr(browser, "read_captured_castle"):
                        c2 = browser.read_captured_castle()
                        if c2 and len(c2) > clen:
                            castle, clen = c2, len(c2)
                    if (
                        (not castle or clen < 1000 or not str(castle).startswith("IBYIll"))
                        and hasattr(browser, "get_castle_token")
                    ):
                        minted = browser.get_castle_token(timeout=12) or ""
                        if (
                            minted
                            and len(minted) >= 1000
                            and str(minted).startswith("IBYIll")
                        ):
                            castle, clen = minted, len(minted)
                            log(f"[hybrid] castle via get_castle_token len={clen}")
                except Exception as e:
                    log(f"[hybrid] castle second-chance skip: {e}")
                if castle and clen >= 1000 and str(castle).startswith("IBYIll"):
                    log(f"[hybrid] native castle ok (2nd) len={clen}")
                else:
                    log(
                        f"[hybrid] no usable castle yet len={clen} "
                        f"browser_create_email={browser_sent} "
                        f"create_email_done={bool(create_email_done)}"
                    )
                    castle = str(castle or "")

            ua = browser.browser_user_agent() or ""
            sess = ProtocolSession(
                proxy=proxy,
                user_agent=ua,
                impersonate="chrome131",
            )
            jar = dict(browser_cookies or {})
            for stale in ("sso", "sso-rw"):
                jar.pop(stale, None)
            sess.set_cookies(jar)
            client = AuthManagementClient(sess)
            if action:
                client.next_action = action

            castle_ok = bool(
                castle and clen >= 1000 and str(castle).startswith("IBYIll")
            )
            if create_email_done:
                # A/B 已在 fill_email/fill_code 完成 CreateEmail+收码；勿再 RPC 发码
                log("[hybrid] skip CreateEmail (upstream protocol already sent code)")
            elif browser_sent and castle_ok:
                # UI already fired CreateEmail with IBYIll — do NOT force a 2nd RPC
                # (double CreateEmail correlates with Castle policy=deny / high risk).
                log(
                    f"[hybrid] CreateEmail via browser OK (skip protocol) "
                    f"castle_len={clen}"
                )
            elif browser_sent and not castle_ok:
                # 浏览器已发 CreateEmail 但未抓到 IBYIll → 高概率空 castle bot 号
                log(
                    f"[hybrid] CreateEmail browser-sent but castle missing/weak "
                    f"len={clen} — abort (avoid unmintable bot SSO)"
                )
                return {
                    "ok": False,
                    "error": f"CreateEmail browser-sent without castle len={clen}",
                    "mode": "hybrid",
                }
            else:
                # CreateEmail：必须 IBYIll。优先浏览器页内 fetch（同源 cookie），再 curl 重试。
                if not castle_ok:
                    log(
                        f"[hybrid] CreateEmail not confirmed and castle unusable "
                        f"len={clen}"
                    )
                    return {
                        "ok": False,
                        "error": f"CreateEmail 未确认且 castle 无效 len={clen}",
                        "mode": "hybrid",
                    }
                ce_ok = False
                # browser page-fetch often more reliable than curl through flaky proxy
                if hasattr(browser, "force_create_email_via_page"):
                    try:
                        fr = browser.force_create_email_via_page(
                            email, timeout=25.0, castle_token=str(castle)
                        )
                        log(f"[hybrid] CreateEmail page-fetch: {fr}")
                        if isinstance(fr, dict) and fr.get("ok"):
                            ce_ok = True
                    except Exception as fe:
                        log(f"[hybrid] CreateEmail page-fetch err: {fe}")
                if not ce_ok:
                    last_st = 0
                    for attempt in range(3):
                        try:
                            r1 = client.create_email_validation_code(
                                email, str(castle)
                            )
                            last_st = int(r1.get("status") or 0)
                            log(
                                f"[hybrid] CreateEmail protocol attempt={attempt + 1} "
                                f"status={last_st} castle_len={clen}"
                            )
                            if 200 <= last_st < 300:
                                ce_ok = True
                                break
                        except Exception as cee:
                            log(
                                f"[hybrid] CreateEmail protocol attempt={attempt + 1} "
                                f"err={cee}"
                            )
                        time.sleep(1.2 * (attempt + 1))
                    if not ce_ok:
                        return {
                            "ok": False,
                            "error": f"CreateEmail fail status={last_st}",
                            "mode": "hybrid",
                        }
            if stop():
                return {"ok": False, "error": "stopped", "mode": "hybrid"}

            if email_code:
                clean = email_code
                log(f"[hybrid] reuse email_code={clean}")
            else:
                clean = _get_mail_code(mail_token, email, log)
            if not clean:
                log("[hybrid] no mail code")
                return {"ok": False, "error": "no mail code", "mode": "hybrid"}
            log(f"[hybrid] code={clean}")

            # Protocol verify keeps server state; UI finish must NOT open_signup (wipes SPA step).
            r2 = client.verify_email_validation_code(email, clean)
            log(f"[hybrid] VerifyEmail status={r2.get('status')}")
            # soft-fail: even if protocol verify flakes, browser code submit may still work
            if int(r2.get("status") or 0) >= 400:
                log(f"[hybrid] VerifyEmail soft-fail {r2.get('strings')} — continue UI")
            if stop():
                return {"ok": False, "error": "stopped", "mode": "hybrid"}

            try:
                client.validate_password(email, prof_password)
            except Exception:
                pass

            # ── Pure browser finish: stay on harvest session ──
            # harvest already did email+CreateEmail; fill OTP → profile → native submit.
            # Hardcoded next-action is currently 404 on server; React submit is the reliable path.
            import time as _tfin
            from grok_register_ttk import _get_page

            turnstile = ""
            r3: dict = {}
            sso = ""
            body_txt = ""
            used_action = "browser-ui"
            castle2 = str(castle or "") if str(castle or "").startswith("IBYIll|") else str(castle or "")

            def _ui_state():
                pg = _get_page()
                if pg is None:
                    return {}
                try:
                    return (
                        pg.run_js(
                            r"""
function vis(n){if(!n)return false;const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden')return false;const r=n.getBoundingClientRect();return r.width>0&&r.height>0;}
const pw=[...document.querySelectorAll('input[type="password"]')].some(vis);
const gn=[...document.querySelectorAll('input[name="givenName"],input[autocomplete="given-name"],input[name="familyName"]')].some(vis);
const email=[...document.querySelectorAll('input[type="email"],input[name="email"],input[data-testid="email"]')].some(vis);
const code=[...document.querySelectorAll('input[data-input-otp="true"],input[autocomplete="one-time-code"]')].some(vis)
  || [...document.querySelectorAll('input')].filter(n=>vis(n)&&Number(n.maxLength||0)===1).length>=4;
return {pw:!!pw, gn:!!gn, email:!!email, code:!!code, url: location.href};
"""
                        )
                        or {}
                    )
                except Exception:
                    return {}

            log("[hybrid] UI finish: fill OTP on harvest session (no open_signup)…")
            st0 = _ui_state()
            log(f"[hybrid] UI state0={st0}")
            # If still on email (unexpected), re-submit email once without full reload
            if isinstance(st0, dict) and st0.get("email") and not st0.get("code") and not st0.get("pw"):
                if hasattr(browser, "_set_input_and_submit"):
                    log(f"[hybrid] UI re-submit email: {browser._set_input_and_submit(email, 'email')}")
                    _tfin.sleep(1.8)
            # Fill OTP
            if hasattr(browser, "_set_input_and_submit"):
                for _ in range(3):
                    st = _ui_state()
                    if isinstance(st, dict) and (st.get("pw") or st.get("gn")):
                        break
                    if isinstance(st, dict) and (st.get("code") or not st.get("pw")):
                        r_cd = browser._set_input_and_submit(clean, "code")
                        log(f"[hybrid] UI code submit: {r_cd} state={st}")
                        _tfin.sleep(2.0)
            # Wait profile fields
            profile_ok = False
            for i in range(25):
                st = _ui_state()
                if i % 3 == 0:
                    log(f"[hybrid] UI wait profile state={st}")
                if isinstance(st, dict) and (st.get("pw") or st.get("gn")):
                    profile_ok = True
                    break
                # if stuck on email after protocol path, one open_signup then code-only is useless;
                # try code again
                if isinstance(st, dict) and st.get("code") and hasattr(browser, "_set_input_and_submit"):
                    browser._set_input_and_submit(clean, "code")
                _tfin.sleep(0.9)
            log(f"[hybrid] profile fields ready={profile_ok}")

            # Turnstile on current page (prefer inject; native often empty under automation)
            try:
                log("[hybrid] turnstile on current step…")
                turnstile = browser.get_turnstile_token(timeout=45, inject=True, fast=False)
            except TypeError:
                try:
                    turnstile = browser.get_turnstile_token(timeout=45, inject=True)
                except Exception as te:
                    log(f"[hybrid] turnstile: {te}")
            except Exception as te:
                log(f"[hybrid] turnstile: {te}")
            if len(str(turnstile or "")) < 80:
                try:
                    turnstile = browser.get_turnstile_token(timeout=50, inject=True)
                except Exception:
                    pass
            log(f"[hybrid] turnstile_len={len(str(turnstile or ''))}")

            # Inject token into DOM for React form
            try:
                pg = _get_page()
                if pg is not None and turnstile:
                    pg.run_js(
                        """
const tok = String(arguments[0]||'');
window.__hybrid_turnstile = tok;
for (const el of document.querySelectorAll(
  'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], input[name*="turnstile" i]'
)) {
  try {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(el, tok); else el.value = tok;
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  } catch (e) {}
}
return true;
""",
                        turnstile,
                    )
            except Exception:
                pass

            # Fresh castle + conversionId before CreateUser (registration risk event)
            try:
                if hasattr(browser, "_kick_page_castle_mint"):
                    browser._kick_page_castle_mint(_get_page())
                if hasattr(browser, "read_captured_castle"):
                    c_fresh = browser.read_captured_castle() or ""
                    if (
                        c_fresh
                        and len(c_fresh) >= 1000
                        and str(c_fresh).startswith("IBYIll")
                        and len(c_fresh) >= len(str(castle2 or ""))
                    ):
                        castle2 = c_fresh
                        log(f"[hybrid] fresh castle pre-profile len={len(castle2)}")
                # Inject conversionId + castle into any matching form fields React may bind
                pg_pre = _get_page()
                if pg_pre is not None:
                    import uuid as _uuid_pre

                    conv_id = str(_uuid_pre.uuid4())
                    pg_pre.run_js(
                        """
const castle = String(arguments[0]||'');
const conv = String(arguments[1]||'');
window.__hybrid_conversion_id = conv;
if (castle) {
  window.__hybrid_castle = castle;
  window.__hybrid_castles = window.__hybrid_castles || [];
  window.__hybrid_castles.push(castle);
}
function setNamed(name, val) {
  if (!val) return 0;
  let n = 0;
  for (const el of document.querySelectorAll(
    'input[name="'+name+'"], textarea[name="'+name+'"], input[id="'+name+'"]'
  )) {
    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set
        || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
      if (setter) setter.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      n++;
    } catch (e) {}
  }
  return n;
}
const nC = setNamed('castleRequestToken', castle) + setNamed('castle_request_token', castle);
const nV = setNamed('conversionId', conv) + setNamed('conversion_id', conv);
return {nC, nV, clen: castle.length, conv: conv.slice(0,8)};
""",
                        str(castle2 or ""),
                        conv_id,
                    )
                    log(f"[hybrid] pre-profile inject conversionId={conv_id[:8]}… castle_len={len(str(castle2 or ''))}")
            except Exception as pe0:
                log(f"[hybrid] pre-profile castle/conversion inject skip: {pe0}")

            # Native profile submit (React binds valid Server Action)
            if hasattr(browser, "submit_profile_and_wait_sso"):
                log("[hybrid] native profile submit…")
                try:
                    sso = (
                        browser.submit_profile_and_wait_sso(
                            given_name=given,
                            family_name=family,
                            password=prof_password,
                            timeout=55.0,
                        )
                        or ""
                    )
                    if sso:
                        used_action = "browser-form"
                        r3 = {
                            "status": 200,
                            "text": "browser-profile-submit",
                            "cookies": browser.export_cookies() or {},
                            "sso": sso,
                        }
                        log(f"[hybrid] native profile sso_len={len(sso)}")
                except Exception as pe:
                    log(f"[hybrid] native profile: {pe}")

            # Fallback: browser SA if we got a live action after profile hydration
            action_cands: list[str] = []
            if not sso:
                try:
                    live = str(browser.scrape_next_action() or "").strip()
                    if live:
                        action_cands.append(live)
                        log(f"[hybrid] live next-action after profile={live[:20]}...")
                except Exception:
                    pass
            for src in (action, load_next_action_from_capture()):
                s = str(src or "").strip()
                if s and s not in action_cands:
                    action_cands.append(s)

            # Prefer browser-context Server Action (same CF cookies / deploy as page)
            if (not sso) and hasattr(browser, "submit_create_user_server_action") and action_cands:
                for ai, act in enumerate(action_cands[:4]):
                    if stop():
                        break
                    used_action = f"browser-sa:{act[:16]}"
                    log(
                        f"[hybrid] browser SA try[{ai + 1}] {act[:20]}... "
                        f"castle_len={len(str(castle2 or ''))}"
                    )
                    try:
                        br = browser.submit_create_user_server_action(
                            email=email,
                            code=clean,
                            given_name=given,
                            family_name=family,
                            password=prof_password,
                            turnstile_token=turnstile,
                            castle_token=castle2,
                            next_action=act,
                        )
                    except Exception as se:
                        log(f"[hybrid] browser SA err: {se}")
                        continue
                    sso = str(br.get("sso") or "")
                    body_txt = str(br.get("text") or "")
                    r3 = {
                        "status": br.get("status"),
                        "text": body_txt,
                        "cookies": browser.export_cookies() if hasattr(browser, "export_cookies") else {},
                        "sso": sso,
                    }
                    if sso:
                        break
                    if int(br.get("status") or 0) == 404 or "Server action not found" in body_txt:
                        log("[hybrid] browser SA 404 → next action")
                        continue
                    log(
                        f"[hybrid] browser SA no-sso status={br.get('status')} "
                        f"body={body_txt[:120]!r}"
                    )
                    if ai >= 1:
                        break

            # curl protocol fallback (only if we have a non-404 action id)
            if not sso and action_cands and len(str(turnstile or "")) >= 80:
                for ai, act in enumerate(action_cands[:3]):
                    if stop():
                        break
                    used_action = act
                    client.next_action = act
                    log(
                        f"[hybrid] curl SA try[{ai + 1}] {act[:20]}... "
                        f"castle_len={len(str(castle2 or ''))}"
                    )
                    try:
                        jar3 = dict(browser.export_cookies() or {})
                        for stale in ("sso", "sso-rw"):
                            jar3.pop(stale, None)
                        sess.set_cookies(jar3)
                    except Exception:
                        pass
                    try:
                        r3 = client.create_user_via_server_action(
                            email=email,
                            code=clean,
                            given_name=given,
                            family_name=family,
                            password=prof_password,
                            turnstile_token=turnstile,
                            castle_token=castle2,
                            next_action=act,
                            conversion_id=str(uuid.uuid4()),
                        )
                    except Exception as se:
                        log(f"[hybrid] curl SA err: {se}")
                        continue
                    sso = r3.get("sso") or ""
                    if not sso:
                        ck = r3.get("cookies") or {}
                        sso = ck.get("sso") or ck.get("sso-rw") or ""
                    body_txt = str(r3.get("text") or "")
                    st = int(r3.get("status") or 0)
                    if sso:
                        break
                    if st == 404 or "Server action not found" in body_txt:
                        log("[hybrid] curl SA 404 → next")
                        continue
                    log(f"[hybrid] curl SA no-sso status={st} body={body_txt[:120]!r}")
                    if ai >= 1:
                        break

            log(
                f"[hybrid] sign-up status={r3.get('status')} sso_len={len(sso)} "
                f"action={(used_action or '')[:16]} elapsed={time.time() - t0:.1f}s"
            )
            if not sso:
                return {
                    "ok": False,
                    "error": f"no sso body={body_txt[:200]}",
                    "mode": "hybrid",
                    "cookies": list((r3.get("cookies") or {}).keys())[:12],
                }

            # wrapper SSO → session SSO
            try:
                from protocol.sso_util import (
                    is_session_sso,
                    is_wrapper_sso,
                    materialize_sso_via_browser,
                    materialize_sso_via_http,
                )

                if is_wrapper_sso(sso) or not is_session_sso(sso):
                    log(
                        f"[hybrid] sso looks like wrapper len={len(sso)}; materialize…"
                    )
                    sess_sso = ""
                    page_obj = page
                    if page_obj is None:
                        try:
                            from grok_register_ttk import _get_page

                            page_obj = _get_page()
                        except Exception:
                            page_obj = None
                    if page_obj is not None:
                        sess_sso = materialize_sso_via_browser(
                            page_obj, sso, log=log, timeout=40
                        )
                    if not sess_sso or not is_session_sso(sess_sso):
                        jar_full = dict(browser.export_cookies() or {})
                        sess_sso = (
                            materialize_sso_via_http(
                                sso,
                                proxy=proxy,
                                extra_cookies=jar_full,
                                log=log,
                            )
                            or sess_sso
                        )
                    if sess_sso and is_session_sso(sess_sso):
                        log(f"[hybrid] session sso ready len={len(sess_sso)}")
                        sso = sess_sso
                    else:
                        log(
                            f"[hybrid] WARN still non-session sso len={len(sso)}; "
                            f"CPA mint may fail"
                        )
            except Exception as me:
                log(f"[hybrid] sso materialize: {me}")

            # 导出 cookie 列表（含 cf_clearance）
            jar_full = dict(browser.export_cookies() or {})
            if sso:
                jar_full["sso"] = sso
                jar_full["sso-rw"] = jar_full.get("sso-rw") or sso
            cookie_list = [
                {"name": k, "value": v, "domain": ".x.ai", "path": "/"}
                for k, v in jar_full.items()
                if k and v is not None
            ]
            # W3 · SSO 去重
            try:
                from sso_ledger import claim_sso

                claim = claim_sso(sso, email=email)
                if claim.get("duplicate"):
                    log(
                        f"[hybrid][sso-ledger] ✘ 重复指纹 "
                        f"{str(claim.get('fingerprint') or '')[:12]}…"
                    )
                    return {
                        "ok": False,
                        "error": "duplicate SSO fingerprint",
                        "duplicate": True,
                        "mode": "hybrid",
                        "fingerprint": claim.get("fingerprint"),
                    }
            except Exception as le:
                log(f"[hybrid] sso ledger: {le}")

            # W2 · 缓存 CF（供主循环下一轮 restore）
            try:
                from cf_context import CloudflareContext, set_thread_cf_context

                cf_str = str(jar_full.get("cf_clearance") or "")
                if cf_str and not cf_str.startswith("cf_clearance="):
                    cf_str = f"cf_clearance={cf_str}"
                bm = str(jar_full.get("__cf_bm") or "")
                if bm and not bm.startswith("__cf_bm="):
                    bm = f"__cf_bm={bm}" if bm else ""
                parts = [p for p in (cf_str, bm) if p]
                if parts:
                    set_thread_cf_context(
                        CloudflareContext(
                            user_agent=ua or "",
                            cloudflare_cookies="; ".join(parts),
                            captured_at=time.time(),
                            source="hybrid",
                        )
                    )
                    log(f"[hybrid][cf-ctx] 已缓存 CF parts={len(parts)}")
            except Exception as cfe:
                log(f"[hybrid] cf cache: {cfe}")

            log(f"[hybrid] ✔ OK email={email} sso_len={len(sso)} cookies={len(cookie_list)}")
            return {
                "ok": True,
                "sso": sso,
                "email": email,
                "password": prof_password,
                "mode": "hybrid",
                "cookies": cookie_list,
                "cf_clearance": jar_full.get("cf_clearance") or "",
                "elapsed": round(time.time() - t0, 2),
            }
    except Exception as e:
        log(f"[hybrid] exception: {e}")
        try:
            log(traceback.format_exc().splitlines()[-3])
        except Exception:
            pass
        return {"ok": False, "error": str(e)[:400], "mode": "hybrid"}


def register_one_hybrid(
    *,
    log: Optional[LogFn] = None,
    proxy: str = "",
    user_agent: str = "",
    next_action: str = "",
    accounts_file: Optional[Path] = None,
    should_stop: Optional[Callable[[], bool]] = None,
    post_success: bool = True,
) -> bool:
    """regkit 兼容：成功返回 True。"""
    _ = user_agent, next_action, post_success
    log = log or _noop
    r = hybrid_register(proxy=proxy or "", log=log, should_stop=should_stop)
    if not r.get("ok"):
        return False
    email = r.get("email") or ""
    password = r.get("password") or ""
    sso = r.get("sso") or ""
    if accounts_file and email and sso:
        try:
            accounts_file = Path(accounts_file)
            accounts_file.parent.mkdir(parents=True, exist_ok=True)
            with accounts_file.open("a", encoding="utf-8") as f:
                f.write(f"{email} | {password} | {sso}\n")
        except Exception as e:
            log(f"[hybrid] save file fail: {e}")
    return True


def run_hybrid_registration(
    output_path: str = "",
    extract_numbers: bool = False,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """主循环入口（DrissionPage_example plan-c）。

    成功时返回含 sso/email/password 的 dict（与 run_single_registration 形状对齐）。
    """
    _ = extract_numbers
    log = log or (lambda m: print(m, flush=True))
    r = hybrid_register(proxy=_load_proxy(), log=log)
    if not r.get("ok"):
        err = r.get("error") or "unknown"
        log(f"[hybrid] ✘ {err}")
        # keep structured error for Plan C outer logger
        return r

    email = r.get("email") or ""
    password = r.get("password") or ""
    sso = r.get("sso") or ""

    # 落盘 SSO 行
    try:
        out = Path(output_path) if output_path else ROOT / "sso.txt"
        out = Path(out)
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "a", encoding="utf-8") as f:
            # 与 Plan A append_sso_to_txt 一致：email | password | sso（号池/导入可解析）
            f.write(f"{email} | {password} | {sso}\n")
        log(f"[hybrid] 已写入 {out}")
        # 与 Plan A 对齐，便于 Node 侧抓 email 并触发号池/自动验活
        if email:
            log(f"[*] 本轮注册完成，邮箱: {email}")
    except Exception as we:
        log(f"[hybrid] 写文件失败: {we}")

    # 尝试入授权队列（若可用）
    try:
        cookies = r.get("cookies") or []
        cf_parts = []
        for c in cookies:
            if isinstance(c, dict) and c.get("name") and c.get("value"):
                n = str(c["name"])
                if n.lower() in ("cf_clearance", "__cf_bm", "sso", "sso-rw"):
                    cf_parts.append(f"{n}={c['value']}")
        cf_hint = "; ".join(cf_parts) or str(r.get("cf_clearance") or "")
        try:
            from auth_export_queue import enqueue_authorization as _enq
        except Exception:
            from auth_export_queue import enqueue_sso_to_auth as _enq
        _enq(
            sso=sso,
            email=email,
            password=password,
            cloudflare_cookies=cf_hint,
            log=log,
        )
    except Exception as qe:
        log(f"[hybrid] auth queue skip: {qe}")

    return {
        "ok": True,
        "sso": sso,
        "email": email,
        "password": password,
        "mode": "hybrid",
        "cookies": r.get("cookies") or [],
        "cf_clearance": r.get("cf_clearance") or "",
    }


# 别名：旧封装名
run_hybrid_registration_flow = run_hybrid_registration


def run_hybrid_registration_job(count, log_callback=None, controller=None):
    """批量 job（CLI/Web 兼容）。"""
    log = log_callback or (lambda m: print(m, flush=True))
    if controller is None:
        try:
            from grok_register_ttk import CliStopController

            controller = CliStopController()
        except Exception:

            class _C:
                def should_stop(self):
                    return False

            controller = _C()

    success_count = 0
    fail_count = 0
    try:
        from grok_register_ttk import now_beijing

        ts = now_beijing()
    except Exception:
        ts = time.strftime("%Y%m%d_%H%M%S")
    accounts_output_file = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        f"accounts_hybrid_{ts}.txt",
    )
    log(f"[*] 混合模式启动，目标数量: {count}")
    log(f"[*] 成功账号将实时保存到: {accounts_output_file}")
    proxy = _load_proxy()
    next_action = load_next_action_from_capture()

    i = 0
    try:
        while i < int(count):
            if controller.should_stop():
                break
            log(f"--- [hybrid] 开始第 {i + 1}/{count} 个账号 ---")
            ok = register_one_hybrid(
                log=log,
                proxy=proxy,
                next_action=next_action,
                accounts_file=Path(accounts_output_file),
                should_stop=controller.should_stop,
            )
            if ok:
                success_count += 1
            else:
                fail_count += 1
            i += 1
            log(f"[*] 当前统计: 成功 {success_count} | 失败 {fail_count}")
            if controller.should_stop():
                break
            time.sleep(1)
    except KeyboardInterrupt:
        try:
            controller.stop()
        except Exception:
            pass
        log("[!] 收到 Ctrl+C，正在停止")
    except Exception as exc:
        log(f"[!] 混合任务异常: {exc}")

    log(f"[*] 混合任务结束。成功 {success_count} | 失败 {fail_count}")
    return {
        "success": success_count,
        "fail": fail_count,
        "accounts_file": accounts_output_file,
        "stopped": bool(getattr(controller, "should_stop", lambda: False)()),
    }
