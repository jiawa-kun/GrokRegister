/**
 * 常驻 Python 任务池：stdin/stdout 按行 JSON 复用进程，避免每条 resign/mint 冷启动。
 * Worker 引导码内嵌在此文件，不依赖 register/ 热更。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type PythonPoolJob =
  | {
      op: 'resign';
      path: string;
      sso?: string;
      proxy?: string;
      pushRemote?: boolean;
      baseUrlTarget?: string;
    }
  | {
      op: 'mint';
      sso: string;
      email?: string;
      proxy?: string;
      authDir?: string;
      precheck?: boolean;
      deleteOnDead?: boolean;
      mintMode?: string;
    }
  | { op: 'ping' };

type Pending = {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Slot = {
  child: ChildProcessWithoutNullStreams;
  busy: boolean;
  queue: Array<{
    id: string;
    job: PythonPoolJob;
    pending: Pending;
  }>;
  buf: string;
  dead: boolean;
};

function buildWorkerCode(registerDir: string): string {
  // 单行引导：读 stdin JSON 行 → 派发 resign/mint → 写 stdout JSON 行
  return `
import json, sys, traceback
sys.path.insert(0, ${JSON.stringify(registerDir)})
from auth_service import resign_auth_file, sso_to_cpa_auth
from sso_probe import probe_sso

def handle(job):
    op = job.get("op") or ""
    if op == "ping":
        return {"ok": True, "pong": True}
    if op == "resign":
        return resign_auth_file(
            job.get("path") or "",
            sso=job.get("sso") or "",
            proxy=job.get("proxy") or "",
            push_remote=bool(job.get("pushRemote")),
            delete_on_dead=False,
            base_url_target=job.get("baseUrlTarget") or "cli",
        )
    if op == "mint":
        sso = job.get("sso") or ""
        email = job.get("email") or ""
        proxy = job.get("proxy") or ""
        auth_dir = job.get("authDir") or ""
        precheck = job.get("precheck") is not False
        delete_on_dead = bool(job.get("deleteOnDead"))
        mint_mode = job.get("mintMode") or "pkce"
        if precheck:
            p = probe_sso(sso, proxy="")
            if not p.get("alive"):
                return {
                    "ok": False,
                    "skipped": True,
                    "mode": "skipped_" + str(p.get("verdict") or "dead"),
                    "verdict": p.get("verdict") or "dead",
                    "error": p.get("error") or "sso not alive",
                    "email": email or p.get("email") or "",
                }
            if not email and p.get("email"):
                email = p.get("email") or email
        r = sso_to_cpa_auth(
            sso=sso,
            email=email,
            proxy=proxy,
            auth_dir=auth_dir or None,
            random_fingerprint=True,
            delete_on_dead=delete_on_dead,
            mint_mode=mint_mode,
        )
        if isinstance(r, dict):
            r.setdefault("mode", "sso_mint")
            r.setdefault("verdict", "alive")
            r["skipped"] = False
            if r.get("mint_mode"):
                r["mode"] = "sso_mint_" + str(r.get("mint_mode"))
            return r
        return {"ok": False, "error": "mint returned non-dict"}
    return {"ok": False, "error": "unknown op: " + str(op)}

while True:
    line = sys.stdin.readline()
    if not line:
        break
    line = line.strip()
    if not line:
        continue
    req_id = ""
    try:
        req = json.loads(line)
        req_id = str(req.get("id") or "")
        job = req.get("job") if isinstance(req.get("job"), dict) else req
        out = handle(job)
        if not isinstance(out, dict):
            out = {"ok": False, "error": "non-dict result"}
        out = dict(out)
        out["_id"] = req_id
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\\n")
        sys.stdout.flush()
    except Exception as e:
        err = {"ok": False, "error": str(e), "trace": traceback.format_exc()[-400:], "_id": req_id}
        try:
            sys.stdout.write(json.dumps(err, ensure_ascii=False) + "\\n")
            sys.stdout.flush()
        except Exception:
            break
`.trim();
}

const pools = new Map<string, PythonJobPool>();

function poolKey(pythonPath: string, registerDir: string): string {
  return `${pythonPath}::${registerDir}`;
}

export function getPythonJobPool(
  pythonPath: string,
  registerDir: string,
  size = 2
): PythonJobPool {
  const key = poolKey(pythonPath, registerDir);
  let p = pools.get(key);
  if (!p || p.disposed) {
    p = new PythonJobPool(pythonPath, registerDir, size);
    pools.set(key, p);
  } else if (size > p.size) {
    p.ensureSize(size);
  }
  return p;
}

export class PythonJobPool {
  readonly pythonPath: string;
  readonly registerDir: string;
  private slots: Slot[] = [];
  private readonly code: string;
  private readonly jobTimeoutMs: number;
  disposed = false;

  constructor(pythonPath: string, registerDir: string, size: number, jobTimeoutMs = 180_000) {
    this.pythonPath = pythonPath;
    this.registerDir = registerDir;
    this.code = buildWorkerCode(registerDir);
    this.jobTimeoutMs = jobTimeoutMs;
    const n = Math.min(4, Math.max(1, Math.floor(size) || 1));
    for (let i = 0; i < n; i++) this.spawnSlot();
  }

  get size(): number {
    return this.slots.filter((s) => !s.dead).length;
  }

  ensureSize(size: number): void {
    const want = Math.min(4, Math.max(1, Math.floor(size) || 1));
    const alive = this.slots.filter((s) => !s.dead).length;
    for (let i = alive; i < want; i++) this.spawnSlot();
  }

  private spawnSlot(): void {
    try {
      const child = spawn(this.pythonPath, ['-u', '-c', this.code], {
        cwd: this.registerDir,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams;

      const slot: Slot = {
        child,
        busy: false,
        queue: [],
        buf: '',
        dead: false
      };

      child.stdout.on('data', (d) => {
        slot.buf += String(d);
        const parts = slot.buf.split('\n');
        slot.buf = parts.pop() || '';
        for (const line of parts) {
          const t = line.trim();
          if (!t) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(t) as Record<string, unknown>;
          } catch {
            continue;
          }
          const id = String(msg._id || '');
          const q = slot.queue.find((x) => x.id === id) || slot.queue[0];
          if (!q) continue;
          slot.queue = slot.queue.filter((x) => x !== q);
          clearTimeout(q.pending.timer);
          const { _id, ...rest } = msg;
          void _id;
          q.pending.resolve(rest);
          slot.busy = false;
          this.pump(slot);
        }
      });

      const killPending = (err: Error) => {
        slot.dead = true;
        for (const q of slot.queue) {
          clearTimeout(q.pending.timer);
          q.pending.reject(err);
        }
        slot.queue = [];
        slot.busy = false;
      };

      child.stderr.on('data', (d) => {
        const s = String(d).trim();
        if (s) console.warn('[python-pool] stderr:', s.slice(0, 300));
      });
      child.on('error', (err) => killPending(err instanceof Error ? err : new Error(String(err))));
      child.on('close', (code) => {
        killPending(new Error(`python worker exit ${code}`));
        // 自动补位
        if (!this.disposed) {
          this.slots = this.slots.filter((s) => s !== slot);
          this.spawnSlot();
        }
      });

      this.slots.push(slot);
    } catch (err) {
      console.warn('[python-pool] spawn failed:', err);
    }
  }

  private pump(slot: Slot): void {
    if (slot.dead || slot.busy) return;
    const next = slot.queue[0];
    if (!next) return;
    slot.busy = true;
    try {
      const payload = JSON.stringify({ id: next.id, job: next.job }) + '\n';
      slot.child.stdin.write(payload);
    } catch (err) {
      slot.queue.shift();
      clearTimeout(next.pending.timer);
      next.pending.reject(err instanceof Error ? err : new Error(String(err)));
      slot.busy = false;
      this.pump(slot);
    }
  }

  run(job: PythonPoolJob): Promise<Record<string, unknown>> {
    if (this.disposed) return Promise.reject(new Error('python pool disposed'));
    const alive = this.slots.filter((s) => !s.dead);
    if (alive.length === 0) {
      this.spawnSlot();
    }
    const slots = this.slots.filter((s) => !s.dead);
    if (slots.length === 0) {
      return Promise.reject(new Error('no python workers'));
    }
    // 选队列最短的 worker
    slots.sort((a, b) => a.queue.length - b.queue.length);
    const slot = slots[0];
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.queue = slot.queue.filter((x) => x.id !== id);
        reject(new Error('python pool job timeout'));
        slot.busy = false;
        this.pump(slot);
      }, this.jobTimeoutMs);
      slot.queue.push({
        id,
        job,
        pending: { resolve, reject, timer }
      });
      this.pump(slot);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.slots) {
      s.dead = true;
      try {
        s.child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        s.child.kill();
      } catch {
        /* ignore */
      }
    }
    this.slots = [];
  }
}

/**
 * 失败原因细分：供进度汇总 / 前端复检。
 */
export function classifyAuthFailReason(input: {
  ok?: boolean;
  skipped?: boolean;
  error?: string;
  mode?: string;
  verdict?: string;
  probeHttp?: number | null;
  probeAction?: string;
}): string | undefined {
  if (input.ok) return undefined;
  const err = String(input.error || '').toLowerCase();
  const mode = String(input.mode || '').toLowerCase();
  const verdict = String(input.verdict || '').toLowerCase();
  const action = String(input.probeAction || '').toLowerCase();
  const http = Number(input.probeHttp || 0) || 0;

  if (verdict === 'banned' || mode.includes('banned') || err.includes('banned')) {
    return 'banned';
  }
  if (verdict === 'bot_flag' || mode.includes('bot_flag') || err.includes('bot_flag')) {
    return 'bot_flag';
  }
  if (http === 429 || err.includes('429') || err.includes('rate limit') || err.includes('too many')) {
    return 'rate_limit';
  }
  if (
    err.includes('timeout') ||
    err.includes('etimedout') ||
    err.includes('timed out') ||
    err.includes('aborted')
  ) {
    return 'timeout';
  }
  if (mode === 'none' || (err.includes('no refresh') && err.includes('no sso'))) {
    if (err.includes('no sso') && !err.includes('no refresh')) return 'no_sso';
    if (err.includes('no refresh') && !err.includes('no sso')) return 'no_refresh';
    if (err.includes('no sso')) return 'no_sso';
    return 'no_refresh';
  }
  if (err.includes('no refresh')) return 'no_refresh';
  if (err.includes('no sso') || err.includes('empty sso')) return 'no_sso';
  if (verdict === 'dead' || mode.includes('skipped_dead') || mode === 'skipped_dead') {
    return 'sso_dead';
  }
  if (action === 'dead' || err.includes('probe dead') || err.includes('cpa probe')) {
    return 'probe_dead';
  }
  if (mode === 'refresh' && !input.ok) return 'refresh_dead';
  if (
    err.includes('econn') ||
    err.includes('network') ||
    err.includes('socket') ||
    err.includes('proxy') ||
    err.includes('enotfound') ||
    err.includes('econnreset')
  ) {
    return 'network';
  }
  if (mode.includes('error') || err) return 'python_error';
  return 'unknown';
}

export function summarizeFailReasons(
  items: Array<{ failReason?: string; ok?: boolean }>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    if (it.ok) continue;
    const k = it.failReason || 'unknown';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
