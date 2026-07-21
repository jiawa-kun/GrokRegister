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

export type PythonPoolStats = {
  key: string;
  pythonPath: string;
  registerDir: string;
  workers: number;
  busy: number;
  queued: number;
  jobsTotal: number;
  jobsOk: number;
  jobsFail: number;
  timeouts: number;
  spawns: number;
  timeoutMs: number;
  maxSize: number;
};

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
  size = 2,
  jobTimeoutMs = 180_000
): PythonJobPool {
  const key = poolKey(pythonPath, registerDir);
  let p = pools.get(key);
  if (!p || p.disposed) {
    p = new PythonJobPool(pythonPath, registerDir, size, jobTimeoutMs);
    pools.set(key, p);
  } else {
    p.configure({ size, timeoutMs: jobTimeoutMs });
  }
  return p;
}

export function listPythonJobPoolStats(): PythonPoolStats[] {
  const out: PythonPoolStats[] = [];
  for (const [key, p] of pools) {
    if (p.disposed) continue;
    out.push(p.getStats(key));
  }
  return out;
}

export function disposeAllPythonJobPools(): void {
  for (const p of pools.values()) p.dispose();
  pools.clear();
}

export class PythonJobPool {
  readonly pythonPath: string;
  readonly registerDir: string;
  private slots: Slot[] = [];
  private readonly code: string;
  private jobTimeoutMs: number;
  private maxSize: number;
  disposed = false;

  private jobsTotal = 0;
  private jobsOk = 0;
  private jobsFail = 0;
  private timeouts = 0;
  private spawns = 0;

  constructor(
    pythonPath: string,
    registerDir: string,
    size: number,
    jobTimeoutMs = 180_000
  ) {
    this.pythonPath = pythonPath;
    this.registerDir = registerDir;
    this.code = buildWorkerCode(registerDir);
    this.jobTimeoutMs = Math.max(10_000, Math.floor(jobTimeoutMs) || 180_000);
    this.maxSize = Math.min(4, Math.max(1, Math.floor(size) || 1));
    for (let i = 0; i < this.maxSize; i++) this.spawnSlot();
  }

  get size(): number {
    return this.slots.filter((s) => !s.dead).length;
  }

  configure(opts: { size?: number; timeoutMs?: number }): void {
    if (opts.timeoutMs != null && Number.isFinite(opts.timeoutMs)) {
      this.jobTimeoutMs = Math.max(10_000, Math.floor(opts.timeoutMs));
    }
    if (opts.size != null && Number.isFinite(opts.size)) {
      const want = Math.min(4, Math.max(1, Math.floor(opts.size)));
      this.maxSize = want;
      this.ensureSize(want);
      // 缩容：多余空闲 worker 不强杀（避免打断 inflight），仅不再补位；
      // 若 alive > want 且有空闲，尝试结束空闲的
      const alive = this.slots.filter((s) => !s.dead);
      let extra = alive.length - want;
      if (extra > 0) {
        for (const s of alive) {
          if (extra <= 0) break;
          if (!s.busy && s.queue.length === 0) {
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
            extra -= 1;
          }
        }
        this.slots = this.slots.filter((s) => !s.dead);
      }
    }
  }

  ensureSize(size: number): void {
    const want = Math.min(4, Math.max(1, Math.floor(size) || 1));
    const alive = this.slots.filter((s) => !s.dead).length;
    for (let i = alive; i < want; i++) this.spawnSlot();
  }

  getStats(key?: string): PythonPoolStats {
    const alive = this.slots.filter((s) => !s.dead);
    let busy = 0;
    let queued = 0;
    for (const s of alive) {
      if (s.busy) busy += 1;
      queued += s.queue.length;
    }
    return {
      key: key || poolKey(this.pythonPath, this.registerDir),
      pythonPath: this.pythonPath,
      registerDir: this.registerDir,
      workers: alive.length,
      busy,
      queued,
      jobsTotal: this.jobsTotal,
      jobsOk: this.jobsOk,
      jobsFail: this.jobsFail,
      timeouts: this.timeouts,
      spawns: this.spawns,
      timeoutMs: this.jobTimeoutMs,
      maxSize: this.maxSize
    };
  }

  private spawnSlot(): void {
    if (this.disposed) return;
    if (this.slots.filter((s) => !s.dead).length >= this.maxSize) return;
    try {
      const child = spawn(this.pythonPath, ['-u', '-c', this.code], {
        cwd: this.registerDir,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams;
      this.spawns += 1;

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
          this.jobsTotal += 1;
          if (rest.ok === false || rest.error) this.jobsFail += 1;
          else this.jobsOk += 1;
          q.pending.resolve(rest);
          slot.busy = false;
          this.pump(slot);
        }
      });

      const killPending = (err: Error) => {
        slot.dead = true;
        for (const q of slot.queue) {
          clearTimeout(q.pending.timer);
          this.jobsTotal += 1;
          this.jobsFail += 1;
          q.pending.reject(err);
        }
        slot.queue = [];
        slot.busy = false;
      };

      child.stderr.on('data', (d) => {
        const s = String(d).trim();
        if (s) console.warn('[python-pool] stderr:', s.slice(0, 300));
      });
      child.on('error', (err) =>
        killPending(err instanceof Error ? err : new Error(String(err)))
      );
      child.on('close', (code) => {
        killPending(new Error(`python worker exit ${code}`));
        if (!this.disposed) {
          this.slots = this.slots.filter((s) => s !== slot);
          if (this.slots.filter((s) => !s.dead).length < this.maxSize) {
            this.spawnSlot();
          }
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
      this.jobsTotal += 1;
      this.jobsFail += 1;
      next.pending.reject(err instanceof Error ? err : new Error(String(err)));
      slot.busy = false;
      this.pump(slot);
    }
  }

  run(job: PythonPoolJob): Promise<Record<string, unknown>> {
    if (this.disposed) return Promise.reject(new Error('python pool disposed'));
    const alive = this.slots.filter((s) => !s.dead);
    if (alive.length === 0) this.spawnSlot();
    const slots = this.slots.filter((s) => !s.dead);
    if (slots.length === 0) {
      return Promise.reject(new Error('no python workers'));
    }
    slots.sort((a, b) => a.queue.length - b.queue.length);
    const slot = slots[0];
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.queue = slot.queue.filter((x) => x.id !== id);
        this.jobsTotal += 1;
        this.jobsFail += 1;
        this.timeouts += 1;
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

  async ping(): Promise<boolean> {
    try {
      const r = await this.run({ op: 'ping' });
      return r.ok === true || r.pong === true;
    } catch {
      return false;
    }
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

export function classifyPushFailReason(input: {
  ok?: boolean;
  skipped?: boolean;
  error?: string;
  mode?: string;
  remoteError?: string;
}): string | undefined {
  if (input.ok && !input.skipped) return undefined;
  const err = String(input.error || input.remoteError || '').toLowerCase();
  const mode = String(input.mode || '').toLowerCase();
  if (input.skipped || mode === 'already_pushed') return 'already_pushed';
  if (mode === 'missing_file') return 'missing_file';
  if (mode === 'invalid_json') return 'invalid_json';
  if (mode === 'convert_error') return 'convert_error';
  if (mode === 'http_error') return 'http_error';
  if (mode === 'biz_error') return 'biz_error';
  if (mode === 'auth_error') return 'auth_error';
  if (
    err.includes('timeout') ||
    err.includes('etimedout') ||
    err.includes('timed out') ||
    err.includes('aborted')
  ) {
    return 'timeout';
  }
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
  if (
    err.includes('401') ||
    err.includes('403') ||
    err.includes('unauthorized') ||
    err.includes('forbidden') ||
    err.includes('invalid token') ||
    err.includes('admin')
  ) {
    return 'auth_error';
  }
  if (err.includes('429') || err.includes('rate limit') || err.includes('too many')) {
    return 'rate_limit';
  }
  if (err.includes('http ')) return 'http_error';
  if (mode === 'error' || err) return mode && mode !== 'error' ? mode : 'push_error';
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
