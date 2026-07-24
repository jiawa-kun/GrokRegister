"""Browser-only token harvest for Castle / Turnstile (hybrid mode)."""
from __future__ import annotations

import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


@dataclass
class HarvestedTokens:
    turnstile: str = ""
    castle: str = ""
    page_url: str = ""
    cookies: dict = field(default_factory=dict)
    next_action: str = ""


class BrowserTokenSession:
    """One Chromium session dedicated to token / cookie harvest."""

    def __init__(
        self,
        log: Optional[Callable[[str], None]] = None,
        *,
        reuse: bool = False,
        keep_alive: bool = False,
    ):
        self.log = log or (lambda _m: None)
        self.reuse = bool(reuse)
        self.keep_alive = bool(keep_alive)
        self._started = False
        self._hooked = False
        self._listen_started = False

    def _lg(self, msg: str):
        try:
            self.log(msg)
        except Exception:
            pass

    def start(self):
        from grok_register_ttk import start_browser, _get_page

        if self.reuse:
            try:
                if _get_page() is not None:
                    self._lg("[*] BrowserTokenSession reuse existing browser")
                    self._started = True
                    return self
            except Exception:
                pass
        start_browser(log_callback=self.log)
        self._started = True
        return self

    def install_network_hook(self) -> bool:
        """Capture castleRequestToken from native React fetch/XHR bodies.

        Also starts DrissionPage network listener (CDP) as a side channel:
        gRPC-web CreateEmail often uses binary body; JS fetch hooks alone miss it.
        """
        from grok_register_ttk import _get_page

        page = _get_page()
        if page is None:
            self._lg("[Debug] net hook: page is None")
            return False
        try:
            res = page.run_js(
                r"""
(function(){
  if (window.__hybrid_net_hooked) return 'already';
  window.__hybrid_net_hooked = true;
  window.__hybrid_castles = window.__hybrid_castles || [];
  window.__hybrid_castle = window.__hybrid_castle || '';
  window.__hybrid_net = window.__hybrid_net || [];
  window.__hybrid_create_email_ok = false;
  window.__hybrid_create_email_status = 0;
  window.__hybrid_create_email_seen = false;

  function pushCastle(tok) {
    try {
      const s = String(tok || '');
      if (s.length < 200) return;
      window.__hybrid_castle = s;
      window.__hybrid_castles.push(s);
    } catch (e) {}
  }

  function extractCastleFromText(s) {
    if (!s || typeof s !== 'string') return;
    if (s.includes('castleRequestToken')) {
      try {
        const j = JSON.parse(s);
        const tok = j && j[0] && j[0].castleRequestToken;
        if (tok) pushCastle(tok);
      } catch (e) {
        const m = s.match(/castleRequestToken["']?\s*:\s*["']([^"']{200,})/);
        if (m) pushCastle(m[1]);
      }
    }
    const m2 = s.match(/IBYIll\|[A-Za-z0-9+/=|_-]{200,}/);
    if (m2) pushCastle(m2[0]);
  }

  async function bodyToString(body) {
    try {
      if (!body) return '';
      if (typeof body === 'string') return body;
      // Prefer latin1 so protobuf binary keeps ASCII castle spans intact for regex
      function dec(buf) {
        try {
          return new TextDecoder('latin1').decode(buf);
        } catch (e) {
          try { return new TextDecoder().decode(buf); } catch (e2) { return ''; }
        }
      }
      if (body instanceof ArrayBuffer) return dec(body);
      if (ArrayBuffer.isView(body)) return dec(body.buffer ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : body);
      if (typeof Blob !== 'undefined' && body instanceof Blob) return await body.text();
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        try { return JSON.stringify(Array.from(body.entries())); } catch (e) { return ''; }
      }
      if (typeof Request !== 'undefined' && body instanceof Request) {
        try { return await body.clone().text(); } catch (e) { return ''; }
      }
      if (typeof body.text === 'function') {
        try { return await body.text(); } catch (e) {}
      }
    } catch (e) {}
    return '';
  }

  function captureBody(body, url) {
    try {
      const u = String(url || '');
      let rawLen = 0;
      try {
        if (typeof body === 'string') rawLen = body.length;
        else if (body instanceof ArrayBuffer) rawLen = body.byteLength || 0;
        else if (ArrayBuffer.isView(body)) rawLen = body.byteLength || 0;
        else if (typeof Blob !== 'undefined' && body instanceof Blob) rawLen = body.size || 0;
      } catch (e) {}
      Promise.resolve(bodyToString(body)).then(function(s) {
        try {
          const len = Math.max(rawLen || 0, (s && s.length) || 0);
          if (!s && !len) return;
          window.__hybrid_net.push({url: u, len: len});
          if (u.includes('CreateEmailValidationCode')) {
            window.__hybrid_create_email_seen = true;
            if (len > 0 && len < 200) {
              window.__hybrid_create_email_short = true;
            }
          }
          if (s) extractCastleFromText(s);
        } catch (e) {}
      });
    } catch (e) {}
  }

  function patchSignupServerActionBody(bodyStr) {
    // Ensure createUser SA carries conversionId + long IBYIll castle.
    try {
      if (!bodyStr || typeof bodyStr !== 'string') return null;
      if (bodyStr.indexOf('createUserAndSessionRequest') < 0
          && bodyStr.indexOf('emailValidationCode') < 0) return null;
      const j = JSON.parse(bodyStr);
      if (!Array.isArray(j) || !j[0] || typeof j[0] !== 'object') return null;
      const row = j[0];
      const bestCastle = (function() {
        let c = String(window.__hybrid_castle || '');
        try {
          for (const t of (window.__hybrid_castles || [])) {
            if (String(t || '').length > c.length) c = String(t);
          }
        } catch (e0) {}
        return c;
      })();
      const prev = String(row.castleRequestToken || '');
      let changed = false;
      if (bestCastle.indexOf('IBYIll|') === 0 && bestCastle.length >= 1000) {
        if (prev.length < 1000 || prev.indexOf('IBYIll|') !== 0) {
          row.castleRequestToken = bestCastle;
          changed = true;
        }
      }
      if (!row.conversionId) {
        row.conversionId = String(window.__hybrid_conversion_id || '')
          || (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random()));
        changed = true;
      }
      window.__hybrid_create_user_meta = {
        prevCastle: prev.length,
        castle: String(row.castleRequestToken || '').length,
        conv: String(row.conversionId || '').slice(0, 8),
        patched: changed,
      };
      return changed ? JSON.stringify(j) : null;
    } catch (e) {
      window.__hybrid_create_user_meta = { err: String(e) };
      return null;
    }
  }

  const ofetch = window.fetch;
  window.fetch = async function(input, init) {
    let url = '';
    let args = arguments;
    try {
      url = (typeof input === 'string')
        ? input
        : (input && (input.url || (input.href || ''))) || '';
      let body = (init && init.body != null)
        ? init.body
        : (typeof Request !== 'undefined' && input instanceof Request ? input : null);
      // Patch React Server Action CreateUser body before it leaves the page
      if (init && typeof init.body === 'string'
          && (String(url).includes('sign-up') || String(url).includes('accounts.x.ai'))) {
        const patched = patchSignupServerActionBody(init.body);
        if (patched) {
          init = Object.assign({}, init, { body: patched });
          body = patched;
          args = [input, init];
        }
      }
      if (body != null) captureBody(body, url);
      else if (typeof Request !== 'undefined' && input instanceof Request) {
        try { captureBody(await input.clone().text(), url); } catch (e) {}
      }
    } catch (e) {}
    const resp = await ofetch.apply(this, args.length ? args : arguments);
    try {
      if (String(url).includes('CreateEmailValidationCode')) {
        window.__hybrid_create_email_status = resp.status || 0;
        window.__hybrid_create_email_ok = !!(resp.ok || (resp.status >= 200 && resp.status < 300));
        window.__hybrid_create_email_seen = true;
      }
    } catch (e) {}
    return resp;
  };

  const oopen = XMLHttpRequest.prototype.open;
  const osend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u) {
    this.__u = u;
    return oopen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    captureBody(body, this.__u);
    const xhr = this;
    try {
      xhr.addEventListener('load', function() {
        try {
          if (String(xhr.__u || '').includes('CreateEmailValidationCode')) {
            window.__hybrid_create_email_status = xhr.status || 0;
            window.__hybrid_create_email_ok = xhr.status >= 200 && xhr.status < 300;
            window.__hybrid_create_email_seen = true;
          }
        } catch (e) {}
      });
    } catch (e) {}
    return osend.apply(this, arguments);
  };
  return 'hooked';
})();
"""
            )
            # DrissionPage may return None for JS that ends with return inside IIFE.
            if res is None:
                probe = page.run_js(
                    "return window.__hybrid_net_hooked ? (window.__hybrid_net_hooked === true ? 'hooked' : String(window.__hybrid_net_hooked)) : 'missing';"
                )
                res = probe if probe not in (None, "missing") else "hooked"
            self._hooked = True
            self._lg(f"[*] net hook={res}")
        except Exception as e:
            self._lg(f"[Debug] net hook: {e}")
            self._hooked = False

        # CDP listener: reliable for request postData (JSON server-action + any post body)
        try:
            self._start_cdp_listener(page)
        except Exception as e:
            self._lg(f"[Debug] cdp listen: {e}")

        return self._hooked

    def _start_cdp_listener(self, page) -> bool:
        """Listen for CreateEmail / castle-bearing POSTs via DrissionPage listener."""
        if page is None:
            return False
        try:
            listen = getattr(page, "listen", None)
            if listen is None:
                return False
            if not getattr(listen, "listening", False):
                # Match CreateEmail RPC and signup server actions
                # substring match on request URL (not body). CreateEmail carries castle.
                listen.start(
                    targets=[
                        "CreateEmailValidationCode",
                        "AuthManagement",
                        "accounts.x.ai/sign-up",
                    ],
                    method=("POST",),
                    res_type=True,
                )
            else:
                try:
                    listen.set_targets(
                        targets=[
                            "CreateEmailValidationCode",
                            "AuthManagement",
                            "accounts.x.ai/sign-up",
                        ],
                        method=("POST",),
                        res_type=True,
                    )
                except Exception:
                    pass
            self._listen_started = True
            self._lg("[*] cdp listen=on")
            return True
        except Exception as e:
            self._lg(f"[Debug] cdp listen start: {e}")
            return False

    @staticmethod
    def _extract_castle_from_blob(blob) -> str:
        """Pull IBYIll / long castleRequestToken from post body / response."""
        if blob is None or blob is False:
            return ""
        if isinstance(blob, (bytes, bytearray)):
            raw = bytes(blob)
            # gRPC-web frame may be: 1 byte flags + 4 byte len + protobuf (email + castle)
            # Castle string is almost always plain ASCII inside protobuf.
            # Also try skipping 5-byte gRPC-web header then search remainder.
            candidates = [raw]
            if len(raw) > 5:
                candidates.append(raw[5:])
            for chunk in candidates:
                try:
                    m = re.search(rb"IBYIll\|[A-Za-z0-9+/=|_\-]{800,}", chunk)
                    if m:
                        return m.group(0).decode("ascii", errors="ignore")
                except Exception:
                    pass
                try:
                    m = re.search(rb"IBYIll\|[A-Za-z0-9+/=|_\-]{200,}", chunk)
                    if m:
                        return m.group(0).decode("ascii", errors="ignore")
                except Exception:
                    pass
            try:
                s = raw.decode("utf-8", errors="ignore")
            except Exception:
                try:
                    s = raw.decode("latin-1", errors="ignore")
                except Exception:
                    s = ""
            text = s
        elif isinstance(blob, dict):
            # parsed JSON
            try:
                import json as _json

                text = _json.dumps(blob, ensure_ascii=False)
            except Exception:
                text = str(blob)
            # direct path
            try:
                if isinstance(blob, list) and blob and isinstance(blob[0], dict):
                    tok = blob[0].get("castleRequestToken") or ""
                    if len(str(tok)) >= 200:
                        return str(tok)
                if isinstance(blob, dict):
                    tok = blob.get("castleRequestToken") or ""
                    if len(str(tok)) >= 200:
                        return str(tok)
            except Exception:
                pass
        else:
            text = str(blob)

        if not text:
            return ""
        if "castleRequestToken" in text:
            try:
                import json as _json

                j = _json.loads(text)
                if isinstance(j, list) and j and isinstance(j[0], dict):
                    tok = j[0].get("castleRequestToken") or ""
                    if len(str(tok)) >= 200:
                        return str(tok)
            except Exception:
                m = re.search(r'castleRequestToken["\']?\s*:\s*["\']([^"\']{200,})', text)
                if m:
                    return m.group(1)
        m2 = re.search(r"IBYIll\|[A-Za-z0-9+/=|_-]{200,}", text)
        if m2:
            return m2.group(0)
        return ""

    def _poll_cdp_castle(self) -> str:
        """Drain listener packets for castle token."""
        from grok_register_ttk import _get_page

        page = _get_page()
        if page is None:
            return ""
        listen = getattr(page, "listen", None)
        if listen is None or not getattr(listen, "listening", False):
            return ""
        best = ""
        try:
            # Non-blocking drain via private queue size if available
            q = getattr(listen, "_caught", None)
            n = 0
            if q is not None:
                try:
                    n = int(q.qsize())
                except Exception:
                    n = 0
            for _ in range(max(n, 0) + 3):
                try:
                    # wait with tiny timeout to avoid hang
                    pkt = listen.wait(count=1, timeout=0.05, fit_count=True, raise_err=False)
                except TypeError:
                    try:
                        pkt = listen.wait(1, 0.05)
                    except Exception:
                        break
                except Exception:
                    break
                if not pkt:
                    break
                try:
                    req = getattr(pkt, "request", None)
                    post = None
                    if req is not None:
                        for attr in (
                            "postData",
                            "body",
                            "data",
                            "postDataRaw",
                            "post_data",
                        ):
                            v = getattr(req, attr, None)
                            if v:
                                post = v
                                break
                        # some versions expose postData as method
                        if post is None and callable(getattr(req, "postData", None)):
                            try:
                                post = req.postData()
                            except Exception:
                                pass
                    # postData 过短时用 Network.getRequestPostData 补全（gRPC 常被截断）
                    if post is not None:
                        try:
                            plen0 = (
                                len(post)
                                if isinstance(post, (bytes, bytearray))
                                else len(str(post))
                            )
                        except Exception:
                            plen0 = 0
                    else:
                        plen0 = 0
                    if plen0 < 200:
                        rid = None
                        for attr in ("requestId", "request_id", "id"):
                            try:
                                rid = getattr(req, attr, None) if req is not None else None
                                if rid:
                                    break
                            except Exception:
                                pass
                        if not rid:
                            try:
                                rid = getattr(pkt, "requestId", None) or getattr(
                                    pkt, "request_id", None
                                )
                            except Exception:
                                rid = None
                        if rid:
                            try:
                                extra = page.run_cdp(
                                    "Network.getRequestPostData", requestId=str(rid)
                                )
                                if isinstance(extra, dict):
                                    pd = extra.get("postData") or extra.get("body")
                                    if pd:
                                        post = pd
                            except Exception:
                                pass
                    # 响应体也可能带回 castle 相关（少见，兜底）
                    c = self._extract_castle_from_blob(post)
                    if len(c) <= len(best):
                        try:
                            resp = getattr(pkt, "response", None)
                            rbody = None
                            if resp is not None:
                                for attr in ("body", "raw_body", "postData", "data"):
                                    v = getattr(resp, attr, None)
                                    if v:
                                        rbody = v
                                        break
                            if rbody:
                                c2 = self._extract_castle_from_blob(rbody)
                                if len(c2) > len(c):
                                    c = c2
                        except Exception:
                            pass
                    if len(c) > len(best):
                        best = c
                    url = str(getattr(pkt, "url", "") or "")
                    if "CreateEmailValidationCode" in url:
                        plen = 0
                        try:
                            if isinstance(post, (bytes, bytearray)):
                                plen = len(post)
                            elif post is not None:
                                plen = len(str(post))
                        except Exception:
                            plen = 0
                        # Best-effort response status from listener packet
                        resp_status = 0
                        try:
                            resp = getattr(pkt, "response", None)
                            if resp is not None:
                                for attr in ("status", "status_code", "code"):
                                    v = getattr(resp, attr, None)
                                    if v is not None:
                                        try:
                                            resp_status = int(v)
                                            break
                                        except Exception:
                                            pass
                        except Exception:
                            resp_status = 0
                        if plen and plen < 200 and len(best) < 200:
                            self._lg(
                                f"[!] CDP CreateEmail postData still short len={plen} "
                                f"(castle missing in wire body)"
                            )
                        elif len(best) >= 200:
                            self._lg(
                                f"[*] CDP CreateEmail castle recovered len={len(best)}"
                                + (f" resp={resp_status}" if resp_status else "")
                            )
                        try:
                            # wire=true when body carried long castle; set status if known
                            page.run_js(
                                """
window.__hybrid_create_email_seen = true;
const plen = Number(arguments[0]||0);
const st = Number(arguments[1]||0);
const clen = Number(arguments[2]||0);
if (plen >= 200 || clen >= 200) {
  window.__hybrid_create_email_wire = true;
}
if (st >= 200 && st < 300) {
  window.__hybrid_create_email_status = st;
  window.__hybrid_create_email_ok = true;
} else if (clen >= 1000 && !window.__hybrid_create_email_status) {
  // Request body had IBYIll; status may arrive later via fetch hook
  window.__hybrid_create_email_wire = true;
}
true;
""",
                                plen,
                                resp_status,
                                len(best),
                            )
                        except Exception:
                            pass
                except Exception:
                    pass
        except Exception as e:
            self._lg(f"[Debug] cdp poll: {e}")
        if best and len(best) >= 200:
            # mirror into page globals for create_email_sent_via_browser
            try:
                page.run_js(
                    """
const t = String(arguments[0] || '');
if (t.length > 200) {
  window.__hybrid_castle = t;
  window.__hybrid_castles = window.__hybrid_castles || [];
  window.__hybrid_castles.push(t);
  window.__hybrid_create_email_seen = true;
  if (t.indexOf('IBYIll|') === 0 && t.length >= 1000) {
    window.__hybrid_create_email_wire = true;
  }
}
true;
""",
                    best,
                )
            except Exception:
                pass
            return best
        return ""

    def create_email_sent_via_browser(self) -> bool:
        """Skip protocol CreateEmail only when browser already fired a real request.

        Explicit HTTP 200 is ideal. CDP often captures CreateEmail request body
        (IBYIll castle) before fetch/XHR status lands — treat wire+long castle as
        success so hybrid does not double-fire CreateEmail (raises Castle risk).
        """
        from grok_register_ttk import _get_page

        page = _get_page()
        try:
            data = page.run_js(
                """
return {
  ok: !!window.__hybrid_create_email_ok,
  status: Number(window.__hybrid_create_email_status||0),
  seen: !!window.__hybrid_create_email_seen,
  wire: !!window.__hybrid_create_email_wire,
  castle: (window.__hybrid_castle||'').length,
  head: String(window.__hybrid_castle||'').slice(0, 8)
};
"""
            )
            if isinstance(data, dict):
                ok = bool(data.get("ok"))
                status = int(data.get("status") or 0)
                seen = bool(data.get("seen"))
                wire = bool(data.get("wire"))
                clen = int(data.get("castle") or 0)
                head = str(data.get("head") or "")
                # Explicit success
                if ok and (status == 0 or (200 <= status < 300)):
                    return True
                if seen and status == 200:
                    return True
                # CDP/wire: CreateEmail body carried long IBYIll → request fired
                if (seen or wire) and clen >= 1000 and head.startswith("IBYIll"):
                    self._lg(
                        f"[*] CreateEmail browser wire-ok status={status} "
                        f"seen={seen} wire={wire} castle_len={clen}"
                    )
                    return True
                self._lg(
                    f"[*] CreateEmail browser status: ok={ok} status={status} "
                    f"seen={seen} wire={wire} castle_len={clen}"
                )
        except Exception as e:
            self._lg(f"[*] CreateEmail browser status probe fail: {e}")
        return False

    def force_create_email_via_page(
        self, email: str, timeout: float = 20.0, castle_token: str = ""
    ) -> dict:
        """In-page fetch CreateEmailValidationCode (browser cookies + TLS).

        UI click often never fires RPC even after React fill; page fetch still uses
        real document origin/cookies. Pass castle_token (IBYIll) when available.
        """
        from grok_register_ttk import _get_page
        import base64
        import time as _time

        page = _get_page()
        if page is None:
            return {"ok": False, "error": "no-page"}
        try:
            from protocol.pb_codec import encode_create_email_validation_code
        except Exception as e:
            return {"ok": False, "error": f"codec:{e}"}
        body = encode_create_email_validation_code(
            str(email or "").strip(), str(castle_token or "").strip()
        )
        b64 = base64.b64encode(body).decode("ascii")
        try:
            page.run_js(
                """
window.__force_create_email_result = null;
const b64 = arguments[0];
(async () => {
  try {
    const raw = atob(b64);
    const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    const r = await fetch(
      'https://accounts.x.ai/auth_mgmt.AuthManagement/CreateEmailValidationCode',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/grpc-web+proto',
          'x-grpc-web': '1',
          'x-user-agent': 'connect-es/2.1.1',
          'accept': '*/*',
        },
        body: u8,
      }
    );
    window.__hybrid_create_email_seen = true;
    window.__hybrid_create_email_status = r.status;
    window.__hybrid_create_email_ok = (r.status === 200);
    let grpc = '';
    try { grpc = r.headers.get('grpc-status') || r.headers.get('Grpc-Status') || ''; } catch (e) {}
    let len = 0;
    try {
      const buf = await r.arrayBuffer();
      len = buf.byteLength || 0;
    } catch (e) {}
    window.__force_create_email_result = {
      ok: r.status === 200,
      status: r.status,
      grpc: grpc,
      len: len,
      via: 'page-fetch',
    };
  } catch (e) {
    window.__force_create_email_result = {
      ok: false,
      status: 0,
      err: String(e && e.message ? e.message : e),
      via: 'page-fetch',
    };
  }
})();
true;
""",
                b64,
            )
        except Exception as e:
            return {"ok": False, "error": f"run_js:{e}"}

        deadline = _time.time() + max(5.0, float(timeout or 20))
        while _time.time() < deadline:
            try:
                r = page.run_js("return window.__force_create_email_result;")
            except Exception:
                r = None
            if isinstance(r, dict) and r.get("via") == "page-fetch":
                self._lg(
                    f"[*] force CreateEmail page-fetch status={r.get('status')} "
                    f"ok={r.get('ok')} grpc={r.get('grpc')!r} len={r.get('len')} "
                    f"err={r.get('err') or ''}"
                )
                return r
            _time.sleep(0.25)
        self._lg("[!] force CreateEmail page-fetch timeout")
        return {"ok": False, "error": "timeout", "via": "page-fetch"}

    def browser_user_agent(self) -> str:

        from grok_register_ttk import _get_page

        page = _get_page()
        try:
            ua = page.run_js("return navigator.userAgent || ''")
            return str(ua or "").strip()
        except Exception:
            return ""

    def read_captured_castle(self) -> str:
        from grok_register_ttk import _get_page

        # Prefer CDP side-channel first (binary gRPC postData)
        cdp = self._poll_cdp_castle()
        if cdp and len(cdp) >= 1000:
            return cdp
        if cdp and len(cdp) >= 800 and cdp.startswith("IBYIll"):
            return cdp

        page = _get_page()
        try:
            data = page.run_js(
                """
const list = window.__hybrid_castles || [];
let best = window.__hybrid_castle || '';
for (const t of list) {
  if (String(t||'').length > String(best||'').length) best = t;
}
return {
  castle: String(best||''),
  n: list.length,
  net: (window.__hybrid_net||[]).length,
  seen: !!window.__hybrid_create_email_seen,
  ok: !!window.__hybrid_create_email_ok,
  status: Number(window.__hybrid_create_email_status||0)
};
"""
            )
            if isinstance(data, dict):
                c = str(data.get("castle") or "")
                if len(c) >= 1000 and c.startswith("IBYIll"):
                    return c
                if len(c) >= 2000:
                    return c
                if len(c) >= 800 and c.startswith("IBYIll"):
                    return c
        except Exception:
            pass
        if cdp and len(cdp) >= 800:
            return cdp
        return ""


    def _kick_page_castle_mint(self, page) -> None:
        """Try native/page Castle APIs before clicking 注册.

        Logs show CreateEmail body ~33B (email only) when React submits before
        useCastle() finishes. Kick mint early so IBYIll may land in hooks/DOM.
        """
        if page is None:
            return
        pk = ""
        try:
            pk = self._extract_castle_pk() or ""
        except Exception:
            pk = ""
        try:
            page.run_js(
                r"""
const pk = String(arguments[0] || '');
window.__hybrid_castle = window.__hybrid_castle || '';
window.__hybrid_castles = window.__hybrid_castles || [];
window.__hybrid_castle_status = window.__hybrid_castle_status || '';
function pushTok(t) {
  const s = String(t || '');
  // Only long IBYIll counts (forum); short junk must not pollute status
  if (s.indexOf('IBYIll|') !== 0 || s.length < 800) return;
  window.__hybrid_castle = s;
  window.__hybrid_castles.push(s);
  window.__hybrid_castle_status = 'native-ish';
}
function tryMintUnderscore() {
  try {
    if (typeof window._castle !== 'function') return false;
    try { window._castle('setAppId', pk); } catch (e0) {
      try { window._castle('configure', { pk: pk }); } catch (e1) {}
    }
    window.__hybrid_castle_status = 'minting:_castle';
    Promise.resolve(window._castle('createRequestToken')).then(function (t) {
      pushTok(t);
    }).catch(function (e) {
      window.__hybrid_castle_err = String(e);
      window.__hybrid_castle_status = 'error:_castle';
    });
    return true;
  } catch (e) {
    return false;
  }
}
function tryMint(api, label) {
  try {
    let a = api;
    if (a && a.default) a = a.default;
    if (a && typeof a.configure === 'function' && pk) {
      try { a.configure({ pk: pk }); } catch (e0) {}
    }
    let fn = null;
    if (a && typeof a.createRequestToken === 'function') fn = a.createRequestToken.bind(a);
    if (!fn && typeof api === 'function') {
      try {
        const inst = pk ? api({ pk: pk }) : api();
        if (inst && typeof inst.createRequestToken === 'function')
          fn = inst.createRequestToken.bind(inst);
      } catch (e1) {}
    }
    if (!fn) return false;
    window.__hybrid_castle_status = 'minting:' + label;
    Promise.resolve(fn()).then(function (t) { pushTok(t); }).catch(function (e) {
      window.__hybrid_castle_err = String(e);
      window.__hybrid_castle_status = 'error:' + label;
    });
    return true;
  } catch (e) {
    return false;
  }
}
// 1) official CDN v2 API first
let hit = tryMintUnderscore();
// 2) legacy globals (often absent on accounts.x.ai)
const g = [window.Castle, window.castle, window['@castleio/castle-js']];
for (let i = 0; i < g.length; i++) {
  if (g[i] && tryMint(g[i], 'global' + i)) hit = true;
}
// 2) webpack module cache scan (best-effort; no CDN inject)
try {
  const keys = Object.keys(window).filter(function (k) {
    return /^webpackChunk|^__NEXT_DATA__|^__webpack/.test(k);
  });
  // walk require.cache-like if present
  if (typeof window.webpackChunk_N_E !== 'undefined') {
    /* Next may not expose castle here */
  }
} catch (e) {}
// 3) hidden inputs / data attributes already filled by React
try {
  for (const el of document.querySelectorAll('input,textarea,[data-castle]')) {
    const v = String((el.value || el.getAttribute('data-castle') || el.textContent || ''));
    if (v.indexOf('IBYIll|') === 0 && v.length > 200) pushTok(v);
  }
} catch (e) {}
// 4) nudge React: focus email + input event (useCastle often ties to field activity)
try {
  const input = document.querySelector(
    'input[data-testid="email"], input[name="email"], input[type="email"]'
  );
  if (input) {
    input.focus();
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }
} catch (e) {}
return {
  hit: hit,
  status: String(window.__hybrid_castle_status || ''),
  len: String(window.__hybrid_castle || '').length
};
""",
                pk,
            )
        except Exception as e:
            self._lg(f"[Debug] kick castle mint: {e}")

    def _wait_castle_ready_before_submit(self, page, max_wait: float = 10.0) -> None:
        """Kick mint + poll for long IBYIll castle before clicking 注册.

        Sites often have no window.Castle (sdk=False). AA logs show 10s+8s waits
        with len=0 forever — early-abort after a short probe to save ~15–20s/round.
        """
        try:
            self._kick_page_castle_mint(page)
        except Exception:
            pass
        max_wait = max(1.0, float(max_wait or 10))
        deadline = time.time() + max_wait
        last = ""
        kicked = 1
        saw_sdk_or_mint = False
        empty_polls = 0
        while time.time() < deadline:
            try:
                data = page.run_js(
                    r"""
let best = '';
try {
  if (window.__hybrid_castle) best = String(window.__hybrid_castle);
  for (const t of (window.__hybrid_castles||[])) {
    if (String(t||'').length > best.length) best = String(t);
  }
} catch (e) {}
try {
  for (const el of document.querySelectorAll('input,textarea')) {
    const v = String(el.value || '');
    if (v.includes('IBYIll|') && v.length > best.length) best = v;
  }
} catch (e) {}
let sdk = false;
try {
  const C = window.Castle || window.castle || null;
  sdk = !!(C && (C.createRequestToken || (C.default && C.default.createRequestToken)));
} catch (e) {}
return {
  len: best.length,
  head: best.slice(0, 12),
  sdk: sdk,
  status: String(window.__hybrid_castle_status || '')
};
"""
                )
                if isinstance(data, dict):
                    ln = int(data.get("len") or 0)
                    sdk = bool(data.get("sdk"))
                    st = str(data.get("status") or "")
                    s = f"len={ln} sdk={sdk} st={st}"
                    if s != last:
                        self._lg(f"[*] pre-submit castle wait: {s}")
                        last = s
                    if sdk or st.startswith("minting") or st in ("native-ish", "minted", "done"):
                        saw_sdk_or_mint = True
                    if ln >= 1000 and str(data.get("head") or "").startswith("IBYIll"):
                        self._lg(f"[*] pre-submit castle ready len={ln}")
                        return
                    if ln >= 2000:
                        self._lg(f"[*] pre-submit castle ready (long) len={ln}")
                        return
                    if ln < 40 and not sdk and not st.startswith("minting"):
                        empty_polls += 1
                        # ~1.2s of empty polls with no SDK → bail early
                        if empty_polls >= 4 and not saw_sdk_or_mint:
                            self._lg(
                                "[*] pre-submit castle: no page SDK / token — "
                                "skip long wait (site may send CreateEmail without castle)"
                            )
                            return
                    else:
                        empty_polls = 0
                        # mid-wait re-kick only when SDK or mint activity exists
                        if (
                            kicked < 2
                            and saw_sdk_or_mint
                            and ln < 800
                            and (deadline - time.time()) < (max_wait * 0.45)
                        ):
                            self._kick_page_castle_mint(page)
                            kicked += 1
            except Exception:
                pass
            time.sleep(0.3)

    def _click_register_button(self, page) -> str:
        try:
            return str(
                page.run_js(
                    r"""
function isVisible(node) {
  if (!node) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function btnText(node) {
  return [
    node.innerText, node.textContent, node.getAttribute('aria-label'), node.getAttribute('value')
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
function isSocial(t) {
  const c = String(t || '').replace(/\s+/g, '').toLowerCase();
  return c.includes('google') || c.includes('apple') || c.includes('github') || c.includes('microsoft')
    || c.includes('withx') || c.includes('twitter') || c.includes('withemail') || c.includes('withe-mail');
}
function scoreSubmit(node) {
  const raw = btnText(node);
  const c = raw.replace(/\s+/g, '');
  const t = c.toLowerCase();
  if (isSocial(raw)) return -1;
  if (c === '注册' || t === 'signup' || t === 'register') return 100;
  if (c.includes('注册') && !c.includes('邮箱')) return 90;
  if (t === 'continue' || c === '继续' || t === 'next' || c === '下一步') return 85;
  if (node.type === 'submit') return 70;
  if (t.includes('continue') || t.includes('next') || t.includes('submit')) return 60;
  // exact-ish sign up only — never "sign up with …"
  if (t === 'signup' || (t.includes('signup') && !t.includes('with'))) return 80;
  return 0;
}
const buttons = Array.from(document.querySelectorAll('button[type="submit"], button, [role="button"], input[type="submit"]'))
  .filter((node) => isVisible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
const ranked = buttons.map((n) => ({ n, s: scoreSubmit(n) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
const submitButton = ranked.length ? ranked[0].n : null;
if (!submitButton) {
  const input = document.querySelector('input[type="email"], input[name="email"], input[data-testid="email"]');
  const form = input && input.closest('form');
  if (form) {
    if (form.requestSubmit) form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return 'form-submit';
  }
  return 'no-button';
}
submitButton.focus();
submitButton.click();
return 'submitted:' + btnText(submitButton).slice(0, 40);
"""
                )
                or ""
            )
        except Exception as e:
            return f"click-err:{e}"


    def harvest_castle_via_email_submit(self, email: str, timeout: int = 40) -> str:
        """Trigger React useCastle() by submitting email in UI; capture ~14KB token.

        Aligns fill/submit with Plan A (fill_email_and_submit): native value setter,
        blur, short settle, then click 注册 (not 继续/Continue which may match wrong btn).
        """
        from grok_register_ttk import _get_page

        if not self._hooked:
            self.install_network_hook()
        else:
            # re-assert hook after SPA navigations
            try:
                page0 = _get_page()
                st = page0.run_js("return !!window.__hybrid_net_hooked;") if page0 else False
                if not st:
                    self._hooked = False
                    self.install_network_hook()
            except Exception:
                self.install_network_hook()
        page = _get_page()
        if page is None:
            self._lg("[!] harvest castle: page is None")
            return ""

        # clear previous capture state
        try:
            page.run_js(
                """
window.__hybrid_castle='';
window.__hybrid_castles=[];
window.__hybrid_net=[];
window.__hybrid_create_email_ok=false;
window.__hybrid_create_email_status=0;
window.__hybrid_create_email_seen=false;
window.__hybrid_create_email_wire=false;
window.__hybrid_create_user_meta=null;
true;
"""
            )
        except Exception:
            pass
        try:
            listen = getattr(page, "listen", None)
            if listen is not None and getattr(listen, "listening", False):
                listen.clear()
        except Exception:
            pass

        # Warm Castle CDN v2 early so createRequestToken has dwell time / telemetry.
        # cdn.castle.io is reachable via proxy; page often has no window._castle until load.
        try:
            pk = self._extract_castle_pk() or ""
            self._ensure_castle_sdk(pk)
            self._lg("[*] pre-email Castle CDN warm started (local-cache→_castle)")
            warm_deadline = time.time() + 12.0
            while time.time() < warm_deadline:
                try:
                    st = page.run_js(
                        """
return {
  len: String(window.__hybrid_castle||'').length,
  head: String(window.__hybrid_castle||'').slice(0,12),
  status: String(window.__hybrid_castle_status||''),
  has: typeof window._castle==='function',
  load: String(window.__hybrid_castle_load||''),
  err: String(window.__hybrid_castle_err||'').slice(0,80)
};
"""
                    )
                except Exception:
                    st = None
                if isinstance(st, dict):
                    ln = int(st.get("len") or 0)
                    if ln >= 1000 and str(st.get("head") or "").startswith("IBYIll"):
                        self._lg(
                            f"[*] pre-email Castle CDN ready len={ln} "
                            f"st={st.get('status')} has={st.get('has')} "
                            f"load={st.get('load')}"
                        )
                        break
                    if st.get("status") in ("sdk-fail", "error", "error:_castle"):
                        self._lg(
                            f"[*] pre-email Castle CDN fail st={st.get('status')} "
                            f"has={st.get('has')} err={st.get('err')}"
                        )
                        # retry once: clear script flag and re-ensure
                        try:
                            page.run_js("window.__hybrid_castle_script=false; true;")
                            self._ensure_castle_sdk(pk)
                        except Exception:
                            pass
                time.sleep(0.4)
            else:
                self._lg("[*] pre-email Castle CDN warm timeout (continue with React mint)")
        except Exception as we:
            self._lg(f"[Debug] pre-email Castle warm: {we}")

        # light human-like dwell + mouse nudge (Castle behavioral features)
        try:
            page.run_js(
                """
try {
  const x = 120 + Math.floor(Math.random()*400);
  const y = 160 + Math.floor(Math.random()*240);
  const t = document.elementFromPoint(x, y) || document.body;
  for (const type of ['pointermove','mousemove']) {
    t.dispatchEvent(new MouseEvent(type, {bubbles:true, clientX:x, clientY:y}));
  }
  window.scrollBy(0, 40 + Math.floor(Math.random()*80));
} catch (e) {}
true;
"""
            )
            time.sleep(0.4 + (time.time() % 0.5))
        except Exception:
            pass

        submit_result = ""
        try:
            # Phase 1: fill email — execCommand + React props (native setter alone often no-ops CreateEmail)
            filled = page.run_js(
                """
const email = arguments[0];
function isVisible(node) {
  if (!node) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function setReactEmail(input, value) {
  input.focus();
  try { input.click(); } catch (e) {}
  try { input.select(); } catch (e) {}
  let via = '';
  try {
    if (document.execCommand) {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, value);
      via = 'exec';
    }
  } catch (e) {}
  const last = input.value;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  const tracker = input._valueTracker;
  if (tracker) { try { tracker.setValue(last || ''); } catch (e) {} }
  if (setter) setter.call(input, value); else input.value = value;
  const rk = Object.keys(input).find((k) => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
  if (rk && input[rk]) {
    const p = input[rk];
    const ev = { target: input, currentTarget: input, type: 'input', bubbles: true };
    try { if (typeof p.onChange === 'function') p.onChange({ ...ev, type: 'change' }); } catch (e) {}
    try { if (typeof p.onInput === 'function') p.onInput(ev); } catch (e) {}
    via = (via ? via + '+' : '') + 'react';
  }
  try {
    input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {}
  return via || 'native';
}
const input = Array.from(document.querySelectorAll(
  'input[data-testid="email"], input[name="email"], input[type="email"], input[autocomplete="email"]'
)).find((node) => isVisible(node) && !node.disabled && !node.readOnly)
  || Array.from(document.querySelectorAll('input')).find((n) => {
      if (!isVisible(n) || n.disabled) return false;
      const meta = [n.type, n.name, n.id, n.placeholder, n.getAttribute('data-testid')].join(' ').toLowerCase();
      return meta.includes('email') || n.type === 'email';
  }) || null;
if (!input) return 'no-input';
const via = setReactEmail(input, email);
if ((input.value || '').trim() !== email) return 'fill-mismatch:' + via;
return 'filled:' + via;
""",
                email,
            )
            self._lg(f"[*] UI email fill: {filled}")
            if not str(filled or "").startswith("filled"):
                # last resort: broader helper
                filled2 = self._set_input_and_submit(email, "email")
                self._lg(f"[*] UI email fallback submit: {filled2}")
                submit_result = filled2
            else:
                # Prefer long wait when CDN/_castle is live; short bail when still absent.
                self._wait_castle_ready_before_submit(page, max_wait=8.0)
                time.sleep(0.35)
                # Phase 2: score submit (exclude Sign up with Google/Apple/email)
                clicked = self._click_register_button(page)
                submit_result = str(clicked or "")
                self._lg(f"[*] UI email for castle: {submit_result}")
        except Exception as e:
            self._lg(f"[Debug] UI email castle: {e}")
            return ""

        deadline = time.time() + max(12, min(25, int(timeout or 40)))
        last_diag = ""
        retried_submit = False
        while time.time() < deadline:
            c = self.read_captured_castle()
            if c:
                self._lg(f"[*] native castle len={len(c)} head={c[:20]}")
                # Wait briefly so fetch/XHR (or CDP) can stamp CreateEmail status.
                # Returning instantly left status=0 → hybrid force-fired a 2nd CreateEmail.
                try:
                    settle_deadline = time.time() + 2.5
                    while time.time() < settle_deadline:
                        st = page.run_js(
                            """
return {
  ok: !!window.__hybrid_create_email_ok,
  status: Number(window.__hybrid_create_email_status||0),
  seen: !!window.__hybrid_create_email_seen,
  wire: !!window.__hybrid_create_email_wire
};
"""
                        )
                        if isinstance(st, dict) and (
                            st.get("ok")
                            or int(st.get("status") or 0) == 200
                            or st.get("wire")
                        ):
                            self._lg(
                                f"[*] CreateEmail settle ok={st.get('ok')} "
                                f"status={st.get('status')} wire={st.get('wire')}"
                            )
                            break
                        time.sleep(0.2)
                    else:
                        # No status yet — mark wire if we hold long IBYIll from body
                        if len(c) >= 1000 and str(c).startswith("IBYIll"):
                            try:
                                page.run_js(
                                    """
window.__hybrid_create_email_seen = true;
window.__hybrid_create_email_wire = true;
true;
"""
                                )
                            except Exception:
                                pass
                            self._lg(
                                "[*] CreateEmail settle timeout — marked wire "
                                f"(castle_len={len(c)})"
                            )
                except Exception as se:
                    self._lg(f"[Debug] CreateEmail settle: {se}")
                return c
            # CreateEmail fired with empty castle → wait & re-click once
            if not retried_submit:
                try:
                    st = page.run_js(
                        """
const nets = window.__hybrid_net || [];
let short = false;
for (const n of nets) {
  const u = String((n && n.url) || '');
  const len = Number((n && n.len) || 0);
  if (u.includes('CreateEmailValidationCode') && len > 0 && len < 200) short = true;
}
return {
  short: short,
  seen: !!window.__hybrid_create_email_seen,
  ok: !!window.__hybrid_create_email_ok,
  status: Number(window.__hybrid_create_email_status||0)
};
"""
                    )
                    if (
                        isinstance(st, dict)
                        and st.get("short")
                        and (st.get("ok") or int(st.get("status") or 0) == 200)
                    ):
                        retried_submit = True
                        # Site accepted castle-less CreateEmail (body ~33B, HTTP 200).
                        # Re-click only if page suddenly exposes SDK / long token.
                        has_sdk = False
                        try:
                            probe = page.run_js(
                                r"""
let sdk = false;
try {
  const C = window.Castle || window.castle || null;
  sdk = !!(C && (C.createRequestToken || (C.default && C.default.createRequestToken)));
} catch (e) {}
return {
  sdk: sdk,
  clen: String(window.__hybrid_castle || '').length,
  st: String(window.__hybrid_castle_status || '')
};
"""
                            )
                            if isinstance(probe, dict):
                                has_sdk = bool(probe.get("sdk")) or int(
                                    probe.get("clen") or 0
                                ) >= 800
                        except Exception:
                            has_sdk = False
                        if not has_sdk:
                            self._lg(
                                "[!] CreateEmail body short (no castle) but browser OK — "
                                "skip re-click (no page Castle SDK)"
                            )
                        else:
                            self._lg(
                                "[!] CreateEmail body too short (no castle); "
                                "kick mint + wait + re-click 注册 once"
                            )
                            try:
                                self._kick_page_castle_mint(page)
                            except Exception:
                                pass
                            time.sleep(0.8)
                            self._wait_castle_ready_before_submit(page, max_wait=4.0)
                            pre = self.read_captured_castle()
                            if pre and len(pre) >= 800:
                                self._lg(
                                    f"[*] re-submit with pre-mint castle len={len(pre)}"
                                )
                            r2 = self._click_register_button(page)
                            self._lg(f"[*] UI email re-submit: {r2}")
                            submit_result = f"{submit_result}|retry:{r2}"
                except Exception as re:
                    retried_submit = True
                    self._lg(f"[Debug] re-submit: {re}")
            # periodic diagnostics (throttled via last_diag string)
            try:
                diag = page.run_js(
                    """
return {
  net: (window.__hybrid_net||[]).length,
  nCastle: (window.__hybrid_castles||[]).length,
  clen: (window.__hybrid_castle||'').length,
  seen: !!window.__hybrid_create_email_seen,
  ok: !!window.__hybrid_create_email_ok,
  status: Number(window.__hybrid_create_email_status||0),
  hooked: !!window.__hybrid_net_hooked,
  url: location.href.slice(0, 120)
};
"""
                )
                if isinstance(diag, dict):
                    s = (
                        f"net={diag.get('net')} castles={diag.get('nCastle')} "
                        f"clen={diag.get('clen')} seen={diag.get('seen')} "
                        f"ok={diag.get('ok')} st={diag.get('status')} "
                        f"hooked={diag.get('hooked')}"
                    )
                    if s != last_diag and (
                        diag.get("seen")
                        or diag.get("net")
                        or int(diag.get("clen") or 0) > 0
                    ):
                        self._lg(f"[*] castle wait: {s}")
                        last_diag = s
            except Exception:
                pass
            time.sleep(0.35)

        # Final diagnostic dump before fallback
        try:
            diag = page.run_js(
                """
const nets = (window.__hybrid_net||[]).slice(-8);
return {
  net: nets,
  nCastle: (window.__hybrid_castles||[]).length,
  clen: (window.__hybrid_castle||'').length,
  seen: !!window.__hybrid_create_email_seen,
  ok: !!window.__hybrid_create_email_ok,
  status: Number(window.__hybrid_create_email_status||0),
  hooked: !!window.__hybrid_net_hooked,
  submit: String(arguments[0]||'')
};
""",
                submit_result,
            )
            self._lg(f"[!] native castle timeout diag={diag}")
        except Exception as e:
            self._lg(f"[!] native castle timeout ({e})")

        # CreateEmail 可能已 200 且 body 无 castle（站点侧可不带 token）。
        # 返回空串，由 hybrid 根据 create_email_sent_via_browser() 决定是否继续。
        try:
            st = page.run_js(
                """
return {
  ok: !!window.__hybrid_create_email_ok,
  status: Number(window.__hybrid_create_email_status||0),
  seen: !!window.__hybrid_create_email_seen
};
"""
            )
            if isinstance(st, dict) and (
                st.get("ok") or int(st.get("status") or 0) == 200
            ):
                self._lg(
                    f"[!] no castle in CreateEmail body but browser status "
                    f"ok={st.get('ok')} status={st.get('status')} → continue without castle"
                )
                return ""
        except Exception:
            pass
        self._lg(
            "[!] native castle timeout; no browser CreateEmail success either → empty"
        )
        # UI click never produced CreateEmail — force RPC from page context.
        try:
            fr = self.force_create_email_via_page(email, timeout=18)
            if isinstance(fr, dict) and fr.get("ok"):
                self._lg("[*] force CreateEmail OK after UI miss")
                return ""
            self._lg(f"[!] force CreateEmail after UI miss: {fr}")
        except Exception as fe:
            self._lg(f"[!] force CreateEmail exception: {fe}")
        return ""

    def get_castle_token_injected(self, timeout: int = 45) -> str:
        """Legacy CDN inject path (often short / wrong format)."""
        return self._get_castle_token_injected_impl(timeout=timeout)

    def close(self):
        if self.keep_alive or self.reuse:
            self._lg("[*] BrowserTokenSession keep_alive — not shutting down browser")
            self._started = False
            return
        from grok_register_ttk import shutdown_browser

        try:
            shutdown_browser()
        except Exception:
            pass
        self._started = False

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.close()
        return False

    def open_signup(self):
        from grok_register_ttk import open_signup_page

        open_signup_page(log_callback=self.log)

    def export_cookies(self) -> dict:
        from grok_register_ttk import _get_browser

        jar = {}
        try:
            browser = _get_browser()
            cookies = browser.cookies() if browser else []
            for c in cookies or []:
                if isinstance(c, dict):
                    n, v = c.get("name", ""), c.get("value", "")
                else:
                    n, v = getattr(c, "name", ""), getattr(c, "value", "")
                if n:
                    jar[str(n)] = str(v)
        except Exception as e:
            self._lg(f"[Debug] export_cookies: {e}")
        return jar

    def scrape_next_action(self) -> str:
        """Scrape sign-up Server Action id from live page scripts / loaded chunks.

        Prefer createServerReference bound near createUserAndSession / emailValidationCode.
        """
        from grok_register_ttk import _get_page

        page = _get_page()
        if page is None:
            return ""
        try:
            action = page.run_js(
                r"""
function pickFromText(t) {
  if (!t) return '';
  // named CSR: createServerReference("hash", ..., "default"|createUser...)
  let m = t.match(/createServerReference\)\("([a-f0-9]{40,})"[^)]{0,260},"([A-Za-z0-9_]+)"\)/);
  if (m) return m[1];
  const keys = ['createUserAndSessionRequest', 'emailValidationCode', 'createUserAndSession'];
  for (const key of keys) {
    const idx = t.indexOf(key);
    if (idx < 0) continue;
    const slice = t.slice(Math.max(0, idx - 500), idx + 500);
    m = slice.match(/createServerReference\)\("([a-f0-9]{40,})"/);
    if (m) return m[1];
    m = slice.match(/["']([a-f0-9]{40,64})["']/);
    if (m) return m[1];
  }
  m = t.match(/next-action["'\s:=]+([a-f0-9]{40,})/i);
  return m ? m[1] : '';
}
const html = document.documentElement.innerHTML || '';
let hit = pickFromText(html);
if (hit) return hit;
for (const s of Array.from(document.scripts || [])) {
  hit = pickFromText(s.textContent || s.innerText || '');
  if (hit) return hit;
  const src = s.src || '';
  if (src && /_next\/static\/chunks\//.test(src)) {
    // mark for async fetch via performance resources is handled in Python fallback
  }
}
return '';
"""
            )
            act = str(action or "").strip()
            if act:
                return act
        except Exception:
            pass
        # Fallback: fetch a few page chunk URLs via page fetch (uses browser proxy/cookies)
        try:
            act2 = page.run_js(
                r"""
return (async () => {
  const html = document.documentElement.innerHTML || '';
  const chunks = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"'\\s]+\.js/g)).map(m => m[0]);
  const uniq = [...new Set(chunks)].slice(0, 20);
  const keys = ['createUserAndSessionRequest', 'emailValidationCode', 'castleRequestToken'];
  for (const c of uniq) {
    try {
      const url = c.startsWith('http') ? c : (location.origin + c);
      const t = await (await fetch(url, {credentials: 'same-origin'})).text();
      if (!keys.some(k => t.includes(k))) continue;
      let m = t.match(/createServerReference\)\("([a-f0-9]{40,})"[^)]{0,260},"([A-Za-z0-9_]+)"\)/);
      if (m) return m[1];
      m = t.match(/createServerReference\)\("([a-f0-9]{40,})"/);
      if (m) return m[1];
    } catch (e) {}
  }
  return '';
})();
"""
            )
            # Drission may not await; if promise-like, try CDP
            if act2 and not str(act2).startswith("{") and len(str(act2)) >= 40:
                return str(act2).strip()
        except Exception:
            pass
        try:
            res = page.run_cdp(
                "Runtime.evaluate",
                expression=r"""
(async () => {
  const html = document.documentElement.innerHTML || '';
  const chunks = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"'\\s]+\.js/g)).map(m => m[0]);
  const uniq = [...new Set(chunks)].slice(0, 24);
  const keys = ['createUserAndSessionRequest', 'emailValidationCode', 'castleRequestToken'];
  for (const c of uniq) {
    try {
      const url = c.startsWith('http') ? c : (location.origin + c);
      const t = await (await fetch(url, {credentials: 'same-origin'})).text();
      if (!keys.some(k => t.includes(k))) continue;
      let m = t.match(/createServerReference\)\("([a-f0-9]{40,})"[^)]{0,260},"([A-Za-z0-9_]+)"\)/);
      if (m) return m[1];
      m = t.match(/createServerReference\)\("([a-f0-9]{40,})"/);
      if (m) return m[1];
    } catch (e) {}
  }
  return '';
})()
""",
                awaitPromise=True,
                returnByValue=True,
            )
            val = (res or {}).get("result", {}).get("value") or ""
            if val and len(str(val)) >= 40:
                return str(val).strip()
        except Exception:
            pass
        return ""

    def _extract_castle_pk(self) -> str:
        from grok_register_ttk import _get_page

        page = _get_page()
        try:
            pk = page.run_js(
                r"""
const html = document.documentElement.innerHTML || '';
const patterns = [
  /"castlePk":"([^"]+)"/,
  /castlePk\\":\\"([^\\"]+)/,
  /castlePk["']?\s*[:=]\s*["'](pk_[^"']+)/,
];
for (const p of patterns) {
  const m = html.match(p);
  if (m && m[1]) return m[1];
}
return '';
"""
            )
            if pk and str(pk).startswith("pk_"):
                return str(pk)
        except Exception as e:
            self._lg(f"[Debug] castle pk: {e}")
        return "pk_p8GGWvD3TmFJZRsX3BQcqAv9aFVispNz"

    def _local_castle_sdk_source(self) -> str:
        """Prefer local data/cf-cache/castle_v2.js (forum: avoid cross-origin CDN block)."""
        candidates = [
            Path(__file__).resolve().parent.parent / "data" / "cf-cache" / "castle_v2.js",
            Path(__file__).resolve().parent / "data" / "cf-cache" / "castle_v2.js",
        ]
        for p in candidates:
            try:
                if p.is_file() and p.stat().st_size > 5000:
                    return p.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
        # One-shot download into first candidate path
        try:
            dest = candidates[0]
            dest.parent.mkdir(parents=True, exist_ok=True)
            import urllib.request
            url = (
                "https://cdn.castle.io/v2/castle.js"
                "?pk=pk_p8GGWvD3TmFJZRsX3BQcqAv9aFVispNz"
            )
            urllib.request.urlretrieve(url, dest)
            if dest.is_file() and dest.stat().st_size > 5000:
                self._lg(f"[*] castle SDK downloaded → {dest} bytes={dest.stat().st_size}")
                return dest.read_text(encoding="utf-8", errors="ignore")
        except Exception as e:
            try:
                self._lg(f"[Debug] castle SDK download: {e}")
            except Exception:
                pass
        return ""

    def _ensure_castle_sdk(self, pk: str) -> bool:
        """Load Castle CDN v2 and mint via window._castle (NOT window.Castle).

        Forum (2026-07):
          _castle('setAppId', pk); _castle('createRequestToken') → IBYIll|…
        Prefer local data/cf-cache/castle_v2.js then fetch+(0,eval); reject short junk.
        """
        from grok_register_ttk import _get_page

        page = _get_page()
        if page is None:
            return False
        pk = (pk or "").strip() or "pk_p8GGWvD3TmFJZRsX3BQcqAv9aFVispNz"
        try:
            st = page.run_js(
                """
return {
  s: window.__hybrid_castle_status||'',
  l: String(window.__hybrid_castle||'').length,
  head: String(window.__hybrid_castle||'').slice(0,8),
  has: typeof window._castle==='function'
};
"""
            )
            if (
                isinstance(st, dict)
                and int(st.get("l") or 0) >= 1000
                and str(st.get("head") or "").startswith("IBYIll")
            ):
                return True
        except Exception:
            pass

        local_src = self._local_castle_sdk_source()
        cdn = f"https://cdn.castle.io/v2/castle.js?pk={pk}"
        try:
            page.run_js(
                r"""
const localSrc = String(arguments[0] || '');
const pk = String(arguments[1] || '');
const cdn = String(arguments[2] || '');
window.__hybrid_castle = window.__hybrid_castle || '';
window.__hybrid_castles = window.__hybrid_castles || [];
window.__hybrid_castle_status = 'loading-sdk';
window.__hybrid_castle_err = '';
function pushTok(t) {
  const s = String(t || '');
  if (s.indexOf('IBYIll|') !== 0 || s.length < 800) {
    window.__hybrid_castle_err = 'reject short/non-IBYIll len=' + s.length;
    window.__hybrid_castle_status = 'reject-short';
    return false;
  }
  window.__hybrid_castle = s;
  window.__hybrid_castles = window.__hybrid_castles || [];
  window.__hybrid_castles.push(s);
  window.__hybrid_castle_status = 'done-native';
  return true;
}
function mintWithUnderscore() {
  try {
    if (typeof window._castle !== 'function') {
      window.__hybrid_castle_status = 'no-_castle';
      return false;
    }
    try { window._castle('setAppId', pk); } catch (e0) {
      try { window._castle('configure', { pk: pk }); } catch (e1) {}
    }
    window.__hybrid_castle_status = 'minting';
    const ret = window._castle('createRequestToken');
    Promise.resolve(ret).then(function (t) {
      if (!pushTok(t)) {
        if (window.__hybrid_castle_status !== 'reject-short') {
          window.__hybrid_castle_status = 'empty';
          window.__hybrid_castle_err = 'createRequestToken empty';
        }
      }
    }).catch(function (e) {
      window.__hybrid_castle_err = String(e);
      window.__hybrid_castle_status = 'error';
    });
    return true;
  } catch (e) {
    window.__hybrid_castle_err = String(e);
    window.__hybrid_castle_status = 'exception';
    return false;
  }
}
function evalSrc(src, label) {
  try {
    (0, eval)(src);
    window.__hybrid_castle_load = label;
  } catch (eEval) {
    window.__hybrid_castle_err = 'eval:' + label + ':' + String(eEval);
    return false;
  }
  return typeof window._castle === 'function';
}
if (typeof window._castle === 'function') {
  mintWithUnderscore();
  return true;
}
if (localSrc && localSrc.length > 5000) {
  if (evalSrc(localSrc, 'local-cache')) {
    mintWithUnderscore();
    return true;
  }
}
if (window.__hybrid_castle_script) return true;
window.__hybrid_castle_script = true;
fetch(cdn, { credentials: 'omit', mode: 'cors', cache: 'force-cache' })
  .then(function (r) { return r.text(); })
  .then(function (src) {
    if (evalSrc(src, 'cdn-fetch')) {
      mintWithUnderscore();
      return;
    }
    const s = document.createElement('script');
    s.src = cdn;
    s.async = true;
    s.onload = function () { mintWithUnderscore(); };
    s.onerror = function () {
      window.__hybrid_castle_err = 'sdk script load failed';
      window.__hybrid_castle_status = 'sdk-fail';
    };
    document.head.appendChild(s);
  })
  .catch(function (e) {
    window.__hybrid_castle_err = 'fetch:' + String(e);
    const s = document.createElement('script');
    s.src = cdn;
    s.async = true;
    s.onload = function () { mintWithUnderscore(); };
    s.onerror = function () {
      window.__hybrid_castle_status = 'sdk-fail';
      window.__hybrid_castle_err = 'sdk script load failed';
    };
    document.head.appendChild(s);
  });
return true;
""",
                local_src,
                pk,
                cdn,
            )
            if local_src:
                self._lg(f"[*] castle SDK local-cache bytes={len(local_src)}")
            return True
        except Exception as e:
            self._lg(f"[Debug] ensure castle sdk: {e}")
            return False

    def _get_castle_token_injected_impl(self, timeout: int = 45) -> str:
        """Mint Castle request token via CDN v2 window._castle API."""
        from grok_register_ttk import _get_page

        page = _get_page()
        if page is None:
            return ""
        pk = self._extract_castle_pk()
        self._lg(f"[*] castle pk={pk[:20]}... (CDN v2 _castle)")
        # force reload path when previous attempt used wrong API
        try:
            page.run_js(
                "window.__hybrid_castle_script=false;"
                "if(window.__hybrid_castle_status==='loading-sdk'||window.__hybrid_castle_status==='no-method')"
                "{window.__hybrid_castle_status='';}"
                "true;"
            )
        except Exception:
            pass
        self._ensure_castle_sdk(pk)
        deadline = time.time() + timeout
        last_status = ""
        best = ""
        while time.time() < deadline:
            try:
                data = page.run_js(
                    """
let castle = '';
try {
  if (window.__hybrid_castles && window.__hybrid_castles.length) {
    for (const t of window.__hybrid_castles) {
      const s = String(t||'');
      if (s.length > castle.length) castle = s;
    }
  }
  if (window.__hybrid_castle && String(window.__hybrid_castle).length > castle.length)
    castle = String(window.__hybrid_castle);
} catch (e) {}
return {
  castle: castle || '',
  status: String(window.__hybrid_castle_status || ''),
  err: String(window.__hybrid_castle_err || ''),
  hasUnderscore: typeof window._castle === 'function',
  hasCastle: !!(window.Castle || window.castle)
};
"""
                )
                if isinstance(data, dict):
                    castle = str(data.get("castle") or "")
                    last_status = (
                        f"{data.get('status')}|{data.get('err')}|"
                        f"_castle={data.get('hasUnderscore')}|Castle={data.get('hasCastle')}"
                    )
                    # Prefer long IBYIll; accept shorter only if no better
                    if castle.startswith("IBYIll|") and len(castle) >= 800:
                        self._lg(f"[*] castle token IBYIll len={len(castle)}")
                        return castle
                    if len(castle) > len(best):
                        best = castle
                    st = str(data.get("status") or "")
                    if st in ("no-_castle", "sdk-fail", "error", "exception", "empty"):
                        page.run_js(
                            "window.__hybrid_castle_script=false; "
                            "window.__hybrid_castle_status=''; true;"
                        )
                        self._ensure_castle_sdk(pk)
            except Exception:
                pass
            time.sleep(0.45)
        if best and len(best) >= 40:
            self._lg(
                f"[*] castle token fallback len={len(best)} "
                f"head={best[:16]} last={last_status}"
            )
            return best
        self._lg(f"[!] castle token timeout last={last_status}")
        return ""

    def get_castle_token(self, timeout: int = 45) -> str:
        """Prefer native-captured IBYIll token; fallback to injected SDK."""
        c = self.read_captured_castle()
        if c:
            self._lg(f"[*] castle from capture len={len(c)}")
            return c
        return self._get_castle_token_injected_impl(timeout=timeout)

    def _extract_turnstile_sitekey(self) -> str:
        from grok_register_ttk import _get_page

        page = _get_page()
        try:
            sk = page.run_js(
                r"""
const html = document.documentElement.innerHTML || '';
const pats = [
  /"sitekey":"(0x4[^"]+)"/,
  /sitekey\\":\\"(0x4[^\\"]+)/,
  /sitekey["']?\s*[:=]\s*["'](0x4[^"']+)/i,
];
for (const p of pats) {
  const m = html.match(p);
  if (m && m[1]) return m[1];
}
const el = document.querySelector('[data-sitekey], .cf-turnstile');
if (el) {
  const v = el.getAttribute('data-sitekey') || '';
  if (v) return v;
}
return '';
"""
            )
            if sk and str(sk).startswith("0x"):
                return str(sk)
        except Exception as e:
            self._lg(f"[Debug] sitekey: {e}")
        return "0x4AAAAAAAhr9JGVDZbrZOo0"

    def inject_turnstile_widget(self, sitekey: str = "") -> bool:
        """Mount a visible Turnstile widget (aligned with main-3 inject).

        main-3 / turnstile_mint.py: fixed .cf-turnstile host top-left, explicit
        render, callback writes cf-turnstile-response + __hybrid_turnstile.
        """
        from grok_register_ttk import _get_page

        page = _get_page()
        sk = (sitekey or self._extract_turnstile_sitekey()).strip()
        self._lg(f"[*] turnstile sitekey={sk[:20]}...")
        try:
            page.run_js(
                f"""
window.__hybrid_turnstile = '';
window.__hybrid_turnstile_status = 'init';
window.__hybrid_turnstile_err = '';
(function(){{
  var sitekey = {sk!r};
  function onToken(t) {{
    var tok = String(t || '');
    window.__hybrid_turnstile = tok;
    window.__hybrid_turnstile_status = 'done';
    var i = document.querySelector('input[name="cf-turnstile-response"]');
    if (!i) {{
      i = document.createElement('input');
      i.type = 'hidden';
      i.name = 'cf-turnstile-response';
      document.body.appendChild(i);
    }}
    try {{
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(i, tok); else i.value = tok;
      i.dispatchEvent(new Event('input', {{ bubbles: true }}));
      i.dispatchEvent(new Event('change', {{ bubbles: true }}));
    }} catch (e) {{
      i.value = tok;
    }}
  }}
  function ensureHost() {{
    // 去掉页面原生/残留 widget，避免双 Turnstile 触发 300010
    try {{
      document.querySelectorAll('.cf-turnstile, [data-sitekey]').forEach(function(el) {{
        if (el && el.id !== 'hybrid-turnstile-host') {{
          try {{ el.remove(); }} catch (e1) {{
            try {{ el.innerHTML = ''; el.style.display = 'none'; }} catch (e2) {{}}
          }}
        }}
      }});
    }} catch (e0) {{}}
    var host = document.getElementById('hybrid-turnstile-host');
    if (!host) {{
      host = document.createElement('div');
      host.id = 'hybrid-turnstile-host';
      host.className = 'cf-turnstile';
      host.setAttribute('data-sitekey', sitekey);
      // 低调可见宿主（去掉红框调试样式）
      host.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483646;'
        + 'background:transparent;padding:0;border:0;width:300px;min-height:65px;'
        + 'opacity:1;visibility:visible;';
      document.body.appendChild(host);
    }} else {{
      try {{ host.innerHTML = ''; }} catch (e) {{}}
      host.className = 'cf-turnstile';
      host.setAttribute('data-sitekey', sitekey);
      host.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483646;'
        + 'background:transparent;padding:0;border:0;width:300px;min-height:65px;'
        + 'opacity:1;visibility:visible;';
    }}
    return host;
  }}
  function renderWhenReady() {{
    if (!window.turnstile || typeof turnstile.render !== 'function') {{
      window.__hybrid_turnstile_status = 'waiting-api';
      return false;
    }}
    var host = ensureHost();
    try {{
      // 若已 render 过，先 remove 避免叠多个失败控件
      try {{
        if (window.__hybrid_turnstile_wid != null && turnstile.remove) {{
          turnstile.remove(window.__hybrid_turnstile_wid);
        }}
      }} catch (e0) {{}}
      var wid = turnstile.render(host, {{
        sitekey: sitekey,
        theme: 'light',
        size: 'normal',
        retry: 'auto',
        'retry-interval': 8000,
        callback: onToken,
        'error-callback': function(code) {{
          window.__hybrid_turnstile_status = 'error';
          window.__hybrid_turnstile_err = String(code || 'error');
        }},
        'expired-callback': function() {{
          window.__hybrid_turnstile_status = 'expired';
        }}
      }});
      window.__hybrid_turnstile_wid = wid;
      window.__hybrid_turnstile_status = 'rendered';
      return true;
    }} catch (e) {{
      window.__hybrid_turnstile_status = 'render-fail';
      window.__hybrid_turnstile_err = String(e);
      return false;
    }}
  }}
  if (renderWhenReady()) return;
  if (!document.getElementById('hybrid-cf-script')) {{
    var s = document.createElement('script');
    s.id = 'hybrid-cf-script';
    // main-3: non-explicit api.js + turnstile.render (matches turnstile_mint.py)
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.async = true;
    s.onload = function(){{ setTimeout(function(){{ renderWhenReady(); }}, 800); }};
    s.onerror = function(){{ window.__hybrid_turnstile_status = 'script-fail'; }};
    document.head.appendChild(s);
  }}
  var n = 0;
  var t = setInterval(function(){{
    n += 1;
    if (renderWhenReady() || n > 50) clearInterval(t);
  }}, 250);
}})();
true;
"""
            )
            return True
        except Exception as e:
            self._lg(f"[Debug] inject turnstile: {e}")
            return False

    def _human_idle_before_turnstile(self) -> None:
        """轻量拟人：滚动 + 随机鼠标移动，降低「页面一开就点 checkbox」画像。"""
        from grok_register_ttk import _get_page
        import secrets

        page = _get_page()
        try:
            page.run_js(
                """
try {
  window.scrollTo(0, Math.floor(40 + Math.random() * 120));
  setTimeout(function(){ window.scrollTo(0, 0); }, 200);
} catch (e) {}
true;
"""
            )
        except Exception:
            pass
        try:
            from grok_register_ttk import _engine

            eng = _engine()
            fn = getattr(eng, "_cdp_human_click", None)
            # 只移动不点：在页面空白处轻微划动
            if callable(fn):
                x = 200 + secrets.randbelow(400)
                y = 180 + secrets.randbelow(200)
                # 用 mouseMoved 序列（通过点击偏移路径实现移动）
                try:
                    page.run_cdp(
                        "Input.dispatchMouseEvent",
                        type="mouseMoved",
                        x=float(x),
                        y=float(y),
                    )
                except Exception:
                    pass
        except Exception:
            pass
        time.sleep(0.6 + secrets.randbelow(9) / 10.0)

    def _read_hybrid_turnstile_state(self) -> dict:
        from grok_register_ttk import _get_page

        page = _get_page()
        try:
            st = page.run_js(
                """
var hv = String(window.__hybrid_turnstile || '').trim();
var inputs = Array.from(document.querySelectorAll('input[name="cf-turnstile-response"]'));
var iv = '';
for (const inp of inputs) {
  const v = String(inp.value || '').trim();
  if (v.length > iv.length) iv = v;
}
var api = '';
try {
  if (window.turnstile && typeof turnstile.getResponse === 'function') {
    api = String(turnstile.getResponse() || '').trim();
  }
} catch (e) {}
var host = document.getElementById('hybrid-turnstile-host')
  || document.querySelector('.cf-turnstile[data-sitekey], .cf-turnstile');
var box = null;
if (host) {
  const r = host.getBoundingClientRect();
  box = {x: r.left, y: r.top, w: r.width, h: r.height};
}
// 检测 Verification failed UI（截图红框态）
var failText = false;
try {
  const bodyText = (document.body && document.body.innerText) || '';
  failText = /verification failed|验证失败/i.test(bodyText);
} catch (e) {}
return {
  tok: hv || iv || api,
  status: String(window.__hybrid_turnstile_status || ''),
  err: String(window.__hybrid_turnstile_err || ''),
  inpLen: iv.length,
  host: !!host,
  box: box,
  failUi: !!failText
};
"""
            )
            return st if isinstance(st, dict) else {}
        except Exception:
            return {}

    def _mouse_click_turnstile_center(self) -> str:
        """Mouse click checkbox region of inject .cf-turnstile host.

        Prefer left-side checkbox coords (not pure center). main-3 also uses
        mouse path; left bias matches real Turnstile checkbox placement.
        """
        from grok_register_ttk import _get_page
        import secrets

        page = _get_page()
        try:
            box = page.run_js(
                """
const sels = [
  '#hybrid-turnstile-host',
  '.cf-turnstile[data-sitekey]',
  '.cf-turnstile',
  '[data-sitekey]'
];
for (const sel of sels) {
  const e = document.querySelector(sel);
  if (!e) continue;
  const r = e.getBoundingClientRect();
  if (r.width >= 20 && r.height >= 20) {
    // checkbox is on the left of the widget
    const ox = Math.min(42, Math.max(26, r.width * 0.12));
    return {
      x: r.left + ox,
      y: r.top + r.height * 0.5,
      w: r.width,
      h: r.height,
      sel: sel
    };
  }
}
return null;
"""
            )
        except Exception as e:
            return f"box-err:{e}"
        if not isinstance(box, dict):
            return "no-box"
        try:
            cx = float(box.get("x") or 0) + (secrets.randbelow(5) - 2)
            cy = float(box.get("y") or 0) + (secrets.randbelow(5) - 2)
            # Prefer engine CDP human click when available
            try:
                from grok_register_ttk import _engine

                eng = _engine()
                fn = getattr(eng, "_cdp_human_click", None)
                if callable(fn):
                    fn(cx, cy)
                    return f"cdp-human:{int(cx)},{int(cy)}:{box.get('sel')}"
            except Exception:
                pass
            # Local CDP path (main-3 mouse path)
            sx = cx - (25 + secrets.randbelow(20))
            sy = cy - (8 + secrets.randbelow(12))
            for i in range(1, 9):
                t = i / 8.0
                x = sx + (cx - sx) * t
                y = sy + (cy - sy) * t
                page.run_cdp(
                    "Input.dispatchMouseEvent",
                    type="mouseMoved",
                    x=float(x),
                    y=float(y),
                )
                time.sleep(0.01)
            page.run_cdp(
                "Input.dispatchMouseEvent",
                type="mousePressed",
                x=float(cx),
                y=float(cy),
                button="left",
                buttons=1,
                clickCount=1,
            )
            time.sleep(0.05)
            page.run_cdp(
                "Input.dispatchMouseEvent",
                type="mouseReleased",
                x=float(cx),
                y=float(cy),
                button="left",
                buttons=0,
                clickCount=1,
            )
            return f"cdp:{int(cx)},{int(cy)}:{box.get('sel')}"
        except Exception as e:
            return f"click-err:{e}"

    def _preflight_turnstile_network(self) -> None:
        """Warn when proxy cannot reach challenges.cloudflare.com (root cause of tokenLen=0)."""
        try:
            import urllib.request

            url = "https://challenges.cloudflare.com/turnstile/v0/api.js"
            # Prefer whatever proxy the process already uses via env; also try common local.
            proxies = []
            for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
                v = (os.environ.get(key) or "").strip()
                if v:
                    proxies.append(v)
            # register default local proxy
            proxies.append("http://127.0.0.1:2080")
            seen = set()
            for px in proxies:
                if not px or px in seen:
                    continue
                seen.add(px)
                try:
                    handler = urllib.request.ProxyHandler({"http": px, "https": px})
                    opener = urllib.request.build_opener(handler)
                    req = urllib.request.Request(url, method="GET")
                    with opener.open(req, timeout=8) as resp:
                        code = getattr(resp, "status", None) or resp.getcode()
                        self._lg(
                            f"[*] turnstile preflight via proxy {px}: HTTP {code} OK"
                        )
                        return
                except Exception as e:
                    self._lg(
                        f"[Warn] turnstile preflight FAIL via {px}: {type(e).__name__}: {e}. "
                        "若 challenges.cloudflare.com 被代理墙/白名单漏掉，"
                        "inject 会 render 但 click 后 error、tokenLen 恒为 0。"
                        "请在代理规则放行 challenges.cloudflare.com / *.cloudflare.com。"
                    )
        except Exception as e:
            self._lg(f"[Debug] turnstile preflight: {e}")

    def get_turnstile_token(
        self,
        timeout: int = 90,
        inject: bool = True,
        *,
        fast: bool = False,
        auto_wait_cap: float | None = None,
    ) -> str:
        from grok_register_ttk import _get_page, getTurnstileToken

        page = _get_page()
        # One-shot network warning (avoid spam on short-path retry)
        if not getattr(self, "_ts_preflight_done", False):
            self._ts_preflight_done = True
            self._preflight_turnstile_network()
        inject_failed_hard = False
        last_err_code = ""
        # 无论是否 inject：先拟人停顿（贴近手动打开注册页）
        try:
            self._human_idle_before_turnstile()
        except Exception:
            pass
        if not inject:
            # 原生 managed：只等自动 token + 最多一次 shadow，不 inject、不 CDP 狂点
            self._lg("[*] turnstile mode=native (no inject)")
            deadline = time.time() + max(12.0, float(timeout or 50))
            clicks = 0
            while time.time() < deadline:
                st = self._read_hybrid_turnstile_state()
                val = str(st.get("tok") or "").strip()
                if len(val) >= 80:
                    self._lg(f"[*] turnstile native token len={len(val)}")
                    return val
                # 中段试一次 shadow（手动有时要点一下）
                elapsed = float(timeout or 50) - (deadline - time.time())
                if clicks < 1 and elapsed >= 8.0:
                    try:
                        from grok_register_ttk import _engine
                        eng = _engine()
                        fn = getattr(eng, "_try_turnstile_shadow_click_main2", None)
                        if callable(fn) and fn():
                            clicks += 1
                            self._lg("[*] turnstile native shadow-click ok")
                            time.sleep(2.0)
                            continue
                    except Exception:
                        pass
                    clicks += 1
                time.sleep(0.5)
            self._lg("[!] turnstile native timeout (no token)")
            return ""
        if inject:
            # 先试页面原生 Turnstile 自动通过（不 inject、不点），有时比二次 render 更稳
            try:
                self._human_idle_before_turnstile()
                native_deadline = time.time() + (10.0 if not fast else 4.0)
                while time.time() < native_deadline:
                    st0 = self._read_hybrid_turnstile_state()
                    val0 = str(st0.get("tok") or "").strip()
                    if len(val0) >= 80:
                        self._lg(f"[*] turnstile native auto len={len(val0)}")
                        return val0
                    time.sleep(0.5)
            except Exception:
                pass
            try:
                self._human_idle_before_turnstile()
            except Exception:
                pass
            self.inject_turnstile_widget()
            # managed 优先自动通过；CDP 点 checkbox 在本环境会直接 Verification failed
            wait_inj = min(45, max(22, int(timeout or 30) // 2))
            if fast:
                wait_inj = min(20, wait_inj)
            t_end = time.time() + wait_inj
            clicks = 0
            reinjects = 0
            last_status = ""
            rendered_at = 0.0
            auto_wait_s = 22.0 if not fast else 8.0
            time.sleep(1.2)
            while time.time() < t_end:
                try:
                    st = self._read_hybrid_turnstile_state()
                    val = str(st.get("tok") or "").strip()
                    status = str(st.get("status") or "")
                    err = str(st.get("err") or "")
                    fail_ui = bool(st.get("failUi"))
                    if status and status != last_status:
                        self._lg(
                            f"[*] turnstile inject status={status} "
                            f"host={st.get('host')} inpLen={st.get('inpLen')} "
                            f"err={err!r} failUi={fail_ui} box={st.get('box')}"
                        )
                        last_status = status
                        if status == "rendered":
                            rendered_at = time.time()
                    if len(val) >= 80:
                        self._lg(
                            f"[*] turnstile inject callback len={len(val)} "
                            f"status={status}"
                        )
                        return val
                    if status in ("script-fail", "render-fail", "error", "expired") or fail_ui:
                        if status == "error" or fail_ui:
                            inject_failed_hard = True
                            last_err_code = err or last_err_code
                        if reinjects < 1 and err not in ("300010", "600010"):
                            # 300010/600010 = bot/challenge fail，重挂同一会话通常仍失败
                            reinjects += 1
                            clicks = 0
                            rendered_at = 0.0
                            self._lg(
                                f"[*] turnstile inject {status or 'failUi'} "
                                f"err={err!r} → clean reload+re-render #{reinjects} "
                                "(no CDP click this round)"
                            )
                            try:
                                self.open_signup()
                                time.sleep(1.2)
                                self._human_idle_before_turnstile()
                            except Exception as re:
                                self._lg(f"[Debug] reload signup: {re}")
                            self.inject_turnstile_widget()
                            time.sleep(1.5)
                            continue
                        self._lg(
                            f"[!] turnstile inject hard-fail err={err!r} failUi={fail_ui} — "
                            "stop re-render/CDP (300010/600010≈bot or challenge fail). "
                            "Need cleaner browser/IP or external solver."
                        )
                        break
                    # Prefer managed auto-pass
                    if status == "rendered" and rendered_at:
                        waited = time.time() - rendered_at
                        if waited < auto_wait_s:
                            time.sleep(0.45)
                            continue
                    if status in ("rendered", "waiting-api", "init") or (
                        not status and time.time() + 1 < t_end
                    ):
                        # 最多 2 次 shadow；避免 CDP 宿主坐标（本环境易 Verification failed）
                        if clicks < 2:
                            clicks += 1
                            shadow_ok = False
                            try:
                                from grok_register_ttk import _engine

                                eng = _engine()
                                fn = getattr(
                                    eng, "_try_turnstile_shadow_click_main2", None
                                )
                                if callable(fn):
                                    shadow_ok = bool(fn())
                            except Exception:
                                shadow_ok = False
                            if shadow_ok:
                                self._lg(
                                    f"[*] turnstile inject shadow-click #{clicks} ok"
                                )
                                time.sleep(3.5 if not fast else 1.5)
                            else:
                                self._lg(
                                    f"[*] turnstile inject shadow-click #{clicks} "
                                    "miss — keep waiting (no CDP)"
                                )
                                time.sleep(2.0 if not fast else 1.0)
                            continue
                except Exception as e:
                    self._lg(f"[Debug] inject poll: {e}")
                time.sleep(0.4)

        # inject 已 300010/Verification failed：禁止 getTurnstileToken 的 CDP 连点刷屏
        if inject_failed_hard:
            self._lg(
                f"[*] skip getTurnstileToken CDP path after hard-fail "
                f"err={last_err_code!r}"
            )
        else:
            page_timeout = int(timeout or 50)
            try:
                tok = getTurnstileToken(
                    timeout=page_timeout,
                    log_callback=self.log,
                    fast=bool(fast),
                    auto_wait_cap=auto_wait_cap,
                )
                if tok and len(str(tok)) >= 80:
                    return str(tok)
            except TypeError:
                try:
                    tok = getTurnstileToken(
                        timeout=page_timeout, log_callback=self.log
                    )
                    if tok and len(str(tok)) >= 80:
                        return str(tok)
                except Exception as e:
                    self._lg(f"[Debug] getTurnstileToken: {e}")
            except Exception as e:
                self._lg(f"[Debug] getTurnstileToken: {e}")

        if inject_failed_hard:
            self._lg("[*] skip late CDP clicks after inject hard-fail")
        else:
            deadline = time.time() + max(5, min(20, int(timeout or 50)))
            retry_clicks = 0
            while time.time() < deadline:
                try:
                    st = self._read_hybrid_turnstile_state()
                    val = str(st.get("tok") or "").strip()
                    status = str(st.get("status") or "")
                    if len(val) >= 80:
                        self._lg(f"[*] turnstile len={len(val)} status={status}")
                        return val
                    if status in ("script-fail", "render-fail") and inject:
                        self.inject_turnstile_widget()
                    if inject and retry_clicks < 1:
                        # 只 shadow 一次
                        try:
                            from grok_register_ttk import _engine

                            eng = _engine()
                            fn = getattr(eng, "_try_turnstile_shadow_click_main2", None)
                            if callable(fn) and fn():
                                retry_clicks += 1
                                self._lg("[*] turnstile late shadow-click ok")
                        except Exception:
                            pass
                except Exception:
                    pass
                time.sleep(1)
        # 外置 Solver / YesCaptcha 兜底（设置页开关或 env）
        try:
            from turnstile_solver_client import solve_turnstile, solver_enabled, yescaptcha_key

            if solver_enabled() or yescaptcha_key():
                self._lg("[*] turnstile page miss → external solver…")
                sk = ""
                try:
                    sk = self._extract_turnstile_sitekey() or ""
                except Exception:
                    sk = ""
                ext = solve_turnstile(
                    siteurl="https://accounts.x.ai/sign-up",
                    sitekey=sk,
                    max_wait=min(90, max(30, int(timeout or 50))),
                    log=self._lg,
                )
                if ext and len(str(ext)) >= 80:
                    self._lg(f"[*] turnstile external len={len(ext)}")
                    return str(ext)
        except Exception as ee:
            self._lg(f"[Debug] external turnstile: {ee}")
        self._lg("[!] turnstile timeout")
        return ""

    def _set_input_and_submit(self, value: str, kind: str) -> str:
        """Fill visible email/code input and click continue. kind=email|code"""
        from grok_register_ttk import _get_page

        page = _get_page()
        return str(
            page.run_js(
                """
const value = String(arguments[0] || '');
const kind = String(arguments[1] || 'email');
function isVisible(node) {
  if (!node) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function setInputValue(input, v) {
  input.focus(); input.click();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  const tracker = input._valueTracker;
  if (tracker) tracker.setValue('');
  if (setter) setter.call(input, v); else input.value = v;
  input.dispatchEvent(new Event('focus', {bubbles:true}));
  input.dispatchEvent(new InputEvent('beforeinput', {bubbles:true, data:v, inputType:'insertText'}));
  input.dispatchEvent(new InputEvent('input', {bubbles:true, data:v, inputType:'insertText'}));
  input.dispatchEvent(new Event('change', {bubbles:true}));
  input.dispatchEvent(new Event('blur', {bubbles:true}));
}
let input = null;
if (kind === 'email') {
  input = Array.from(document.querySelectorAll('input, textarea')).find((node) => {
    if (!isVisible(node) || node.disabled) return false;
    const type = String(node.getAttribute('type') || '').toLowerCase();
    if (['password','hidden','checkbox','radio','submit','button'].includes(type)) return false;
    const meta = [node.getAttribute('data-testid'), node.name, node.id, node.placeholder, type].join(' ').toLowerCase();
    return meta.includes('email') || meta.includes('mail') || type === 'email';
  }) || null;
} else {
  input = Array.from(document.querySelectorAll(
    'input[data-input-otp="true"], input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[inputmode="text"]'
  )).find((node) => isVisible(node) && !node.disabled && Number(node.maxLength || 6) > 1) || null;
  if (!input) {
    const boxes = Array.from(document.querySelectorAll('input')).filter((node) => {
      if (!isVisible(node) || node.disabled) return false;
      return Number(node.maxLength || 0) === 1;
    });
    if (boxes.length >= value.length) {
      for (let i = 0; i < value.length; i++) {
        setInputValue(boxes[i], value[i] || '');
      }
      input = boxes[0];
    }
  }
}
if (!input && kind === 'email') return 'no-email-input';
if (!input && kind === 'code') return 'no-code-input';
if (kind === 'email' || Number(input.maxLength || 6) > 1) setInputValue(input, value);
const buttons = Array.from(document.querySelectorAll('button[type="submit"], button, [role="button"]'))
  .filter((node) => isVisible(node) && !node.disabled);
const submit = buttons.find((node) => {
  const t = (node.innerText || node.textContent || '').replace(/\\s+/g, '').toLowerCase();
  return t.includes('注册') || t.includes('继续') || t.includes('下一步') || t.includes('完成')
    || t.includes('continue') || t.includes('next') || t.includes('confirm') || t.includes('sign');
}) || buttons.find((n) => String(n.getAttribute('type')||'').toLowerCase()==='submit') || buttons[0];
if (submit) { submit.click(); return 'submitted'; }
return 'filled-no-button';
                """,
                value,
                kind,
            )
            or ""
        )

    def prepare_profile_step_for_turnstile(
        self, email: str, code: str, timeout: int = 90
    ) -> bool:
        """Drive UI email->code->profile so Turnstile widget mounts.

        Protocol already verified the code; UI path still needed for widget.
        Prefer staying on current tab; only reopen signup if page is dead.
        """
        from grok_register_ttk import _get_page

        clean = str(code or "").replace("-", "").strip()
        page = _get_page()
        need_reopen = page is None
        if not need_reopen:
            try:
                page.run_js("return 1")
            except Exception:
                need_reopen = True
        if need_reopen:
            try:
                from grok_register_ttk import refresh_active_page

                if callable(refresh_active_page):
                    refresh_active_page()
            except Exception:
                pass
            try:
                self.open_signup()
            except Exception as e:
                self._lg(f"[Debug] reopen signup: {e}")
            page = _get_page()

        deadline = time.time() + min(25, int(timeout or 90))  # 协议验码后勿死等 OTP 页
        email_done = code_done = False
        no_code_force = 0
        while time.time() < deadline:
            try:
                page = _get_page() or page
                if page is None:
                    time.sleep(0.5)
                    continue
                state = page.run_js(
                    r"""
function isVisible(node) {
  if (!node) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
const pw = Array.from(document.querySelectorAll('input[type="password"], input[name="password"]')).some(isVisible);
const cf = !!document.querySelector('input[name="cf-turnstile-response"], div.cf-turnstile, iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"]');
const email = Array.from(document.querySelectorAll('input[type="email"], input[name="email"], input[data-testid="email"]')).some(isVisible);
const code = Array.from(document.querySelectorAll('input[data-input-otp="true"], input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]')).some(isVisible)
  || Array.from(document.querySelectorAll('input')).filter(n => isVisible(n) && Number(n.maxLength||0)===1).length >= 4;
const given = Array.from(document.querySelectorAll('input[name="givenName"], input[name="familyName"], input[autocomplete="given-name"]')).some(isVisible);
return {pw:!!pw, cf:!!cf, email:!!email, code:!!code, given:!!given, url: location.href};
"""
                )
            except Exception as e:
                self._lg(f"[Debug] profile state: {e}")
                time.sleep(0.6)
                continue

            if isinstance(state, dict) and (
                state.get("pw") or state.get("cf") or state.get("given")
            ):
                self._lg(f"[*] profile/turnstile ready state={state}")
                return True

            if isinstance(state, dict) and state.get("email") and not email_done:
                r = self._set_input_and_submit(email, "email")
                self._lg(f"[*] UI email submit: {r}")
                email_done = True
                time.sleep(1.5)
                continue

            if isinstance(state, dict) and state.get("code") and not code_done:
                r = self._set_input_and_submit(clean, "code")
                self._lg(f"[*] UI code submit: {r}")
                code_done = True
                time.sleep(2.0)
                continue

            if (
                isinstance(state, dict)
                and not code_done
                and clean
                and not state.get("pw")
                and not state.get("given")
            ):
                try:
                    r = self._set_input_and_submit(clean, "code")
                    self._lg(f"[*] UI code force submit: {r}")
                    if r and "no-code" not in str(r):
                        code_done = True
                        time.sleep(2.0)
                        continue
                    no_code_force += 1
                    # 协议已 VerifyEmail 时页面常无 OTP；再 force 只会刷屏
                    if no_code_force >= 2:
                        # cf 已挂载则视为可求解（不必强行等 profile 表单）
                        try:
                            st2 = page.run_js(
                                """
return {
  cf: !!document.querySelector(
    'input[name="cf-turnstile-response"], div.cf-turnstile, [data-sitekey],'
    + 'iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"]'
  ),
  api: typeof turnstile !== 'undefined'
};
"""
                            )
                        except Exception:
                            st2 = {}
                        if isinstance(st2, dict) and (st2.get("cf") or st2.get("api")):
                            self._lg(
                                "[!] no OTP UI (protocol verify path) — "
                                f"Turnstile present cf={st2.get('cf')} api={st2.get('api')}, "
                                "ready for inject/solve"
                            )
                            return True
                        self._lg(
                            "[!] no OTP UI (protocol verify path) — "
                            "skip profile prep, use inject Turnstile"
                        )
                        return False
                except Exception:
                    no_code_force += 1
                    if no_code_force >= 2:
                        return False

            if isinstance(state, dict) and not state.get("email") and not state.get("code"):
                try:
                    from grok_register_ttk import click_email_signup_button

                    click_email_signup_button(timeout=5, log_callback=self.log)
                except Exception:
                    pass
            time.sleep(0.8)
        self._lg("[!] profile step timeout")
        return False

    def submit_create_user_server_action(
        self,
        *,
        email: str,
        code: str,
        given_name: str,
        family_name: str,
        password: str,
        turnstile_token: str,
        castle_token: str,
        next_action: str = "",
        conversion_id: str = "",
        timeout: float = 40.0,
    ) -> dict:
        """POST CreateUser Server Action from the live page (same cookies/proxy as browser).

        Avoids curl session missing CF cookies / wrong deploy action id binding.
        Returns {ok, sso, status, text, action}.
        """
        from grok_register_ttk import _get_page
        import uuid as _uuid

        page = _get_page()
        if page is None:
            return {"ok": False, "sso": "", "status": 0, "text": "no page", "action": ""}
        act = str(next_action or self.scrape_next_action() or "").strip()
        if not act:
            return {"ok": False, "sso": "", "status": 0, "text": "no action", "action": ""}
        clean = str(code or "").replace("-", "").strip()
        conv = str(conversion_id or _uuid.uuid4())
        payload = [
            {
                "emailValidationCode": clean,
                "createUserAndSessionRequest": {
                    "email": email,
                    "givenName": given_name,
                    "familyName": family_name,
                    "clearTextPassword": password,
                    "tosAcceptedVersion": 1,
                },
                "turnstileToken": turnstile_token,
                "conversionId": conv,
                "castleRequestToken": castle_token,
            }
        ]
        import json as _json

        body = _json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        # scrape router state from page if present
        try:
            tree = page.run_js(
                r"""
const html = document.documentElement.innerHTML || '';
// flight payload often embeds f:[[[,"(app)",...sign-up...
const m = html.match(/"f":\[\[\[[\s\S]{0,800}?sign-up[\s\S]{0,400}?\]\]/);
if (m) {
  try { return encodeURIComponent(m[0].slice(5)); } catch (e) {}
}
return '';
"""
            ) or ""
        except Exception:
            tree = ""
        if not tree:
            tree = (
                "%5B%22%22%2C%7B%22children%22%3A%5B%22(app)%22%2C%7B%22children%22%3A%5B%22(auth)%22%2C%7B%22children%22%3A%5B%22sign-up%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C16%5D"
            )
        expr = f"""
(async () => {{
  const action = {act!r};
  const body = {body!r};
  const tree = {str(tree)!r};
  const url = location.href.includes('sign-up')
    ? location.href
    : 'https://accounts.x.ai/sign-up?redirect=grok-com';
  try {{
    const r = await fetch(url, {{
      method: 'POST',
      headers: {{
        'content-type': 'text/plain;charset=UTF-8',
        'accept': 'text/x-component',
        'next-action': action,
        'Next-Action': action,
        'next-router-state-tree': tree,
      }},
      body: body,
      credentials: 'include',
      redirect: 'manual',
    }});
    const text = await r.text();
    const cookie = document.cookie || '';
    let sso = '';
    const m = cookie.match(/(?:^|;\\s*)sso=([^;]+)/);
    if (m) sso = decodeURIComponent(m[1]);
    if (!sso) {{
      const m2 = cookie.match(/(?:^|;\\s*)sso-rw=([^;]+)/);
      if (m2) sso = decodeURIComponent(m2[1]);
    }}
    // also scan set-cookie-like JWT in body
    if (!sso) {{
      const jm = text.match(/(eyJ[a-zA-Z0-9_-]+\\.[a-zA-Z0-9_-]+\\.[a-zA-Z0-9_-]+)/);
      if (jm && /session|sso/i.test(text)) sso = jm[1];
    }}
    return JSON.stringify({{
      status: r.status,
      text: text.slice(0, 1500),
      sso: sso,
      action: action,
      url: url,
    }});
  }} catch (e) {{
    return JSON.stringify({{status: 0, text: String(e), sso: '', action: action}});
  }}
}})()
"""
        try:
            res = page.run_cdp(
                "Runtime.evaluate",
                expression=expr,
                awaitPromise=True,
                returnByValue=True,
            )
            raw = (res or {}).get("result", {}).get("value") or "{}"
            if isinstance(raw, dict):
                data = raw
            else:
                import json as _json2

                data = _json2.loads(str(raw))
        except Exception as e:
            self._lg(f"[!] browser server-action: {e}")
            return {"ok": False, "sso": "", "status": 0, "text": str(e), "action": act}
        sso = str(data.get("sso") or "")
        # re-export cookies in case Set-Cookie went to jar
        if not sso:
            try:
                ck = self.export_cookies() or {}
                sso = str(ck.get("sso") or ck.get("sso-rw") or "")
            except Exception:
                pass
        self._lg(
            f"[*] browser SA status={data.get('status')} sso_len={len(sso)} "
            f"action={str(act)[:16]} body={(str(data.get('text') or ''))[:80]!r}"
        )
        return {
            "ok": bool(sso),
            "sso": sso,
            "status": int(data.get("status") or 0),
            "text": str(data.get("text") or "")[:2000],
            "action": act,
        }

    def submit_profile_and_wait_sso(
        self,
        *,
        given_name: str,
        family_name: str,
        password: str,
        timeout: float = 45.0,
    ) -> str:
        """Fill profile fields + click submit; wait for sso cookie (browser-native Server Action).

        Use when protocol next-action POST returns 200/404 without Set-Cookie sso.
        """
        from grok_register_ttk import _get_page

        page = _get_page()
        if page is None:
            self._lg("[!] submit_profile: page is None")
            return ""
        given_name = str(given_name or "").strip() or "Alex"
        family_name = str(family_name or "").strip() or "Smith"
        password = str(password or "").strip()
        if not password:
            self._lg("[!] submit_profile: empty password")
            return ""

        filled = page.run_js(
            r"""
const given = arguments[0], family = arguments[1], password = arguments[2];
function isVisible(n) {
  if (!n) return false;
  const s = window.getComputedStyle(n);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  const r = n.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
function setVal(input, value) {
  if (!input) return false;
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  const tracker = input._valueTracker;
  if (tracker) { try { tracker.setValue(input.value || ''); } catch (e) {} }
  if (setter) setter.call(input, value); else input.value = value;
  const rk = Object.keys(input).find((k) => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
  if (rk && input[rk]) {
    const p = input[rk];
    const ev = { target: input, currentTarget: input, bubbles: true };
    try { if (typeof p.onChange === 'function') p.onChange({ ...ev, type: 'change' }); } catch (e) {}
    try { if (typeof p.onInput === 'function') p.onInput({ ...ev, type: 'input' }); } catch (e) {}
  }
  try {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {}
  return (input.value || '') === value;
}
const g = Array.from(document.querySelectorAll(
  'input[name="givenName"], input[autocomplete="given-name"], input[data-testid="givenName"]'
)).find(isVisible)
  || Array.from(document.querySelectorAll('input[type="text"]')).filter(isVisible)[0];
const f = Array.from(document.querySelectorAll(
  'input[name="familyName"], input[autocomplete="family-name"], input[data-testid="familyName"]'
)).find(isVisible)
  || Array.from(document.querySelectorAll('input[type="text"]')).filter(isVisible)[1];
const p = Array.from(document.querySelectorAll(
  'input[type="password"], input[name="password"], input[autocomplete="new-password"]'
)).find(isVisible);
const og = setVal(g, given);
const of = setVal(f, family);
const op = setVal(p, password);
return {og, of, op, hasG:!!g, hasF:!!f, hasP:!!p};
""",
            given_name,
            family_name,
            password,
        )
        self._lg(f"[*] profile fill: {filled}")

        # Kick CDN/page castle mint so React CreateUser may bind a fresh token
        try:
            self._kick_page_castle_mint(page)
            time.sleep(0.6)
        except Exception:
            pass

        # Prefer submit button (Create account / Sign up / Continue)
        # Include "Complete sign up" (accounts.x.ai 2026 profile CTA)
        clicked = ""
        for label in (
            "Complete sign up",
            "Complete Sign up",
            "Create account",
            "Create Account",
            "Sign up",
            "Sign Up",
            "Continue",
            "Submit",
            "注册",
            "创建账号",
            "继续",
        ):
            try:
                el = page.ele(
                    f"xpath://button[normalize-space(.)='{label}']", timeout=0.4
                )
                if el:
                    try:
                        el.click(by_js=False)
                    except Exception:
                        el.click()
                    clicked = label
                    break
            except Exception:
                continue
        if not clicked:
            try:
                clicked = page.run_js(
                    r"""
function isVisible(n) {
  if (!n) return false;
  const s = window.getComputedStyle(n);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  const r = n.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
const deny = /google|apple|github|x\.com|twitter|sign\s*in|log\s*in/i;
const ok = /complete|create|sign\s*up|continue|submit|注册|创建|继续/i;
const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).filter(isVisible);
const t = btns.find((b) => {
  const text = (b.innerText || b.value || b.textContent || '').trim();
  if (!text || deny.test(text)) return false;
  return ok.test(text);
});
if (t) { t.click(); return (t.innerText || t.value || '').trim().slice(0, 40); }
return '';
"""
                ) or ""
            except Exception as e:
                self._lg(f"[!] profile submit js: {e}")
        self._lg(f"[*] profile submit click={clicked!r}")
        # Log whether fetch-hook patched CreateUser castle/conversionId
        try:
            meta = page.run_js("return window.__hybrid_create_user_meta || null;")
            if meta:
                self._lg(f"[*] createUser wire meta: {meta}")
        except Exception:
            pass

        deadline = time.time() + max(15.0, float(timeout or 45))
        while time.time() < deadline:
            try:
                cookies = self.export_cookies() or {}
            except Exception:
                cookies = {}
            sso = str(cookies.get("sso") or cookies.get("sso-rw") or "").strip()
            if sso and len(sso) > 40:
                self._lg(f"[*] profile submit got sso len={len(sso)}")
                try:
                    meta = page.run_js("return window.__hybrid_create_user_meta || null;")
                    if meta:
                        self._lg(f"[*] createUser wire meta final: {meta}")
                except Exception:
                    pass
                return sso
            # also read document.cookie
            try:
                page = _get_page() or page
                js_sso = page.run_js(
                    r"""
const m = document.cookie.match(/(?:^|;\s*)sso=([^;]+)/);
return m ? decodeURIComponent(m[1]) : '';
"""
                )
                if js_sso and len(str(js_sso)) > 40:
                    self._lg(f"[*] profile submit sso from document.cookie len={len(str(js_sso))}")
                    return str(js_sso)
            except Exception:
                pass
            time.sleep(0.8)
        self._lg("[!] profile submit: no sso cookie")
        return ""


def harvest_tokens(
    *,
    stay_on_profile: bool = True,
    timeout: int = 90,
    log: Optional[Callable[[str], None]] = None,
) -> HarvestedTokens:
    """Backward-compatible one-shot harvest."""
    out = HarvestedTokens()
    with BrowserTokenSession(log=log) as sess:
        sess.open_signup()
        out.castle = sess.get_castle_token(timeout=min(45, timeout))
        out.turnstile = sess.get_turnstile_token(timeout=min(30, timeout)) if stay_on_profile else ""
        out.cookies = sess.export_cookies()
        out.next_action = sess.scrape_next_action()
        out.page_url = "https://accounts.x.ai/sign-up"
    return out


if __name__ == "__main__":
    t = harvest_tokens(log=print, timeout=60)
    print("turnstile_len", len(t.turnstile))
    print("castle_len", len(t.castle))
    print("cookies", list((t.cookies or {}).keys())[:10])
    print("next_action", t.next_action[:40] if t.next_action else "")
