import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(message);
}

const fakeRunner = String.raw`from __future__ import annotations

import argparse
import json
import os
import pathlib
import time


def emit(event: dict) -> None:
    print("GRA_EVENT:" + json.dumps(event, ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    run_id = os.environ.get("GROK_RUN_ID", "").strip()
    config_path = os.environ.get("GRA_CONFIG_PATH", "").strip()
    config = {}
    if config_path:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)

    email = f"{run_id[:8]}@example.test"
    password = f"pw-{run_id[:8]}"
    sso = f"sso-{run_id[:8]}"

    seen_path = pathlib.Path(__file__).with_name(f"seen-{run_id}.json")
    seen_path.write_text(
        json.dumps(
            {
                "runId": run_id,
                "configPath": config_path,
                "config": config,
                "count": args.count,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    emit({"type": "bootstrap", "runId": run_id})
    time.sleep(0.5)
    emit({"type": "progress", "runId": run_id, "current": 1, "total": args.count})

    # Legacy success-looking text. Node must not double count it after structured events.
    print("\u7b2c 1 \u8f6e\u6210\u529f", flush=True)

    emit(
        {
            "type": "success",
            "runId": run_id,
            "round": 1,
            "current": 1,
            "total": args.count,
            "success": 1,
            "failed": 0,
            "email": email,
            "password": password,
            "sso": sso,
        }
    )

    out = pathlib.Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(f"{email} | {password} | {sso}\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;

const tempRoot = await mkdtemp(path.join(tmpdir(), 'gra-concurrent-register-'));
let success = false;

try {
  const dataDir = path.join(tempRoot, 'data');
  const registerDir = path.join(tempRoot, 'register');
  const ssoDir = path.join(dataDir, 'sso');
  await mkdir(dataDir, { recursive: true });
  await mkdir(registerDir, { recursive: true });

  process.env.DATA_DIR = dataDir;
  process.env.SSO_DIR = ssoDir;
  process.env.REGISTER_DIR = registerDir;
  process.env.PYTHON_PATH = process.platform === 'win32' ? 'python' : 'python3';
  process.env.GRA_MASTER_KEY = 'concurrent-register-verify-key';

  await writeFile(
    path.join(dataDir, 'config.json'),
    JSON.stringify(
      {
        registerDir,
        runCount: 1,
        autoSsoCheckOnRegister: false,
        autoAuthExport: false,
        singBoxEnabled: false,
        proxyEnabled: false,
        proxyPoolEnabled: false,
        mail: {
          apiBase: '',
          adminAuth: '',
          domain: ''
        }
      },
      null,
      2
    ),
    'utf-8'
  );
  await writeFile(path.join(registerDir, 'config.json'), JSON.stringify({ seed: true }, null, 2), 'utf-8');
  await writeFile(path.join(registerDir, 'runner.py'), fakeRunner, 'utf-8');

  const { registerBot } = await import('../server/dist/server/src/bot/registerBot.js');
  const { listAccounts } = await import('../server/dist/server/src/accountStore.js');

  const events = [];
  registerBot.on('event', (event) => {
    events.push(event);
  });

  const first = await registerBot.start({ runCountOverride: 1, maxParallelOverride: 2 });
  const second = await registerBot.start({ runCountOverride: 1, maxParallelOverride: 2 });
  const runIds = [first.runId, second.runId];

  await waitFor(
    () => registerBot.activeCount() === 2,
    3000,
    `expected 2 active jobs after concurrent start, got ${registerBot.activeCount()}`
  );

  await waitFor(
    () =>
      runIds.every((runId) => {
        const status = registerBot.getJobStatus(runId);
        return status && !['starting', 'running'].includes(status.phase);
      }),
    10000,
    'timed out waiting for fake register jobs to finish'
  );

  const statuses = runIds.map((runId) => ({
    runId,
    status: registerBot.getJobStatus(runId)
  }));
  for (const item of statuses) {
    assert(item.status, `missing status for ${item.runId}`);
    assert(item.status.phase === 'done', `expected ${item.runId} phase done, got ${item.status.phase}`);
    assert(item.status.success === 1, `expected ${item.runId} success=1, got ${item.status.success}`);
    assert(item.status.failed === 0, `expected ${item.runId} failed=0, got ${item.status.failed}`);
    assert(item.status.total === 1, `expected ${item.runId} total=1, got ${item.status.total}`);
  }

  await waitFor(async () => (await listAccounts()).length === 2, 5000, 'accounts.json did not receive 2 accounts');
  const accounts = await listAccounts();
  assert(accounts.length === 2, `expected 2 accounts, got ${accounts.length}`);
  assert(
    accounts.every((account) => runIds.includes(account.runId)),
    'accounts should be written by the live runs, not by SSO import fallback'
  );
  assert(new Set(accounts.map((account) => account.runId)).size === 2, 'accounts should belong to 2 runs');
  assert(new Set(accounts.map((account) => account.sso)).size === 2, 'accounts should keep 2 unique sso values');

  const seenFiles = (await readdir(registerDir)).filter((name) => name.startsWith('seen-') && name.endsWith('.json'));
  assert(seenFiles.length === 2, `expected 2 seen files, got ${seenFiles.length}`);
  const seen = await Promise.all(
    seenFiles.map(async (name) => JSON.parse(await readFile(path.join(registerDir, name), 'utf-8')))
  );
  const configPaths = seen.map((item) => String(item.configPath || ''));
  assert(new Set(configPaths).size === 2, 'runtime config paths should be unique per job');
  assert(
    seen.every((item) => item.config?._gra_runtime_config?.generated_by === 'GrokRegisterAgent'),
    'runtime configs should include the GrokRegisterAgent marker'
  );

  const remainingRuntimeConfigs = (await readdir(registerDir)).filter((name) => name.startsWith('config.runtime.'));
  assert(remainingRuntimeConfigs.length === 0, `runtime configs were not cleaned: ${remainingRuntimeConfigs.join(', ')}`);

  const baseConfig = JSON.parse(await readFile(path.join(registerDir, 'config.json'), 'utf-8'));
  assert(baseConfig.seed === true, 'base register/config.json should remain unchanged');
  assert(!baseConfig._gra_runtime_config, 'base register/config.json should not get the runtime marker');

  const rawAccounts = JSON.parse(await readFile(path.join(dataDir, 'accounts.json'), 'utf-8'));
  assert(
    rawAccounts.every((account) =>
      String(account.password || '').startsWith('gra1:') && String(account.sso || '').startsWith('gra1:')
    ),
    'accounts.json should store password and sso encrypted when GRA_MASTER_KEY is set'
  );

  const successEvents = events.filter((event) => event.type === 'success' && runIds.includes(String(event.runId)));
  assert(successEvents.length === 2, `expected 2 success events, got ${successEvents.length}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        runs: statuses.map((item) => ({
          runId: item.runId,
          phase: item.status.phase,
          success: item.status.success,
          failed: item.status.failed,
          total: item.status.total
        })),
        accounts: accounts.length,
        uniqueRuntimeConfigs: new Set(configPaths).size,
        runtimeConfigsRemaining: remainingRuntimeConfigs.length,
        encryptedAccountsOnDisk: true
      },
      null,
      2
    )
  );

  success = true;
} finally {
  if (success && process.env.KEEP_VERIFY_TMP !== '1') {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`[verify] temp root kept: ${tempRoot}`);
  }
}
