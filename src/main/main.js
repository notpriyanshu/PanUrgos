// PanUrgos Studio — main process.
const { app, BrowserWindow, ipcMain, dialog, session, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Store, PROVIDER_PRESETS } = require('./store');
const { Gateway } = require('./llm');
const { createNet } = require('./net');
const { LlamaRuntime } = require('./runtime');
const { ModelHub } = require('./hub');
const { Toolchains, freshEnv, detectProject } = require('./toolchains');

// ---- hard privacy defaults, applied before anything loads -------------------------------
app.commandLine.appendSwitch('disable-features', 'SpellcheckService,AutofillServerCommunication,MediaRouter,OptimizationHints,Translate,NetworkTimeServiceQuerying');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('disable-breakpad');
app.setName('PanUrgos Studio');
if (process.env.PANURGOS_SMOKE) app.setPath('userData', path.join(process.env.PANURGOS_SMOKE, 'userdata'));
else migrateLegacyData();

/**
 * The product was called "Umbra Studio" before it became PanUrgos. Move that profile (settings, encrypted
 * keys, models, llama.cpp builds) to the new folder once, and fix absolute paths saved inside it.
 */
function migrateLegacyData() {
  const appData = app.getPath('appData');
  const dest = path.join(appData, 'PanUrgos Studio');
  if (fs.existsSync(path.join(dest, 'settings.json'))) return;
  const src = path.join(appData, 'Umbra Studio');
  if (!fs.existsSync(path.join(src, 'settings.json')) && !fs.existsSync(path.join(src, 'runtime'))) return;
  try {
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true }); // only an empty/partial profile can be here
    try { fs.renameSync(src, dest); } catch { fs.cpSync(src, dest, { recursive: true }); } // copy if the old app still holds files open
    const from = JSON.stringify(src).slice(1, -1); const to = JSON.stringify(dest).slice(1, -1);
    for (const f of ['settings.json', path.join('runtime', 'llama.cpp', 'state.json')]) {
      const p = path.join(dest, f);
      if (fs.existsSync(p)) fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split(from).join(to));
    }
  } catch (e) { console.error('Profile migration failed:', e.message); }
}

let win;

// Native traffic lights on macOS; our own frameless title bar on Windows/Linux.
const WINDOW_CHROME = process.platform === 'darwin'
  ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 } }
  : { frame: false, titleBarStyle: 'hidden' };

/** macOS needs an app menu for ⌘C/⌘V/⌘Q to work; Windows/Linux use PanUrgos's own menus. */
function setAppMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
}
let store;
let gateway;
let runtime;
let hub;
let toolchains;
let setupWin = null;
let pendingOpen = null; // file or folder passed on the command line / from "Open with PanUrgos Studio"
let workspace = null;

// One running PanUrgos: a second launch (Explorer "Open with", `panurgos .`) hands its path to the first.
if (!process.env.PANURGOS_SMOKE && !app.requestSingleInstanceLock()) app.exit(0);

/** First real path argument, resolved against the caller's working directory. */
function pathFromArgv(argv, cwd = process.cwd()) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('--'));
  for (const a of args) {
    const p = path.resolve(cwd, a);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function openPath(p) {
  if (!p) return;
  const isDir = fs.statSync(p).isDirectory();
  workspace = isDir ? p : path.dirname(p);
  store.setSettings({ lastWorkspace: workspace });
  const payload = { root: workspace, name: path.basename(workspace), tree: readTree(workspace), file: isDir ? null : p };
  if (win && !win.webContents.isLoading()) win.webContents.send('app:open', payload);
  else pendingOpen = payload;
}
const pendingApprovals = new Map();

// ---- Network Ledger: every outbound request the app makes, visible to the user ---------
const ledger = {
  items: [],
  blocked: 0,
  add(e) { this.items.unshift(e); this.items = this.items.slice(0, 500); this.push(); },
  update(id, patch) { const e = this.items.find((x) => x.id === id); if (e) Object.assign(e, patch); this.push(); },
  push() { win?.webContents.send('ledger:update', { items: this.items.slice(0, 200), blocked: this.blocked }); },
  clear() { this.items = []; this.blocked = 0; this.push(); }
};

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 980, minHeight: 600,
    backgroundColor: '#0a0b10',
    ...WINDOW_CHROME,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false
    }
  });
  setAppMenu();
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.once('ready-to-show', () => win.show());

  // Dev-only smoke test hook: PANURGOS_SMOKE=<dir> runs a script in the UI, screenshots, and quits.
  if (process.env.PANURGOS_SMOKE) {
    win.webContents.on('console-message', (_e, level, message) => console.log(`[renderer:${level}] ${message}`));
    win.webContents.once('did-finish-load', async () => {
      const out = process.env.PANURGOS_SMOKE;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const shot = async (name) => fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
      try {
        await wait(2500); await shot('01-welcome');
        const steps = JSON.parse(process.env.PANURGOS_SMOKE_STEPS || '[]');
        for (const [i, s] of steps.entries()) {
          console.log('[smoke] step', i, await win.webContents.executeJavaScript(s.js).catch((e) => 'ERR ' + e.message));
          await wait(s.wait || 1500); await shot(String(i + 2).padStart(2, '0') + '-' + (s.name || 'step'));
        }
      } catch (e) { console.error('[smoke] failed', e); }
      app.quit();
    });
  }
  win.on('maximize', () => win.webContents.send('win:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('win:state', { maximized: false }));

  // Never let the renderer navigate away or open windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) dialog.showMessageBox(win, {
      type: 'question', buttons: ['Open in browser', 'Cancel'], defaultId: 1,
      title: 'External link', message: 'Open this link in your system browser?', detail: url
    }).then((r) => { if (r.response === 0) shell.openExternal(url); });
    return { action: 'deny' };
  });
}

function lockDownSession() {
  const ses = session.defaultSession;
  // Block every renderer request that isn't a local file / devtools / inline resource.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    if (/^(file|devtools|data|blob|chrome-extension):/.test(u)) return cb({});
    if (store?.getSettings().privacy.blockRendererNetwork === false) return cb({});
    ledger.blocked++;
    ledger.add({ id: Math.random().toString(36).slice(2), ts: Date.now(), method: details.method, url: u,
      host: (() => { try { return new URL(u).host; } catch { return u; } })(), local: false, purpose: 'renderer (blocked)', status: 'blocked', bytesOut: 0 });
    cb({ cancel: true });
  });
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
}

// ---- file system --------------------------------------------------------------------------
const IGNORE = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'target']);
function readTree(dir, depth = 0) {
  if (depth > 12) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((d) => !IGNORE.has(d.name))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
    .map((d) => {
      const full = path.join(dir, d.name);
      return d.isDirectory()
        ? { name: d.name, path: full, type: 'dir', children: depth < 1 ? readTree(full, depth + 1) : null }
        : { name: d.name, path: full, type: 'file' };
    });
}
function inWorkspace(p) {
  if (!workspace) return false;
  const r = path.resolve(workspace); const f = path.resolve(p);
  return f === r || f.startsWith(r + path.sep);
}
function guard(p) { if (!inWorkspace(p)) throw new Error('Access outside the open workspace is not allowed.'); return p; }

// ---- terminal (streamed shell commands, cwd-aware) ----------------------------------------
const terms = new Map();
async function termRun(id, command) {
  await freshEnv(); // pick up tools installed since PanUrgos started (winget, other terminals)
  const t = terms.get(id) || { cwd: workspace || app.getPath('home'), proc: null };
  terms.set(id, t);
  const send = (data) => win?.webContents.send('term:data', { id, data });
  const trimmed = command.trim();
  const cd = trimmed.match(/^cd\s*(.*)$/i);
  if (cd) {
    const target = cd[1].replace(/^["']|["']$/g, '') || app.getPath('home');
    const next = path.resolve(t.cwd, target.replace(/^~/, app.getPath('home')));
    if (fs.existsSync(next) && fs.statSync(next).isDirectory()) t.cwd = next;
    else send(`\x1b[31mcd: no such directory: ${target}\x1b[0m\n`);
    win?.webContents.send('term:exit', { id, code: 0, cwd: t.cwd });
    return;
  }
  const isWin = process.platform === 'win32';
  const proc = isWin
    ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `$ProgressPreference='SilentlyContinue'; ${command}`], { cwd: t.cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: '1' } })
    : spawn(process.env.SHELL || '/bin/bash', ['-lc', command], { cwd: t.cwd, env: { ...process.env, FORCE_COLOR: '1' } });
  t.proc = proc;
  proc.stdout.on('data', (d) => send(d.toString()));
  proc.stderr.on('data', (d) => send(`\x1b[31m${d.toString()}\x1b[0m`));
  proc.on('close', (code) => { t.proc = null; win?.webContents.send('term:exit', { id, code, cwd: t.cwd }); });
  proc.on('error', (e) => { send(`\x1b[31m${e.message}\x1b[0m\n`); });
}

// ---- IPC -------------------------------------------------------------------------------------
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => fn(...a));

  h('win:minimize', () => win.minimize());
  h('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  h('win:close', () => win.close());
  h('app:info', () => ({ version: app.getVersion(), platform: process.platform, electron: process.versions.electron,
    userData: app.getPath('userData'), encryption: store.encryptionAvailable() }));

  h('fs:openFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    workspace = r.filePaths[0];
    terms.forEach((t) => (t.cwd = workspace));
    store.setSettings({ lastWorkspace: workspace });
    return { root: workspace, name: path.basename(workspace), tree: readTree(workspace) };
  });
  h('app:pendingOpen', () => { const p = pendingOpen; pendingOpen = null; return p; });
  h('fs:restore', () => {
    const last = store.getSettings().lastWorkspace;
    if (last && fs.existsSync(last)) { workspace = last; return { root: workspace, name: path.basename(workspace), tree: readTree(workspace) }; }
    return null;
  });
  h('fs:closeFolder', () => { workspace = null; store.setSettings({ lastWorkspace: '' }); return true; });
  h('fs:readDir', (p) => readTree(guard(p), 1));
  h('fs:tree', () => (workspace ? readTree(workspace) : []));
  h('fs:readFile', (p) => {
    guard(p);
    const st = fs.statSync(p);
    if (st.size > 8 * 1024 * 1024) throw new Error('File is larger than 8 MB.');
    const buf = fs.readFileSync(p);
    if (buf.subarray(0, 8000).includes(0)) return { binary: true, content: '' };
    return { binary: false, content: buf.toString('utf8') };
  });
  h('fs:writeFile', (p, content) => { guard(p); fs.writeFileSync(p, content, 'utf8'); return true; });
  h('fs:create', (p, isDir) => {
    guard(p);
    if (fs.existsSync(p)) throw new Error('Already exists');
    if (isDir) fs.mkdirSync(p, { recursive: true }); else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); }
    return true;
  });
  h('fs:rename', (from, to) => { guard(from); guard(to); fs.renameSync(from, to); return true; });
  h('fs:delete', async (p) => { guard(p); await shell.trashItem(p); return true; });
  h('fs:reveal', (p) => { guard(p); shell.showItemInFolder(p); });
  h('fs:search', (query) => {
    if (!workspace || !query) return [];
    const out = []; const q = query.toLowerCase();
    const walk = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= 500 || IGNORE.has(d.name) || d.name.startsWith('.')) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) { walk(full); continue; }
        try {
          if (fs.statSync(full).size > 1_000_000) continue;
          const buf = fs.readFileSync(full); if (buf.subarray(0, 4000).includes(0)) continue;
          buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
            if (out.length < 500 && line.toLowerCase().includes(q)) out.push({ path: full, rel: path.relative(workspace, full), line: i + 1, text: line.trim().slice(0, 240) });
          });
        } catch {}
      }
    };
    walk(workspace);
    return out;
  });
  h('fs:allFiles', () => {
    if (!workspace) return [];
    const out = [];
    const walk = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (out.length > 5000 || IGNORE.has(d.name) || d.name === '.git') continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walk(full); else out.push({ path: full, rel: path.relative(workspace, full) });
      }
    };
    walk(workspace);
    return out;
  });

  h('settings:get', () => ({ settings: store.getSettings(), presets: PROVIDER_PRESETS, secrets: store.secretHints() }));
  h('settings:set', (patch) => store.setSettings(patch));
  h('settings:reset', () => store.resetSettings());
  h('secret:set', (id, value) => { store.setSecret(id, value); return store.secretHints(); });
  h('privacy:wipe', () => { const s = store.wipeAll(); ledger.clear(); return s; });

  h('ledger:get', () => ({ items: ledger.items, blocked: ledger.blocked }));
  h('ledger:clear', () => ledger.clear());

  h('llm:models', (pid) => gateway.listModels(pid));
  h('llm:test', async (pid) => {
    const t = Date.now();
    const models = await gateway.listModels(pid);
    return { ok: true, ms: Date.now() - t, models };
  });
  h('llm:chat', (reqId, payload) => {
    gateway.chat(reqId, payload, (type, data) => win?.webContents.send('llm:event', { reqId, type, data }));
    return true;
  });
  h('llm:cancel', (reqId) => gateway.cancel(reqId));
  h('llm:complete', (messages, pid) => gateway.complete(messages, pid));
  h('agent:approve', (id, ok) => { pendingApprovals.get(id)?.(ok); pendingApprovals.delete(id); });

  // ---- built-in llama.cpp runtime
  h('runtime:status', async () => { if (!runtime.hw) await runtime.detectHardware(); return runtime.status(); });
  h('runtime:check', () => runtime.checkForUpdate());
  h('runtime:install', () => runtime.install());
  h('runtime:rollback', (id) => runtime.rollback(id));
  h('runtime:start', async (modelPath) => {
    store.setSettings({ local: { lastModel: modelPath } });
    return runtime.start(modelPath);
  });
  h('runtime:stop', () => runtime.stop());
  h('runtime:logs', () => runtime.logs.join('\n'));

  // ---- Hugging Face + local model library
  h('hub:search', (q, opts) => hub.search(q, opts));
  h('hub:files', (repo) => hub.files(repo));
  h('hub:download', (repo, variant) => hub.download(repo, variant));
  h('hub:cancel', (id) => hub.cancel(id));
  h('hub:jobs', () => hub.activeJobs());
  h('models:list', () => ({ models: hub.list(), dir: hub.modelsDir, scanned: hub.scanDirs().map((d) => d.dir) }));
  h('models:delete', async (p) => {
    if (!hub.inModelsDir(p)) throw new Error('Only models downloaded by PanUrgos can be deleted here.');
    if (store.getSettings().local.lastModel === p) { await runtime.stop(); store.setSettings({ local: { lastModel: '' } }); }
    await shell.trashItem(p);
    return true;
  });
  h('models:reveal', (p) => shell.showItemInFolder(p));
  h('models:chooseDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    store.setSettings({ local: { modelsDir: r.filePaths[0] } });
    return r.filePaths[0];
  });

  // ---- toolchains + project dependencies
  h('tools:detect', () => toolchains.detect());
  h('tools:install', (id) => toolchains.install(id));
  h('tools:project', () => detectProject(workspace));
  h('tools:openDefaultApps', () => shell.openExternal('ms-settings:defaultapps?registeredAppUser=PanUrgos%20Studio'));

  // ---- first-run setup window
  h('setup:finish', (opts = {}) => {
    store.setSettings({ setupDone: true });
    if (opts.installCuda) {
      // The user ticked “CUDA acceleration”, which is consent to download it from github.com.
      store.setSettings({ privacy: { allowUpdates: true }, local: { backend: 'auto' } });
      runtime.detectHardware().then(() => runtime.install()).catch((e) => win?.webContents.send('runtime:event', { type: 'crash', data: `CUDA download failed: ${e.message}` }));
    }
    if (!win) createWindow();
    setupWin?.close();
  });
  h('setup:open', () => openSetup());
  h('setup:info', async () => {
    if (!runtime.hw) await runtime.detectHardware();
    const st = runtime.status();
    return { version: app.getVersion(), installDir: process.platform === 'darwin' ? path.resolve(process.execPath, '../../..') : path.dirname(process.execPath), hardware: st.hardware, runtime: st.active, backend: st.backend, packaged: app.isPackaged, platform: process.platform, arch: process.arch };
  });

  h('term:run', (id, cmd) => termRun(id, cmd));
  h('term:kill', (id) => { const t = terms.get(id); t?.proc?.kill(); });
  h('term:cwd', (id) => (terms.get(id)?.cwd || workspace || app.getPath('home')));
}

app.whenReady().then(() => {
  store = new Store();
  if (process.env.PANURGOS_SMOKE_SETTINGS) store.setSettings(JSON.parse(process.env.PANURGOS_SMOKE_SETTINGS));
  const netApi = createNet({ ledger, getSettings: () => store.getSettings(), getSecret: (id) => store.getSecret(id) });
  const dataDir = process.env.PANURGOS_RUNTIME_DIR || app.getPath('userData');
  runtime = new LlamaRuntime({ dir: dataDir, net: netApi, getSettings: () => store.getSettings() });
  hub = new ModelHub({ net: netApi, getSettings: () => store.getSettings(), defaultDir: path.join(dataDir, 'models') });
  runtime.on('status', (s) => win?.webContents.send('runtime:event', { type: 'status', data: s }));
  runtime.on('progress', (p) => win?.webContents.send('runtime:event', { type: 'progress', data: p }));
  runtime.on('log', (l) => win?.webContents.send('runtime:event', { type: 'log', data: l }));
  runtime.on('crash', (msg) => win?.webContents.send('runtime:event', { type: 'crash', data: msg }));
  hub.on('progress', (j) => win?.webContents.send('hub:progress', j));
  runtime.detectHardware().then(() => launchUpdateCheck()).catch(() => {});
  // The installer may queue the CUDA build (the user ticked it in Setup, which is consent to download it).
  const firstRun = path.join(app.getPath('userData'), 'first-run.json');
  if (fs.existsSync(firstRun)) {
    try {
      const fr = JSON.parse(fs.readFileSync(firstRun, 'utf8'));
      fs.rmSync(firstRun, { force: true });
      if (fr.installCuda) {
        store.setSettings({ privacy: { allowUpdates: true }, local: { backend: 'auto' } });
        runtime.detectHardware().then(() => runtime.install())
          .then(() => win?.webContents.send('runtime:event', { type: 'notice', data: 'CUDA acceleration installed — it’s used the next time a model loads.' }))
          .catch((e) => win?.webContents.send('runtime:event', { type: 'crash', data: `CUDA download failed: ${e.message}. Retry from the Models panel.` }));
      }
    } catch {}
  }
  gateway = new Gateway({
    store, ledger, runtime,
    getWorkspace: () => workspace,
    requestApproval: (req) => new Promise((resolve) => {
      pendingApprovals.set(req.id, resolve);
      win?.webContents.send('agent:approval', req);
    })
  });
  toolchains = new Toolchains();
  // Stream installer output into PanUrgos's integrated terminal so it reads like a normal shell session.
  toolchains.on('data', (d) => { win?.webContents.send('term:data', { id: 'main', data: d }); setupWin?.webContents.send('setup:log', d); });
  lockDownSession();
  registerIpc();
  const target = pathFromArgv(process.argv);
  // `--setup` is passed by the installer; it shows the first-run screen with optional components.
  // Windows gets the Setup wizard from Setup.exe; macOS/Linux have no installer step, so the setup
  // screen (system check + optional components) opens on the first launch of a packaged build.
  const firstLaunchSetup = app.isPackaged && process.platform !== 'win32' && !store.getSettings().setupDone;
  if ((process.argv.includes('--setup') || firstLaunchSetup) && !store.getSettings().setupDone) openSetup();
  else createWindow();
  if (target) openPath(target);
});

app.on('second-instance', (_e, argv, cwd) => {
  const p = pathFromArgv(argv, cwd);
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
  if (p) openPath(p);
});

function openSetup() {
  if (setupWin) { setupWin.focus(); return; }
  setupWin = new BrowserWindow({
    width: 860, height: 640, resizable: false, maximizable: false, ...WINDOW_CHROME, backgroundColor: '#07080c', show: false,
    title: 'PanUrgos Setup',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  setupWin.loadFile(path.join(__dirname, '../renderer/setup.html'));
  setupWin.once('ready-to-show', () => setupWin.show());
  setupWin.webContents.on('will-navigate', (e) => e.preventDefault());
  setupWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // Closing the setup window counts as “Skip”: open the editor rather than quitting.
  setupWin.on('closed', () => { setupWin = null; if (!win) { store.setSettings({ setupDone: true }); createWindow(); } });
}

/** On launch: check for a newer llama.cpp build only if the user allowed update checks. */
async function launchUpdateCheck() {
  const s = store.getSettings();
  if (!s.privacy.allowUpdates || !s.local.checkOnLaunch || !runtime.activeInstall()) return;
  try {
    const info = await runtime.checkForUpdate();
    if (!info.available) return;
    if (s.local.autoUpdate) {
      await runtime.install();
      win?.webContents.send('runtime:event', { type: 'notice', data: `llama.cpp updated to ${info.tag}. It takes effect the next time a model loads.` });
    } else {
      win?.webContents.send('runtime:event', { type: 'update', data: info });
    }
  } catch { /* offline or blocked: stay quiet */ }
}

app.on('before-quit', () => { runtime?.stop(); });
app.on('window-all-closed', () => {
  // macOS convention: the app stays in the Dock until Quit; elsewhere closing the last window quits.
  if (process.platform === 'darwin') { win = null; return; }
  terms.forEach((t) => t.proc?.kill()); runtime?.stop(); app.quit();
});
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});
