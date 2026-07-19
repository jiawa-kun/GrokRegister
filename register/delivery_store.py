# -*- coding: utf-8 -*-
"""
交付状态机（SQLite，跨进程安全）:

  pending → uploading → success | failed
  失败可重试（后台 scan + lease 租约）

路径: $DATA_DIR/gra_store.sqlite（delivery_jobs 表）
兼容迁移: register/data/delivery_jobs.json
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from gra_sqlite import dumps_json, loads_json, now_ts, transaction

LogFn = Callable[[str], None]

_ROOT = Path(__file__).resolve().parent
_DEFAULT_PATH = _ROOT / "data" / "delivery_jobs.json"
_lock = threading.RLock()
_MIGRATE_LOCK = threading.Lock()
_MIGRATED = False

VALID_STATUS = frozenset({"pending", "uploading", "success", "failed"})
_SENSITIVE_PAYLOAD_KEYS = (
    "sso",
    "password",
    "proxy",
    "cloudflare_cookies",
    "cf_cookies",
    "token",
    "access_token",
    "refresh_token",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def store_path() -> Path:
    env = os.environ.get("DELIVERY_STORE_PATH", "").strip()
    if env:
        return Path(env)
    data = (os.environ.get("DATA_DIR") or "").strip()
    if data:
        return Path(data) / "delivery_jobs.json"
    return _DEFAULT_PATH


def _row_to_job(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "channel": str(row["channel"] or ""),
        "email": str(row["email"] or ""),
        "sso_fp": str(row["sso_fp"] or ""),
        "status": str(row["status"] or "pending"),
        "attempts": int(row["attempts"] or 0),
        "max_attempts": int(row["max_attempts"] or 5),
        "error": str(row["error"] or ""),
        "payload": loads_json(row["payload_json"]),
        "created_at": str(row["created_at"] or ""),
        "updated_at": str(row["updated_at"] or ""),
        "next_retry_at": float(row["next_retry_at"] or 0),
        "lease_owner": str(row["lease_owner"] or ""),
        "lease_until": float(row["lease_until"] or 0),
    }


def _ensure_migrated() -> None:
    global _MIGRATED
    if _MIGRATED:
        return
    with _MIGRATE_LOCK:
        if _MIGRATED:
            return
        try:
            with transaction() as conn:
                row = conn.execute("SELECT COUNT(*) AS c FROM delivery_jobs").fetchone()
                if int(row["c"] if row else 0) > 0:
                    _MIGRATED = True
                    return
                p = store_path()
                if not p.is_file():
                    # 兼容旧默认路径
                    legacy = _DEFAULT_PATH
                    p = legacy if legacy.is_file() else p
                if not p.is_file():
                    _MIGRATED = True
                    return
                try:
                    raw = json.loads(p.read_text(encoding="utf-8"))
                except Exception:
                    _MIGRATED = True
                    return
                jobs = raw.get("jobs") if isinstance(raw, dict) else None
                if not isinstance(jobs, list):
                    _MIGRATED = True
                    return
                for j in jobs:
                    if not isinstance(j, dict):
                        continue
                    jid = str(j.get("id") or uuid.uuid4().hex[:16])
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO delivery_jobs(
                          id, channel, email, sso_fp, status, attempts, max_attempts,
                          error, payload_json, created_at, updated_at, next_retry_at,
                          lease_owner, lease_until
                        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        (
                            jid,
                            str(j.get("channel") or ""),
                            str(j.get("email") or "").strip().lower(),
                            str(j.get("sso_fp") or ""),
                            str(j.get("status") or "pending"),
                            int(j.get("attempts") or 0),
                            int(j.get("max_attempts") or 5),
                            str(j.get("error") or "")[:500],
                            dumps_json(j.get("payload") if isinstance(j.get("payload"), dict) else {}),
                            str(j.get("created_at") or _now_iso()),
                            str(j.get("updated_at") or _now_iso()),
                            float(j.get("next_retry_at") or 0),
                            "",
                            0.0,
                        ),
                    )
        except Exception:
            pass
        _MIGRATED = True


def _clear_sensitive_payload(payload: dict[str, Any]) -> dict[str, Any]:
    out = dict(payload or {})
    for k in _SENSITIVE_PAYLOAD_KEYS:
        if k in out:
            out[k] = ""
    # 保留非敏感元数据
    return out


def create_job(
    *,
    channel: str,
    email: str = "",
    sso_fp: str = "",
    payload: Optional[dict[str, Any]] = None,
    max_attempts: int = 5,
) -> dict[str, Any]:
    _ensure_migrated()
    job = {
        "id": uuid.uuid4().hex[:16],
        "channel": str(channel or "").strip(),
        "email": str(email or "").strip().lower(),
        "sso_fp": str(sso_fp or "").strip(),
        "status": "pending",
        "attempts": 0,
        "max_attempts": max(1, int(max_attempts)),
        "error": "",
        "payload": payload if isinstance(payload, dict) else {},
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "next_retry_at": 0.0,
        "lease_owner": "",
        "lease_until": 0.0,
    }
    with transaction() as conn:
        conn.execute(
            """
            INSERT INTO delivery_jobs(
              id, channel, email, sso_fp, status, attempts, max_attempts,
              error, payload_json, created_at, updated_at, next_retry_at,
              lease_owner, lease_until
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                job["id"],
                job["channel"],
                job["email"],
                job["sso_fp"],
                job["status"],
                job["attempts"],
                job["max_attempts"],
                job["error"],
                dumps_json(job["payload"]),
                job["created_at"],
                job["updated_at"],
                job["next_retry_at"],
                "",
                0.0,
            ),
        )
        # 裁剪：保留最近 2000
        conn.execute(
            """
            DELETE FROM delivery_jobs WHERE id IN (
              SELECT id FROM delivery_jobs
              ORDER BY created_at DESC
              LIMIT -1 OFFSET 2000
            )
            """
        )
    return dict(job)


def update_job(
    job_id: str,
    *,
    status: Optional[str] = None,
    error: str = "",
    bump_attempt: bool = False,
    retry_after_sec: float = 0,
    extra: Optional[dict[str, Any]] = None,
    clear_payload_secrets: bool = False,
    lease_owner: Optional[str] = None,
    lease_until: Optional[float] = None,
) -> Optional[dict[str, Any]]:
    _ensure_migrated()
    with transaction() as conn:
        row = conn.execute(
            "SELECT * FROM delivery_jobs WHERE id=?", (str(job_id),)
        ).fetchone()
        if not row:
            return None
        job = _row_to_job(row)
        if status and status in VALID_STATUS:
            job["status"] = status
        if error is not None:
            job["error"] = str(error or "")[:500]
        if bump_attempt:
            job["attempts"] = int(job.get("attempts") or 0) + 1
        if retry_after_sec and retry_after_sec > 0:
            job["next_retry_at"] = time.time() + float(retry_after_sec)
        else:
            job["next_retry_at"] = 0.0
        pl = job.get("payload") if isinstance(job.get("payload"), dict) else {}
        if extra and isinstance(extra, dict):
            pl.update(extra)
        if clear_payload_secrets or status == "success":
            pl = _clear_sensitive_payload(pl)
        job["payload"] = pl
        if lease_owner is not None:
            job["lease_owner"] = str(lease_owner)
        if lease_until is not None:
            job["lease_until"] = float(lease_until)
        job["updated_at"] = _now_iso()
        conn.execute(
            """
            UPDATE delivery_jobs SET
              channel=?, email=?, sso_fp=?, status=?, attempts=?, max_attempts=?,
              error=?, payload_json=?, updated_at=?, next_retry_at=?,
              lease_owner=?, lease_until=?
            WHERE id=?
            """,
            (
                job["channel"],
                job["email"],
                job["sso_fp"],
                job["status"],
                job["attempts"],
                job["max_attempts"],
                job["error"],
                dumps_json(job["payload"]),
                job["updated_at"],
                job["next_retry_at"],
                job["lease_owner"],
                job["lease_until"],
                job["id"],
            ),
        )
        return dict(job)


def list_retryable(*, now: Optional[float] = None, limit: int = 50) -> list[dict[str, Any]]:
    """pending / failed / 过期 lease 的 uploading，且 attempts < max。"""
    _ensure_migrated()
    now = time.time() if now is None else now
    out: list[dict[str, Any]] = []
    with transaction(immediate=False) as conn:
        rows = conn.execute(
            """
            SELECT * FROM delivery_jobs
            WHERE status IN ('pending', 'failed', 'uploading')
              AND attempts < max_attempts
              AND (next_retry_at IS NULL OR next_retry_at <= ?)
              AND (lease_until IS NULL OR lease_until <= ?)
            ORDER BY updated_at ASC
            LIMIT ?
            """,
            (now, now, int(limit)),
        ).fetchall()
        for row in rows:
            job = _row_to_job(row)
            if job["status"] == "uploading":
                pl = job.get("payload") if isinstance(job.get("payload"), dict) else {}
                since = float(pl.get("_upload_since") or 0)
                lease_until = float(job.get("lease_until") or 0)
                if lease_until and lease_until > now:
                    continue
                if since and (now - since) < 900 and not lease_until:
                    continue
            out.append(job)
    return out


def claim_job(
    job_id: str,
    *,
    owner: str,
    lease_sec: float = 900.0,
) -> Optional[dict[str, Any]]:
    """任务租约：成功 claim 后才可执行，防止双 worker。"""
    _ensure_migrated()
    now = now_ts()
    until = now + max(30.0, float(lease_sec))
    with transaction() as conn:
        row = conn.execute(
            "SELECT * FROM delivery_jobs WHERE id=?", (str(job_id),)
        ).fetchone()
        if not row:
            return None
        job = _row_to_job(row)
        if int(job.get("attempts") or 0) >= int(job.get("max_attempts") or 5):
            return None
        lease_until = float(job.get("lease_until") or 0)
        if lease_until > now and str(job.get("lease_owner") or "") not in ("", owner):
            return None
        pl = job.get("payload") if isinstance(job.get("payload"), dict) else {}
        pl["_upload_since"] = now
        job["payload"] = pl
        job["status"] = "uploading"
        job["attempts"] = int(job.get("attempts") or 0) + 1
        job["lease_owner"] = owner
        job["lease_until"] = until
        job["updated_at"] = _now_iso()
        job["error"] = ""
        conn.execute(
            """
            UPDATE delivery_jobs SET
              status=?, attempts=?, error=?, payload_json=?, updated_at=?,
              lease_owner=?, lease_until=?
            WHERE id=?
            """,
            (
                job["status"],
                job["attempts"],
                "",
                dumps_json(job["payload"]),
                job["updated_at"],
                owner,
                until,
                job["id"],
            ),
        )
        return dict(job)


def mark_uploading(job_id: str) -> Optional[dict[str, Any]]:
    return update_job(
        job_id,
        status="uploading",
        bump_attempt=True,
        extra={"_upload_since": time.time()},
        lease_owner=f"pid-{os.getpid()}",
        lease_until=time.time() + 900,
    )


def mark_success(job_id: str) -> Optional[dict[str, Any]]:
    return update_job(
        job_id,
        status="success",
        error="",
        clear_payload_secrets=True,
        lease_owner="",
        lease_until=0.0,
    )


def mark_failed(job_id: str, error: str, *, retry_after_sec: float = 60) -> Optional[dict[str, Any]]:
    return update_job(
        job_id,
        status="failed",
        error=error,
        retry_after_sec=retry_after_sec,
        lease_owner="",
        lease_until=0.0,
    )


_retry_thread: Optional[threading.Thread] = None
_retry_stop = threading.Event()
_handlers: dict[str, Callable[[dict[str, Any], LogFn], bool]] = {}


def register_channel_handler(
    channel: str, handler: Callable[[dict[str, Any], LogFn], bool]
) -> None:
    _handlers[str(channel)] = handler


def _default_log(msg: str) -> None:
    print(msg, flush=True)


def process_retryable_once(log: Optional[LogFn] = None) -> int:
    log = log or _default_log
    jobs = list_retryable(limit=20)
    ok_n = 0
    owner = f"retry-{os.getpid()}-{threading.get_ident()}"
    for job in jobs:
        ch = str(job.get("channel") or "")
        handler = _handlers.get(ch)
        if not handler:
            continue
        jid = str(job.get("id"))
        claimed = claim_job(jid, owner=owner, lease_sec=900)
        if not claimed:
            continue
        try:
            ok = bool(handler(claimed, log))
        except Exception as e:
            ok = False
            mark_failed(
                jid,
                str(e)[:300],
                retry_after_sec=min(600, 30 * (int(claimed.get("attempts") or 1))),
            )
            log(f"[delivery] {ch} retry err job={jid}: {e}")
            continue
        if ok:
            mark_success(jid)
            ok_n += 1
            log(f"[delivery] ✔ {ch} job={jid} email={job.get('email') or '-'}")
        else:
            att = int(claimed.get("attempts") or 0)
            mark_failed(
                jid,
                claimed.get("error") or "handler returned false",
                retry_after_sec=min(600, 30 * max(1, att)),
            )
            log(f"[delivery] ✘ {ch} job={jid} will retry")
    return ok_n


def ensure_retry_worker(interval_sec: float = 60.0, log: Optional[LogFn] = None) -> None:
    global _retry_thread
    log = log or _default_log
    with _lock:
        if _retry_thread is not None and _retry_thread.is_alive():
            return
        _retry_stop.clear()

        def _loop() -> None:
            log(f"[delivery] 补传 worker 已启动 interval={interval_sec}s")
            while not _retry_stop.is_set():
                try:
                    process_retryable_once(log)
                except Exception as e:
                    log(f"[delivery] worker 异常: {e}")
                _retry_stop.wait(interval_sec)

        t = threading.Thread(target=_loop, name="delivery-retry", daemon=True)
        t.start()
        _retry_thread = t
