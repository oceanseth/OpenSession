/**
 * Electron main process for OpenSession Desktop.
 *
 * Owns everything the sandboxed renderer can't do directly:
 *  - GitHub device-flow OAuth (github.com has no CORS; main-process fetch does not care)
 *  - Daytona sandbox lifecycle for benchmark runs (@daytonaio/sdk + API key)
 *  - Local fallback runs of the same bench script, and report export
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BENCH_SCRIPT = join(here, '..', 'bench', 'run-bench.mjs');
const PIPE_FILE = join(here, '..', 'rocketride', 'heuristics.pipe.json');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#10141d',
    title: 'OpenSession',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    const index = join(here, '..', 'dist', 'index.html');
    if (existsSync(index)) {
      void win.loadFile(index);
    } else {
      // dist/ is gitignored — a fresh checkout has no renderer bundle yet.
      // `npm start` builds it via prestart; explain instead of going blank
      // in case electron was invoked directly.
      void win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<body style="margin:0;display:grid;place-items:center;height:100vh;' +
              'background:#0e1320;color:#c6cfe2;font-family:system-ui">' +
              '<div style="text-align:center"><h2 style="color:#eef2fb">Renderer not built yet</h2>' +
              '<p>Run <code style="color:#4d9fff">npm start</code> (builds, then launches)<br>' +
              'or <code style="color:#4d9fff">npm run dev</code> for live reload.</p></div></body>',
          ),
      );
    }
  }
  // External links open in the system browser, not new Electron windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── GitHub device flow ─────────────────────────────────────────────

const GH_ACCEPT = { Accept: 'application/json', 'Content-Type': 'application/json' };

ipcMain.handle('auth:device-start', async (_e, clientId) => {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: GH_ACCEPT,
    body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error_description ?? data.error ?? `device code request failed (${res.status})`);
  }
  void shell.openExternal(data.verification_uri);
  return data; // { device_code, user_code, verification_uri, interval, expires_in }
});

ipcMain.handle('auth:device-poll', async (_e, { clientId, deviceCode }) => {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: GH_ACCEPT,
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  return res.json(); // { access_token } | { error: 'authorization_pending' | 'slow_down' | ... }
});

// ── Benchmark runs ─────────────────────────────────────────────────

function benchArgs({ repo, benchmark, branch }) {
  return [repo, benchmark, branch ?? 'HEAD'];
}

async function runLocal(params) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath, // Electron binary runs plain node scripts with ELECTRON_RUN_AS_NODE
      [BENCH_SCRIPT, ...benchArgs(params)],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 5 * 60_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`local bench failed: ${stderr || err.message}`));
        else resolve(JSON.parse(stdout));
      },
    );
  });
}

async function runDaytona(params, apiKey, progress) {
  const { Daytona } = await import('@daytonaio/sdk');
  const daytona = new Daytona({ apiKey });
  progress('Creating Daytona sandbox…');
  const sandbox = await daytona.create({ language: 'javascript' });
  const sandboxId = sandbox.id ?? sandbox.sandboxId ?? 'unknown';
  try {
    progress(`Sandbox ${sandboxId} up — uploading bench script`);
    const script = await readFile(BENCH_SCRIPT, 'utf8');
    const b64 = Buffer.from(script, 'utf8').toString('base64');
    // Pass an explicit cwd on every exec: without it the SDK resolves the
    // sandbox root via a toolbox endpoint that 404s on the managed backend
    // ("Cannot GET …/toolbox/project-dir"). /tmp always exists and is writable.
    const CWD = '/tmp';
    await sandbox.process.executeCommand(`printf '%s' '${b64}' | base64 -d > /tmp/run-bench.mjs`, CWD);
    progress('Running benchmark in sandbox…');
    const res = await sandbox.process.executeCommand(
      `node /tmp/run-bench.mjs ${benchArgs(params).map((a) => `'${a}'`).join(' ')}`,
      CWD,
    );
    const out = res.result ?? res.stdout ?? '';
    if (res.exitCode !== undefined && res.exitCode !== 0) {
      throw new Error(`bench script exited ${res.exitCode}: ${out.slice(0, 500)}`);
    }
    const report = JSON.parse(out);
    report.runner = { kind: 'daytona', sandboxId };
    return report;
  } finally {
    progress('Tearing down sandbox…');
    try {
      if (typeof sandbox.delete === 'function') await sandbox.delete();
      else if (typeof daytona.remove === 'function') await daytona.remove(sandbox);
    } catch {
      /* sandbox cleanup is best-effort; auto-stop reaps leaks */
    }
  }
}

async function runRocketRide(params, apiKey, uri, progress) {
  // Uses the bundled `rocketride` JS SDK — no Python/pip needed. WebSocket
  // transport, so this runs from the main process (renderer is file://).
  const rr = await import('rocketride');
  const RocketRideClient = rr.RocketRideClient ?? rr.default?.RocketRideClient;
  if (!RocketRideClient) throw new Error('rocketride SDK: RocketRideClient export not found');
  const branch = params.branch ?? 'HEAD';
  progress('Fetching session history…');
  const historyRes = await fetch(
    `https://raw.githubusercontent.com/${params.repo}/${encodeURIComponent(branch)}/llm-turn-history.jsonl`,
  );
  if (!historyRes.ok) throw new Error(`history fetch ${historyRes.status} for ${params.repo}`);
  const history = await historyRes.text();

  const client = new RocketRideClient({ auth: apiKey, uri: uri || 'https://cloud.rocketride.ai' });
  progress('Connecting to RocketRide Cloud…');
  let token;
  try {
    // connect() attaches the WebSocket and logs in with the stored API key;
    // use()/send() throw "Server is not connected" without it.
    await client.connect();
    const started = await client.use({ filepath: PIPE_FILE });
    token = started.token;
    progress('Running heuristics pipeline…');
    const raw = await client.send(
      token,
      JSON.stringify({ repo: params.repo, benchmark: params.benchmark, history }),
      { name: 'input.json' },
      'application/json',
    );
    const report =
      typeof raw === 'string'
        ? JSON.parse(raw)
        : (raw?.result ?? raw?.data?.result ?? raw?.data ?? raw);
    if (!report || typeof report !== 'object' || !report.summary) {
      throw new Error(`unexpected pipeline result: ${JSON.stringify(raw).slice(0, 400)}`);
    }
    report.runner = { kind: 'rocketride' };
    return report;
  } finally {
    try {
      if (token) await client.terminate(token);
      await client.disconnect();
    } catch {
      /* best-effort teardown */
    }
  }
}

ipcMain.handle(
  'bench:run',
  async (event, { repo, benchmark, branch, runner, daytonaApiKey, rocketrideApiKey, rocketrideUri }) => {
    const progress = (message) => event.sender.send('bench:progress', message);
    if (runner === 'rocketride') {
      if (!rocketrideApiKey) throw new Error('No RocketRide API key set — add one in Settings.');
      return runRocketRide({ repo, benchmark, branch }, rocketrideApiKey, rocketrideUri, progress);
    }
    if (runner === 'daytona' || (runner === undefined && daytonaApiKey)) {
      if (!daytonaApiKey) throw new Error('No Daytona API key set — add one in Settings.');
      return runDaytona({ repo, benchmark, branch }, daytonaApiKey, progress);
    }
    progress('Running locally.');
    const report = await runLocal({ repo, benchmark, branch });
    report.runner = { kind: 'local' };
    return report;
  },
);

ipcMain.handle('report:save', async (event, report) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const safeRepo = String(report.repo ?? 'repo').replace(/\//g, '__');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `bench-report-${safeRepo}-${report.benchmark}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return null;
  await writeFile(filePath, JSON.stringify(report, null, 2));
  return filePath;
});

ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));

// ── Registry/threads API proxy ─────────────────────────────────────
// The renderer is a file:// origin the API gateway's CORS allowlist
// doesn't cover; main-process fetch has no CORS, so proxy through IPC.

const API_BASE = 'https://r1q8b3li40.execute-api.us-east-1.amazonaws.com/api';

ipcMain.handle('api:fetch', async (_e, { method, path, token, body }) => {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
