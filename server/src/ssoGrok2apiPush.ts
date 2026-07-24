/**
 * 号池 SSO → grok2api 手动推送（web import + convert）。
 * 需设置 pushSsoToGrok2api / autoPushSsoToGrok2api，并填写 grok2api 地址与账号。
 */
import { loadSettings } from './settingsStore.js';
import { resolveRegisterRuntime } from './bot/registerRuntime.js';
import { setPushTag, loadAccountTags, lookupNsfwTag, isPushOkFromTag } from './accountTags.js';
import { classifyPushFailReason, summarizeFailReasons } from './pythonJobPool.js';
import { spawn } from 'child_process';

export type SsoG2PushItem = {
  sso: string;
  email?: string;
  id?: string;
};

export type SsoG2PushResultItem = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  email?: string;
  id?: string;
  mode?: string;
  failReason?: string;
};

function runPythonJson(
  pythonPath: string,
  registerDir: string,
  code: string,
  args: string[]
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonPath, ['-c', code, ...args], {
      cwd: registerDir,
      env: { ...process.env },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (codeExit) => {
      const line = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .pop();
      if (line) {
        try {
          resolvePromise(JSON.parse(line) as Record<string, unknown>);
          return;
        } catch {
          /* fallthrough */
        }
      }
      if (codeExit !== 0) {
        reject(new Error(stderr.trim() || `python exit ${codeExit}`));
        return;
      }
      reject(new Error(stderr.trim() || 'python returned no JSON'));
    });
  });
}

export async function pushSsoToGrok2apiBatch(input: {
  items: SsoG2PushItem[];
  concurrency?: number;
  /** true：忽略 already_pushed，强制重新上传 */
  force?: boolean;
  onItem?: (item: SsoG2PushResultItem) => void | Promise<void>;
  isAborted?: () => boolean;
}): Promise<{
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  cancelled?: boolean;
  remoteConfigured: boolean;
  remoteUrl?: string;
  failReasons?: Record<string, number>;
  results: SsoG2PushResultItem[];
}> {
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) throw new Error('缺少 SSO 列表');
  if (items.length > 200) throw new Error('单次推送最多 200 个');

  const settings = await loadSettings();
  const allow =
    settings.pushSsoToGrok2api === true ||
    settings.autoPushSsoToGrok2api === true ||
    (settings.pushSsoToGrok2api === undefined &&
      settings.autoPushSsoToGrok2api === undefined &&
      settings.grok2apiAutoUpload === true);
  if (!allow) {
    throw new Error(
      '未开启 SSO→grok2api 推送：请到设置「推送设置」打开 SSO→grok2api 允许或自动'
    );
  }

  const url = String(settings.grok2apiUrl || '').trim().replace(/\/+$/, '');
  const username = String(settings.grok2apiUsername || '').trim();
  const password = String(settings.grok2apiPassword || '');
  if (!url || !username || !password) {
    throw new Error('请先在设置填写 grok2api 地址、用户名与密码');
  }

  const runtime = resolveRegisterRuntime(settings);
  if (!runtime) throw new Error('未找到注册脚本目录，无法调用 Python 推送');

  const pySettings = {
    push_sso_to_grok2api: true,
    grok2api_url: url,
    grok2api_username: username,
    grok2api_password: password,
    grok2api_upload_mode: 'web_convert'
  };

  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(runtime.registerDir)})
from grok2api_client import upload_registered_sso
sso = sys.argv[1]
email = sys.argv[2] if len(sys.argv) > 2 else ""
settings = json.loads(sys.argv[3])
try:
    r = upload_registered_sso(
        settings,
        sso,
        email=email or "",
        log=lambda m: print(m, file=sys.stderr, flush=True),
    )
    if r is None:
        print(json.dumps({"ok": False, "skipped": True, "error": "upload skipped"}, ensure_ascii=False))
    else:
        print(json.dumps({"ok": True, "mode": r.get("mode") or "web_convert", "result": r}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:400]}, ensure_ascii=False))
`.trim();

  const concurrency = Math.min(
    4,
    Math.max(1, Number(input.concurrency) || 1)
  );
  const force = Boolean(input.force);
  const results: SsoG2PushResultItem[] = [];
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  const { loadAccountTagsAsync } = await import('./accountTags.js');
  const pushTagsSnapshot = await loadAccountTagsAsync();

  const emit = async (item: SsoG2PushResultItem, index: number) => {
    if (!item.ok && !item.failReason) {
      item.failReason = classifyPushFailReason(item);
    }
    results[index] = item;
    if (input.onItem) {
      try {
        await input.onItem(item);
      } catch {
        /* ignore */
      }
    }
  };

  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      if (input.isAborted?.()) break;
      const i = idx++;
      const it = items[i];
      const sso = String(it?.sso || '').trim();
      const email = String(it?.email || '').trim();
      const id = it?.id;
      if (!sso) {
        failed++;
        await emit(
          {
            ok: false,
            error: 'empty sso',
            email,
            id,
            failReason: 'empty_sso'
          },
          i
        );
        continue;
      }
      // 已成功推送过则跳过（force 时强制重推）
      if (!force) {
        const tag = lookupNsfwTag(pushTagsSnapshot, { email, sso });
        if (isPushOkFromTag(tag, 'sso_g2')) {
          skipped++;
          await emit(
            {
              ok: true,
              skipped: true,
              error: 'already_pushed',
              email,
              id,
              mode: 'already_pushed'
            },
            i
          );
          continue;
        }
      }
      try {
        const r = await runPythonJson(
          runtime!.pythonPath,
          runtime!.registerDir,
          code,
          [sso, email, JSON.stringify(pySettings)]
        );
        if (r.ok === true) {
          ok++;
          try {
            setPushTag({ channel: 'sso_g2', ok: true, email, sso });
          } catch {
            /* ignore */
          }
          await emit(
            {
              ok: true,
              email,
              id,
              mode: r.mode ? String(r.mode) : force ? 'reuploaded' : 'web_convert'
            },
            i
          );
        } else if (r.skipped === true) {
          skipped++;
          await emit(
            {
              ok: false,
              skipped: true,
              error: String(r.error || 'skipped'),
              email,
              id,
              mode: 'skipped'
            },
            i
          );
        } else {
          failed++;
          try {
            setPushTag({
              channel: 'sso_g2',
              ok: false,
              email,
              sso,
              error: String(r.error || 'push failed')
            });
          } catch {
            /* ignore */
          }
          await emit(
            {
              ok: false,
              error: String(r.error || 'push failed'),
              email,
              id,
              mode: 'error'
            },
            i
          );
        }
      } catch (err) {
        failed++;
        const errMsg = err instanceof Error ? err.message : String(err);
        try {
          setPushTag({ channel: 'sso_g2', ok: false, email, sso, error: errMsg });
        } catch {
          /* ignore */
        }
        await emit(
          {
            ok: false,
            error: errMsg,
            email,
            id,
            mode: 'error'
          },
          i
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );

  // 稀疏数组填满（取消时未处理的槽位）
  for (let i = 0; i < items.length; i++) {
    if (!results[i]) {
      results[i] = {
        ok: false,
        skipped: true,
        error: 'cancelled',
        email: items[i]?.email,
        id: items[i]?.id,
        mode: 'cancelled',
        failReason: 'cancelled'
      };
    } else if (!results[i].ok && !results[i].failReason) {
      results[i].failReason = classifyPushFailReason(results[i]);
    }
  }
  const failReasons = summarizeFailReasons(results.filter((r) => r && !r.ok));
  const cancelled = Boolean(input.isAborted?.());
  // 持久化 G2A 成功标记 → 号池列表展示 tag
  try {
    const { markAccountsPushedG2a } = await import('./accountStore.js');
    const ids = results.filter((r) => r.ok && r.id).map((r) => String(r.id));
    const emails = results
      .filter((r) => r.ok && r.email)
      .map((r) => String(r.email));
    if (ids.length || emails.length) {
      await markAccountsPushedG2a({ ids, emails });
    }
  } catch {
    /* non-fatal */
  }

  return {
    total: items.length,
    ok,
    failed,
    skipped,
    cancelled,
    remoteConfigured: true,
    remoteUrl: url,
    failReasons,
    results
  };
}
