// PanUrgos Studio Setup — the installation wizard (runs from Setup.exe's temp extraction folder).
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = (() => { try { return require('original-fs'); } catch { return require('fs'); } })(); // see ops.js
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sys = require('./system');
const ops = require('./ops');
const { Toolchains } = require('../toolchains');

app.setName('PanUrgos Studio Setup');
// Keep the wizard's Chromium profile out of the real user profile.
app.setPath('userData', path.join(os.tmpdir(), 'panurgos-setup-profile'));
app.commandLine.appendSwitch('disable-background-networking');

const VERSION = require('../../../package.json').version;
// Packaged: Setup.exe extracted the app next to us. Dev: use the electron-builder output.
const PAYLOAD = process.env.PANURGOS_PAYLOAD || (app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '../../../dist/win-unpacked'));
const REDIST = app.isPackaged ? path.join(PAYLOAD, 'redist', 'vc_redist.x64.exe') : path.resolve(__dirname, '../../../build/redist/vc_redist.x64.exe');
const DEFAULT_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs', 'PanUrgos Studio');
const LLAMA = (() => { try { return JSON.parse(fs.readFileSync(path.join(PAYLOAD, 'resources', 'llama.cpp', 'bundled.json'), 'utf8'))[0]; } catch { return { tag: 'bundled', backend: 'vulkan' }; } })();

let win;
let installing = false;
let installedDir = null;
const toolchains = new Toolchains();

function sizes() {
  const all = ops.listFiles(PAYLOAD, ['redist']).bytes;
  const llama = (() => { try { return ops.listFiles(path.join(PAYLOAD, 'resources', 'llama.cpp'), []).bytes; } catch { return 0; } })();
  return { total: all, llama, app: all - llama };
}

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1040, height: 680, resizable: false, maximizable: false, frame: false, show: false,
    backgroundColor: '#05060a', title: 'PanUrgos Studio Setup',
    icon: path.join(__dirname, '../../../build/icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  win.loadFile(path.join(__dirname, '../../renderer/installer/index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (!installing) return;
    e.preventDefault();
    dialog.showMessageBox(win, { type: 'warning', buttons: ['Keep installing', 'Cancel setup'], defaultId: 0, cancelId: 0,
      title: 'PanUrgos Studio Setup', message: 'Setup is still installing.', detail: 'Cancelling now may leave PanUrgos Studio partly installed. You can run Setup again later to repair it.' })
      .then((r) => { if (r.response === 1) { installing = false; app.exit(1); } });
  });
}

const h = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a));
h('win:minimize', () => win.minimize());
h('win:close', () => win.close());
h('setup:info', () => ({ version: VERSION, defaultDir: DEFAULT_DIR, llama: LLAMA, sizes: sizes(), license: readLicense() }));
h('setup:scan', async () => {
  const [hw, vc, existing, legacy, tools] = await Promise.all([sys.scanHardware(), sys.vcRedist(), sys.existingInstall(), sys.legacyInstall(), toolchains.detect()]);
  return { hw, vc, existing, legacy, tools, backend: sys.recommendBackend(hw) };
});
h('setup:dirInfo', async (dir) => {
  const abs = path.resolve(String(dir || ''));
  const bad = !/^[a-zA-Z]:\\/.test(abs) ? 'Choose a full path on a local drive.' : /\\Windows(\\|$)/i.test(abs) ? 'Choose a folder outside the Windows directory.' : null;
  const exists = fs.existsSync(abs);
  const nonEmpty = exists && fs.readdirSync(abs).length > 0 && !fs.existsSync(path.join(abs, ops.EXE));
  return { dir: abs, free: sys.diskFree(abs), error: bad, existingApp: fs.existsSync(path.join(abs, ops.EXE)), nonEmpty, running: exists ? await ops.runningFrom(abs) : false };
});
h('setup:browse', async (cur) => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose where to install PanUrgos Studio', defaultPath: cur, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return /panurgos studio$/i.test(p) ? p : path.join(p, 'PanUrgos Studio');
});
h('setup:install', (opts) => runInstall(opts));
h('setup:finish', ({ launch }) => {
  if (launch && installedDir) spawn(path.join(installedDir, ops.EXE), [], { detached: true, stdio: 'ignore', cwd: installedDir }).unref();
  app.quit();
});
h('setup:openExternal', (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

function readLicense() {
  for (const p of [path.join(PAYLOAD, 'resources', 'LICENSE.txt'), path.resolve(__dirname, '../../../LICENSE')]) {
    try { return fs.readFileSync(p, 'utf8'); } catch {}
  }
  return 'MIT License';
}

/**
 * Runs the install plan. Emits 'setup:progress' events: { step, state, detail, pct, log }.
 * Core steps abort on failure; optional components only warn.
 */
async function runInstall(o) {
  if (process.env.PANURGOS_SETUP_DRYRUN) return dryRun(o);
  installing = true;
  const send = (m) => win?.webContents.send('setup:progress', m);
  const log = (s) => send({ log: s });
  const dest = path.resolve(o.dir);
  const results = [];
  const step = async (id, label, fn, { optional = false } = {}) => {
    send({ step: id, state: 'run', detail: label });
    try { const r = await fn(); send({ step: id, state: 'done' }); results.push({ id, label, ok: true }); return r; }
    catch (e) {
      send({ step: id, state: optional ? 'warn' : 'fail', detail: e.message }); log(`\x1b[31m✗ ${label}: ${e.message}\x1b[0m\n`);
      results.push({ id, label, ok: false, error: e.message });
      if (!optional) throw e;
    }
  };
  try {
    if (await ops.runningFrom(dest)) throw new Error('PanUrgos Studio is running from this folder. Close it and try again.');
    log(`\x1b[90mInstalling PanUrgos Studio ${VERSION} to ${dest}\x1b[0m\n`);
    if (o.legacy) {
      await step('legacy', `Replacing ${o.legacy.name} ${o.legacy.version || ''}`.trim(), () => ops.uninstallLegacy(o.legacy));
      log(`[32m✔[0m Removed ${o.legacy.name} (settings, keys and models carry over to PanUrgos)
`);
    }
    await step('files', 'Installing PanUrgos Studio', () => ops.copyPayload(PAYLOAD, dest, (f, file) => send({ step: 'files', pct: f, detail: file ? `Copying ${file}` : '' })));
    log(`\x1b[32m✔\x1b[0m Editor and llama.cpp ${LLAMA.tag} (${LLAMA.backend}) installed\n`);
    await step('cli', 'Adding the panurgos command', async () => { ops.writeCli(dest); if (o.path) await ops.addToPath(dest); });
    if (o.path) log(`\x1b[32m✔\x1b[0m panurgos command added to PATH\n`);
    await step('shell', 'Registering with Windows', async () => {
      await ops.shortcuts(dest, { startMenu: o.startMenu, desktop: o.desktop });
      await ops.writeRegistry(dest, { fileTypes: o.fileTypes, contextMenu: o.contextMenu }, VERSION, ops.dirSizeKB(dest));
    });
    log(`\x1b[32m✔\x1b[0m Shortcuts${o.fileTypes ? ', file types' : ''}${o.contextMenu ? ', “Open with PanUrgos Studio”' : ''} registered\n`);
    if (o.vcredist) {
      await step('vcredist', 'Microsoft Visual C++ runtime', async () => {
        log('→ Installing Microsoft Visual C++ Redistributable (Windows will ask for permission)\n');
        await ops.installVcRedist(REDIST);
        log('\x1b[32m✔\x1b[0m Visual C++ runtime installed\n');
      });
    }
    if (o.cuda) await step('cuda', 'NVIDIA CUDA acceleration', async () => { ops.queueCuda(); log('\x1b[32m✔\x1b[0m CUDA build queued — downloads when PanUrgos first opens\n'); }, { optional: true });
    toolchains.removeAllListeners('data');
    toolchains.on('data', log);
    for (const id of o.tools || []) {
      await step(`tool:${id}`, id, async () => {
        const r = await toolchains.install(id);
        if (!r.ok) throw new Error(`winget exited with ${r.code}`);
      }, { optional: true });
    }
    installedDir = dest;
    log(`\n\x1b[32m✔ PanUrgos Studio ${VERSION} successfully installed!\x1b[0m\n`);
    return { ok: true, results, dir: dest };
  } catch (e) {
    return { ok: false, error: e.message, results };
  } finally {
    installing = false;
  }
}

/** Development aid: simulate an install (no files, registry or downloads) to review the UI. */
async function dryRun(o) {
  const send = (m) => win?.webContents.send('setup:progress', m);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ms = Number(process.env.PANURGOS_SETUP_DRYRUN) || 20000;
  send({ step: 'files', state: 'run', detail: 'Installing PanUrgos Studio' });
  for (let i = 1; i <= 50; i++) { await wait(ms * 0.6 / 50); send({ step: 'files', pct: i / 50, detail: `Copying resources\\app.asar` }); }
  send({ step: 'files', state: 'done' });
  const rest = ['cli', 'shell', ...(o.vcredist ? ['vcredist'] : []), ...(o.cuda ? ['cuda'] : []), ...(o.tools || []).map((t) => `tool:${t}`)];
  for (const s of rest) { send({ step: s, state: 'run', detail: s }); send({ log: `→ ${s}\n` }); await wait(ms * 0.4 / rest.length); send({ step: s, state: 'done' }); }
  installedDir = null;
  return { ok: true, results: [{ id: 'files', label: 'PanUrgos Studio', ok: true }, ...rest.map((id) => ({ id, label: id, ok: true }))], dir: o.dir };
}

// Development aid: PANURGOS_SMOKE=<dir> drives the wizard through scripted steps and screenshots each one.
if (process.env.PANURGOS_SMOKE) {
  app.whenReady().then(() => setTimeout(async () => {
    const out = process.env.PANURGOS_SMOKE;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const [i, s] of JSON.parse(process.env.PANURGOS_SMOKE_STEPS || '[]').entries()) {
      console.log('[smoke]', i, await win.webContents.executeJavaScript(s.js || '0').catch((e) => 'ERR ' + e.message));
      await wait(s.wait || 1200);
      fs.writeFileSync(path.join(out, `${String(i + 1).padStart(2, '0')}-${s.name}.png`), (await win.webContents.capturePage()).toPNG());
    }
    app.exit(0);
  }, 1500));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
