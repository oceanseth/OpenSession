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
    await sandbox.process.executeCommand(`printf '%s' '${b64}' | base64 -d > /tmp/run-bench.mjs`);
    progress('Running benchmark in sandbox…');
    const res = await sandbox.process.executeCommand(
      `node /tmp/run-bench.mjs ${benchArgs(params).map((a) => `'${a}'`).join(' ')}`,
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

ipcMain.handle('bench:run', async (event, { repo, benchmark, branch, daytonaApiKey }) => {
  const progress = (message) => event.sender.send('bench:progress', message);
  if (daytonaApiKey) {
    return runDaytona({ repo, benchmark, branch }, daytonaApiKey, progress);
  }
  progress('No Daytona key — running locally.');
  const report = await runLocal({ repo, benchmark, branch });
  report.runner = { kind: 'local' };
  return report;
});

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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
