const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const pty = require('node-pty');

let mainWindow = null;
const terminalProcesses = new Map();
const terminalStatuses = new Map();
let terminalStatusTimer = null;
let terminalSeq = 1;
const WORKSPACES_DIRNAME = 'workspaces';
const APP_STATE_FILENAME = 'app-state.json';
let allowWindowClose = false;

function getWorkspacesDir() {
  return path.join(app.getPath('userData'), WORKSPACES_DIRNAME);
}

function ensureWorkspacesDir() {
  fs.mkdirSync(getWorkspacesDir(), { recursive: true });
}

function getAppStatePath() {
  return path.join(app.getPath('userData'), APP_STATE_FILENAME);
}

function readAppState() {
  try {
    const fullPath = getAppStatePath();
    if (!fs.existsSync(fullPath)) {
      return {};
    }
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (_error) {
    return {};
  }
}

function writeAppState(partial = {}) {
  const nextState = {
    ...readAppState(),
    ...partial
  };
  fs.writeFileSync(getAppStatePath(), JSON.stringify(nextState, null, 2), 'utf8');
  return nextState;
}

function getLastOpenedWorkspaceId() {
  const state = readAppState();
  return state.lastOpenedWorkspaceId ? String(state.lastOpenedWorkspaceId) : null;
}

function setLastOpenedWorkspaceId(id) {
  writeAppState({
    lastOpenedWorkspaceId: id ? String(id) : null
  });
}

function sanitizeWorkspaceName(name) {
  return String(name || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .slice(0, 80) || 'Untitled Workspace';
}

function slugifyWorkspaceName(name) {
  return sanitizeWorkspaceName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace';
}

function workspaceFilePath(id) {
  return path.join(getWorkspacesDir(), `${id}.json`);
}

function createWorkspaceId(name) {
  return `${slugifyWorkspaceName(name)}-${Date.now().toString(36)}`;
}

function listWorkspaceSummaries() {
  ensureWorkspacesDir();
  return fs.readdirSync(getWorkspacesDir())
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      try {
        const fullPath = path.join(getWorkspacesDir(), entry);
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        return {
          id: String(data.id || entry.replace(/\.json$/i, '')),
          name: sanitizeWorkspaceName(data.name),
          createdAt: data.createdAt || null,
          updatedAt: data.updatedAt || null
        };
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function readWorkspace(id) {
  ensureWorkspacesDir();
  const fullPath = workspaceFilePath(String(id));
  if (!fs.existsSync(fullPath)) {
    throw new Error('Workspace not found');
  }
  const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  return {
    id: String(data.id || id),
    name: sanitizeWorkspaceName(data.name),
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    viewport: {
      panX: Number.isFinite(Number(data.viewport?.panX)) ? Number(data.viewport.panX) : 40,
      panY: Number.isFinite(Number(data.viewport?.panY)) ? Number(data.viewport.panY) : 40,
      scale: Number.isFinite(Number(data.viewport?.scale)) ? Number(data.viewport.scale) : 1
    },
    windows: Array.isArray(data.windows) ? data.windows.map((item) => ({
      title: typeof item?.title === 'string' ? item.title.slice(0, 200) : '',
      left: Number.isFinite(Number(item?.left)) ? Number(item.left) : 0,
      top: Number.isFinite(Number(item?.top)) ? Number(item.top) : 0,
      width: Number.isFinite(Number(item?.width)) ? Number(item.width) : 640,
      height: Number.isFinite(Number(item?.height)) ? Number(item.height) : 420,
      history: typeof item?.history === 'string' ? item.history.slice(-250000) : ''
    })) : [],
    notes: Array.isArray(data.notes) ? data.notes.map((item) => ({
      text: typeof item?.text === 'string' ? item.text.slice(0, 20000) : '',
      left: Number.isFinite(Number(item?.left)) ? Number(item.left) : 0,
      top: Number.isFinite(Number(item?.top)) ? Number(item.top) : 0,
      width: Number.isFinite(Number(item?.width)) ? Math.max(120, Number(item.width)) : 220,
      color: typeof item?.color === 'string' ? item.color.slice(0, 32) : '#ffffff',
      fontSize: Number.isFinite(Number(item?.fontSize)) ? Math.max(12, Math.min(64, Number(item.fontSize))) : 16,
      zIndex: Number.isFinite(Number(item?.zIndex)) ? Number(item.zIndex) : 5
    })) : [],
    clipboardEntries: Array.isArray(data.clipboardEntries) ? data.clipboardEntries.slice(0, 100).map((item) => ({
      text: typeof item?.text === 'string' ? item.text.slice(0, 20000) : '',
      source: typeof item?.source === 'string' ? item.source.slice(0, 40) : 'App',
      createdAt: Number.isFinite(Number(item?.createdAt)) ? Number(item.createdAt) : Date.now()
    })).filter((item) => item.text.trim()) : []
  };
}

function saveWorkspace(input = {}) {
  ensureWorkspacesDir();
  const name = sanitizeWorkspaceName(input.name);
  const id = input.id ? String(input.id) : createWorkspaceId(name);
  const existingPath = workspaceFilePath(id);
  const existing = fs.existsSync(existingPath)
    ? JSON.parse(fs.readFileSync(existingPath, 'utf8'))
    : null;
  const now = new Date().toISOString();
  const payload = {
    id,
    name,
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
    viewport: {
      panX: Number.isFinite(Number(input.viewport?.panX)) ? Number(input.viewport.panX) : 40,
      panY: Number.isFinite(Number(input.viewport?.panY)) ? Number(input.viewport.panY) : 40,
      scale: Number.isFinite(Number(input.viewport?.scale)) ? Number(input.viewport.scale) : 1
    },
    windows: Array.isArray(input.windows) ? input.windows.map((item) => ({
      title: typeof item?.title === 'string' ? item.title.slice(0, 200) : '',
      left: Number.isFinite(Number(item?.left)) ? Number(item.left) : 0,
      top: Number.isFinite(Number(item?.top)) ? Number(item.top) : 0,
      width: Number.isFinite(Number(item?.width)) ? Math.max(360, Number(item.width)) : 640,
      height: Number.isFinite(Number(item?.height)) ? Math.max(220, Number(item.height)) : 420,
      history: typeof item?.history === 'string' ? item.history.slice(-250000) : ''
    })) : [],
    notes: Array.isArray(input.notes) ? input.notes.map((item) => ({
      text: typeof item?.text === 'string' ? item.text.slice(0, 20000) : '',
      left: Number.isFinite(Number(item?.left)) ? Number(item.left) : 0,
      top: Number.isFinite(Number(item?.top)) ? Number(item.top) : 0,
      width: Number.isFinite(Number(item?.width)) ? Math.max(120, Number(item.width)) : 220,
      color: typeof item?.color === 'string' ? item.color.slice(0, 32) : '#ffffff',
      fontSize: Number.isFinite(Number(item?.fontSize)) ? Math.max(12, Math.min(64, Number(item.fontSize))) : 16,
      zIndex: Number.isFinite(Number(item?.zIndex)) ? Number(item.zIndex) : 5
    })) : [],
    clipboardEntries: Array.isArray(input.clipboardEntries) ? input.clipboardEntries.slice(0, 100).map((item) => ({
      text: typeof item?.text === 'string' ? item.text.slice(0, 20000) : '',
      source: typeof item?.source === 'string' ? item.source.slice(0, 40) : 'App',
      createdAt: Number.isFinite(Number(item?.createdAt)) ? Number(item.createdAt) : Date.now()
    })).filter((item) => item.text.trim()) : []
  };

  fs.writeFileSync(existingPath, JSON.stringify(payload, null, 2), 'utf8');

  return {
    id: payload.id,
    name: payload.name,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt
  };
}

function pickShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }

  const userShell = process.env.CANVAS_SHELL;
  const shellFromEtc = [];
  try {
    const etcShells = fs.readFileSync('/etc/shells', 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    shellFromEtc.push(...etcShells);
  } catch (_error) {
    // ignore
  }

  const candidates = [
    userShell,
    process.env.SHELL,
    ...shellFromEtc,
    '/bin/bash',
    '/usr/local/bin/bash',
    '/usr/bin/bash',
    '/bin/sh',
    '/usr/local/bin/sh',
    '/usr/bin/sh',
    '/bin/dash',
    '/usr/local/bin/dash',
    '/usr/bin/dash'
  ].filter(Boolean);

  for (const shell of candidates) {
    try {
      if (fs.existsSync(shell) && fs.statSync(shell).isFile()) {
        fs.accessSync(shell, fs.constants.X_OK);
        return shell;
      }
    } catch (_error) {
      continue;
    }
  }

  return 'sh';
}

function getShellArgs() {
  const shell = arguments[0];
  if (process.platform === 'win32') {
    return [];
  }

  const shellName = path.basename(shell || '');
  if (process.platform === 'darwin' && ['zsh', 'bash'].includes(shellName)) {
    return ['-l'];
  }

  return [];
}

function buildTerminalEnv() {
  const env = {
    ...process.env,
    PATH: process.env.PATH || '/bin:/usr/bin:/usr/local/bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'vscode',
    TERM_PROGRAM_VERSION: app.getVersion()
  };

  if (env.NO_COLOR) {
    delete env.NO_COLOR;
  }
  if (env.FORCE_COLOR === '0') {
    delete env.FORCE_COLOR;
  }
  if (!env.LANG) {
    env.LANG = 'en_US.UTF-8';
  }
  if (!env.LC_CTYPE) {
    env.LC_CTYPE = 'en_US.UTF-8';
  }

  return env;
}

function ensurePtySpawnHelperExecutable() {
  if (process.platform === 'win32') {
    return;
  }

  const platformKey = process.platform === 'darwin'
    ? `darwin-${process.arch}`
    : `linux-${process.arch}`;
  const helper = path.join(__dirname, 'node_modules', 'node-pty', 'prebuilds', platformKey, 'spawn-helper');

  try {
    if (fs.existsSync(helper)) {
      const mode = fs.statSync(helper).mode;
      if ((mode & 0o111) === 0) {
        fs.chmodSync(helper, mode | 0o755);
      }
    }
  } catch (_error) {
    // keep silent; spawn errors will be reported in the IPC result
  }
}

function spawnShell(id, options) {
  const candidates = [
    pickShell(),
    '/bin/zsh',
    '/bin/bash',
    '/usr/bin/bash',
    '/bin/sh',
    '/usr/bin/sh',
    '/bin/dash',
    '/usr/bin/dash',
    'sh'
  ];

  const terminalErrors = [];

  for (const shell of candidates) {
    try {
      const shellArgs = getShellArgs(shell);
      return {
        term: pty.spawn(shell, shellArgs, {
          name: 'xterm-256color',
          cols: options.cols,
          rows: options.rows,
          cwd: options.cwd,
          env: buildTerminalEnv()
        }),
        shell
      };
    } catch (error) {
      terminalErrors.push({
        shell,
        message: error?.message || String(error)
      });
      if (error?.code === 'EACCES' || error?.code === 'ENOENT') {
        continue;
      }
    }
  }

  const err = new Error('No available shell could be launched');
  err.message = `${err.message}: ${terminalErrors.map((item) => `${item.shell}(${item.message})`).join('; ')}`;
  err.cause = terminalErrors;
  throw err;
}

function normalizeTerminalOptions(opts = {}) {
  return {
    cols: Number.isFinite(Number(opts.cols)) ? Math.max(20, Math.floor(Number(opts.cols))) : 80,
    rows: Number.isFinite(Number(opts.rows)) ? Math.max(5, Math.floor(Number(opts.rows))) : 24,
    cwd: opts.cwd || os.homedir() || '/tmp'
  };
}

function sendTerminalStatus(id, status) {
  const key = String(id);
  const nextStatus = status || 'idle';
  if (terminalStatuses.get(key) === nextStatus) {
    return;
  }
  terminalStatuses.set(key, nextStatus);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal:status', { id: key, status: nextStatus });
  }
}

function getPsValue(pid, column) {
  const output = execFileSync('ps', ['-o', `${column}=`, '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
  const value = Number.parseInt(output, 10);
  return Number.isFinite(value) ? value : null;
}

function getTerminalRuntimeStatus(term) {
  if (!term?.pid) {
    return 'idle';
  }

  if (process.platform === 'win32') {
    return 'idle';
  }

  try {
    const shellPgid = getPsValue(term.pid, 'pgid');
    const foregroundPgid = getPsValue(term.pid, 'tpgid');
    if (!shellPgid || !foregroundPgid) {
      return 'idle';
    }
    return shellPgid === foregroundPgid ? 'idle' : 'running';
  } catch (_error) {
    return 'idle';
  }
}

function pollTerminalStatuses() {
  if (!terminalProcesses.size) {
    if (terminalStatusTimer) {
      clearInterval(terminalStatusTimer);
      terminalStatusTimer = null;
    }
    return;
  }

  terminalProcesses.forEach((term, id) => {
    sendTerminalStatus(id, getTerminalRuntimeStatus(term));
  });
}

function ensureTerminalStatusPolling() {
  if (terminalStatusTimer) {
    return;
  }
  terminalStatusTimer = setInterval(pollTerminalStatuses, 1200);
}

function hasRunningTerminals() {
  for (const status of terminalStatuses.values()) {
    if (status === 'running') {
      return true;
    }
  }
  return false;
}

function createWindow() {
  ensurePtySpawnHelperExecutable();
  ensureWorkspacesDir();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 700,
    backgroundColor: '#111318',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: 'Vibe Atlas'
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (event) => {
    if (allowWindowClose || !hasRunningTerminals()) {
      return;
    }

    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Quit Anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'Running terminals',
      message: 'There are still running terminals in this workspace.',
      detail: 'Quitting now will terminate those processes. Do you want to continue?'
    });

    if (choice === 1) {
      allowWindowClose = true;
      mainWindow.close();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
});

ipcMain.handle('terminal:create', async (_event, options = {}) => {
  try {
    const id = String(terminalSeq++);
    const normalized = normalizeTerminalOptions(options);
    const { term, shell } = spawnShell(id, normalized);

    terminalProcesses.set(id, term);
    terminalStatuses.delete(id);
    ensureTerminalStatusPolling();
    sendTerminalStatus(id, 'idle');

    term.onData((data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:data', { id, data });
      }
    });

    term.onExit(() => {
      terminalProcesses.delete(id);
      sendTerminalStatus(id, 'exited');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:exit', { id });
      }
    });

    return { ok: true, id };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      detail: error?.cause || null
    };
  }
});

ipcMain.handle('workspace:list', async () => {
  try {
    return { ok: true, workspaces: listWorkspaceSummaries() };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), workspaces: [] };
  }
});

ipcMain.handle('workspace:load', async (_event, id) => {
  try {
    const workspace = readWorkspace(id);
    setLastOpenedWorkspaceId(workspace.id);
    return { ok: true, workspace };
  } catch (error) {
    if (String(error?.message || '') === 'Workspace not found' && getLastOpenedWorkspaceId() === String(id)) {
      setLastOpenedWorkspaceId(null);
    }
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('workspace:save', async (_event, payload = {}) => {
  try {
    const workspace = saveWorkspace(payload.workspace || payload);
    setLastOpenedWorkspaceId(workspace.id);
    return { ok: true, workspace };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('workspace:last-opened', async () => {
  try {
    return { ok: true, id: getLastOpenedWorkspaceId() };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), id: null };
  }
});

ipcMain.on('terminal:input', (_event, payload) => {
  const terminal = terminalProcesses.get(payload?.id);
  if (!terminal) {
    return;
  }
  terminal.write(payload.data || '');
});

ipcMain.on('terminal:resize', (_event, payload) => {
  const terminal = terminalProcesses.get(payload?.id);
  if (!terminal) {
    return;
  }

  const cols = Number(payload.cols);
  const rows = Number(payload.rows);
  if (!Number.isNaN(cols) && !Number.isNaN(rows)) {
    terminal.resize(cols, rows);
  }
});

ipcMain.on('terminal:close', (_event, id) => {
  const terminal = terminalProcesses.get(String(id));
  if (!terminal) {
    return;
  }
  terminal.kill();
  terminalProcesses.delete(String(id));
  sendTerminalStatus(String(id), 'exited');
  pollTerminalStatuses();
});

function cleanupTerminals() {
  allowWindowClose = false;
  for (const terminal of terminalProcesses.values()) {
    terminal.kill();
  }
  terminalProcesses.clear();
  terminalStatuses.clear();
  if (terminalStatusTimer) {
    clearInterval(terminalStatusTimer);
    terminalStatusTimer = null;
  }
}

app.on('before-quit', cleanupTerminals);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
