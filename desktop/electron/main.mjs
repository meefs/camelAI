import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const devRendererUrl = process.env.DESKTOP_RENDERER_URL;
const repoRoot = resolve(__dirname, '../..');
let backendProcess = null;
let directDesktopService = null;
let unsubscribeDesktopService = null;
let isQuitting = false;
let backendStdoutBuffer = '';
let latestSnapshot = null;
let backendReadyPromise = null;
const startupProbeEnabled = process.env.DESKTOP_STARTUP_PROBE === '1';
const startupProbeTimeoutMs = Number(
  process.env.DESKTOP_STARTUP_PROBE_TIMEOUT_MS || '90000',
);
const startupEvents = [];
let startupProbeResolved = false;
let startupProbeTimeout = null;
let startupProbeRendererReady = null;

function getWindowBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? '#09090b' : '#f5f5f4';
}

function applyWindowAppearance(window) {
  window.setBackgroundColor(getWindowBackgroundColor());
}

function recordStartup(stage, detail = {}) {
  const event = {
    at: new Date().toISOString(),
    stage,
    ...detail,
  };
  startupEvents.push(event);
  if (startupProbeEnabled) {
    process.stderr.write(`[desktop-startup] ${JSON.stringify(event)}\n`);
  }
}

function finishStartupProbe(ok, detail = {}) {
  if (!startupProbeEnabled || startupProbeResolved) {
    return;
  }
  startupProbeResolved = true;
  if (startupProbeTimeout) {
    clearTimeout(startupProbeTimeout);
    startupProbeTimeout = null;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        events: startupEvents,
        latestSnapshotSummary: latestSnapshot
          ? {
              provider: latestSnapshot.provider,
              authSource: latestSnapshot.auth.source,
              hasAuth: latestSnapshot.auth.available,
              runtimeState: latestSnapshot.runtimeStatus.state,
              activeThreadId: latestSnapshot.activeThreadId,
            }
          : null,
        ...detail,
      },
      null,
      2
    )}\n`
  );
  setTimeout(() => {
    app.quit();
  }, 50);
}

function getDesktopResourcesDir() {
  if (process.env.DESKTOP_APP_RESOURCES_DIR) {
    return process.env.DESKTOP_APP_RESOURCES_DIR;
  }
  if (app.isPackaged) {
    return resolve(process.resourcesPath, 'desktop');
  }
  return resolve(__dirname, '..');
}

function getRendererEntry() {
  if (devRendererUrl) {
    return devRendererUrl;
  }

  const resourcesDir = getDesktopResourcesDir();
  const stagedRendererEntry = resolve(resourcesDir, 'renderer/index.html');
  if (existsSync(stagedRendererEntry)) {
    return `file://${stagedRendererEntry}`;
  }

  return `file://${resolve(__dirname, '../renderer-dist/index.html')}`;
}

function getBackendModuleEntry() {
  if (process.env.DESKTOP_BACKEND_MODULE_ENTRY) {
    return resolveDesktopOverridePath(process.env.DESKTOP_BACKEND_MODULE_ENTRY);
  }
  const resourcesDir = getDesktopResourcesDir();
  const stagedBackendModuleEntry = resolve(resourcesDir, 'backend/index.mjs');
  return existsSync(stagedBackendModuleEntry) ? stagedBackendModuleEntry : null;
}

function resolveDesktopOverridePath(target) {
  if (!target) {
    return null;
  }
  return isAbsolute(target) ? target : resolve(repoRoot, target);
}

function getDesktopRuntimeEnv() {
  const resourcesDir = getDesktopResourcesDir();
  const userDataDirectory = app.getPath('userData');
  const dataDirectory = resolve(userDataDirectory, 'data');
  const runtimeDirectory = resolve(userDataDirectory, 'runtime');
  const stagedRuntimeHelperPath = resolve(resourcesDir, 'bin/camelai-runtime-helper');
  const devRuntimeHelperPath = resolve(__dirname, '../runtime-helper/.build/debug/camelai-runtime-helper');
  const runtimeHelperPath = existsSync(stagedRuntimeHelperPath) ? stagedRuntimeHelperPath : devRuntimeHelperPath;
  const stagedKernelPath = resolve(resourcesDir, 'kernel/vmlinux');
  const devKernelPath = resolve(__dirname, '../runtime-helper/assets/vmlinux');
  const runtimeKernelPath = existsSync(stagedKernelPath) ? stagedKernelPath : devKernelPath;

  return {
    DESKTOP_DATA_DIR: dataDirectory,
    DESKTOP_RUNTIME_DIR: runtimeDirectory,
    DESKTOP_RUNTIME_HELPER_PATH: runtimeHelperPath,
    DESKTOP_RUNTIME_KERNEL_PATH: runtimeKernelPath,
  };
}

function applyDesktopRuntimeEnv() {
  const runtimeEnv = getDesktopRuntimeEnv();
  for (const [key, value] of Object.entries(runtimeEnv)) {
    process.env[key] = value;
  }
  return runtimeEnv;
}

function publishBackendEvent(event) {
  if (event.type === 'snapshot') {
    latestSnapshot = event.snapshot;
    recordStartup('backend_snapshot', {
      provider: event.snapshot.provider,
      authSource: event.snapshot.auth.source,
      hasAuth: event.snapshot.auth.available,
      runtimeState: event.snapshot.runtimeStatus.state,
    });
    if (
      startupProbeEnabled &&
      startupProbeRendererReady &&
      event.snapshot.runtimeStatus.state !== 'starting'
    ) {
      finishStartupProbe(true, {
        rendererReady: startupProbeRendererReady,
        settledRuntimeState: event.snapshot.runtimeStatus.state,
        settledRuntimeDetail: event.snapshot.runtimeStatus.detail,
      });
    }
  }

  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('desktop:event', event);
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: getWindowBackgroundColor(),
    show: !startupProbeEnabled,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 16 },
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  applyWindowAppearance(window);

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (startupProbeEnabled) {
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      recordStartup('window_did_fail_load', { errorCode, errorDescription });
    });
    window.webContents.on('console-message', (_event, level, message) => {
      recordStartup('renderer_console', { level, message });
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      recordStartup('render_process_gone', details);
    });
  }

  window.webContents.on('did-finish-load', () => {
    recordStartup('window_did_finish_load');
    if (latestSnapshot) {
      window.webContents.send('desktop:event', {
        type: 'snapshot',
        snapshot: latestSnapshot,
      });
    }
  });

  void window.loadURL(getRendererEntry());

  if (devRendererUrl && !startupProbeEnabled && process.env.DESKTOP_NO_DEVTOOLS !== '1') {
    window.webContents.openDevTools({ mode: 'detach' });
  }
}

async function ensureDirectDesktopService() {
  if (directDesktopService) {
    return;
  }

  applyDesktopRuntimeEnv();
  recordStartup('runtime_env_applied', { mode: 'direct-service' });

  const backendModuleEntry = getBackendModuleEntry();
  if (!backendModuleEntry) {
    throw new Error('Desktop service bundle is not available.');
  }

  const backendModule = await import(pathToFileURL(backendModuleEntry).href);
  if (typeof backendModule.createDesktopService !== 'function') {
    throw new Error('Desktop service bundle is missing createDesktopService().');
  }

  directDesktopService = backendModule.createDesktopService();
  recordStartup('direct_service_created');
  unsubscribeDesktopService = directDesktopService.subscribe((event) => {
    publishBackendEvent(event);
  });
  latestSnapshot = directDesktopService.getSnapshot();
  recordStartup('direct_service_snapshot_loaded', {
    provider: latestSnapshot.provider,
    authSource: latestSnapshot.auth.source,
    runtimeState: latestSnapshot.runtimeStatus.state,
  });
}

async function ensureBackend() {
  if (directDesktopService) {
    return;
  }

  if (backendProcess && backendProcess.exitCode === null) {
    return;
  }

  if (backendReadyPromise) {
    await backendReadyPromise;
    return;
  }

  const backendModuleEntry = getBackendModuleEntry();
  if (backendModuleEntry) {
    backendReadyPromise = ensureDirectDesktopService().finally(() => {
      backendReadyPromise = null;
    });
    await backendReadyPromise;
    return;
  }

  const resourcesDir = getDesktopResourcesDir();
  const backendBinaryPath =
    resolveDesktopOverridePath(process.env.DESKTOP_BACKEND_BINARY_PATH) ??
    resolve(resourcesDir, 'bin/camelai-desktop-backend');
  const backendEntry =
    process.env.DESKTOP_BACKEND_ENTRY || 'desktop/backend/server.ts';
  const backendCwd =
    resolveDesktopOverridePath(process.env.DESKTOP_BACKEND_CWD) ?? repoRoot;
  const runtimeEnv = applyDesktopRuntimeEnv();
  recordStartup('runtime_env_applied', { mode: 'backend-child' });
  const backendEnv = {
    ...process.env,
    DESKTOP_BACKEND_TRANSPORT: 'stdio',
    ...runtimeEnv,
  };

  backendReadyPromise = new Promise((resolvePromise, rejectPromise) => {
    let ready = false;
    const command = existsSync(backendBinaryPath) ? backendBinaryPath : 'bun';
    const args = existsSync(backendBinaryPath) ? [] : ['run', backendEntry];
    recordStartup('backend_process_spawn', { command, args });

    backendProcess = spawn(command, args, {
      cwd: backendCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: backendEnv,
    });

    backendProcess.stdout.setEncoding('utf8');
    backendProcess.stdout.on('data', (chunk) => {
      backendStdoutBuffer += chunk;
      while (true) {
        const newlineIndex = backendStdoutBuffer.indexOf('\n');
        if (newlineIndex === -1) {
          break;
        }

        const line = backendStdoutBuffer.slice(0, newlineIndex).trim();
        backendStdoutBuffer = backendStdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }

        try {
          const event = JSON.parse(line);
          publishBackendEvent(event);
          if (event.type === 'snapshot' && !ready) {
            ready = true;
            recordStartup('backend_process_ready');
            resolvePromise();
          }
        } catch (error) {
          console.error('[desktop-backend] invalid stdio event', error);
        }
      }
    });

    backendProcess.stderr.setEncoding('utf8');
    backendProcess.stderr.on('data', (chunk) => {
      process.stderr.write(`[desktop-backend] ${chunk}`);
    });

    backendProcess.on('exit', (code, signal) => {
      backendProcess = null;
      backendReadyPromise = null;
      if (!ready) {
        recordStartup('backend_process_exit_before_ready', { code, signal });
        rejectPromise(new Error(`desktop backend exited before ready: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
        return;
      }
      if (!isQuitting) {
        recordStartup('backend_process_exit', { code, signal });
        console.error(`[desktop-backend] exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
      }
    });
  });

  await backendReadyPromise;
}

async function sendBackendEvent(event) {
  await ensureBackend();
  if (directDesktopService) {
    directDesktopService.handleClientEvent(event);
    return;
  }
  if (!backendProcess || backendProcess.exitCode !== null) {
    throw new Error('Desktop backend is not running.');
  }
  backendProcess.stdin.write(`${JSON.stringify(event)}\n`);
}

ipcMain.handle('desktop:get-snapshot', async () => {
  recordStartup('renderer_requested_snapshot');
  await ensureBackend();
  return latestSnapshot;
});

ipcMain.on('desktop:send', (_event, payload) => {
  void sendBackendEvent(payload).catch((error) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('desktop:event', {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
});

ipcMain.on('desktop:ready', (_event, payload) => {
  startupProbeRendererReady = payload;
  recordStartup('renderer_reported_ready', payload);
  if (!startupProbeEnabled) {
    return;
  }
  if (latestSnapshot && latestSnapshot.runtimeStatus.state !== 'starting') {
    finishStartupProbe(true, {
      rendererReady: payload,
      settledRuntimeState: latestSnapshot.runtimeStatus.state,
      settledRuntimeDetail: latestSnapshot.runtimeStatus.detail,
    });
  }
});

app.whenReady().then(async () => {
  recordStartup('app_ready');
  if (startupProbeEnabled) {
    startupProbeTimeout = setTimeout(() => {
      finishStartupProbe(false, { timeout: true });
    }, startupProbeTimeoutMs);
  }
  await ensureBackend();
  createWindow();
  nativeTheme.on('updated', () => {
    for (const window of BrowserWindow.getAllWindows()) {
      applyWindowAppearance(window);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (unsubscribeDesktopService) {
    unsubscribeDesktopService();
    unsubscribeDesktopService = null;
  }
  if (directDesktopService && typeof directDesktopService.dispose === 'function') {
    directDesktopService.dispose();
  }
  directDesktopService = null;
  if (backendProcess && backendProcess.exitCode === null) {
    backendProcess.kill('SIGTERM');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
