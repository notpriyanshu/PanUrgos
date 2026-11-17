// PanUrgos Studio — built-in llama.cpp runtime manager.
//
// Installs official llama.cpp builds from github.com/ggml-org/llama.cpp, keeps the previous build
// for rollback, and runs `llama-server` as a managed sidecar bound to 127.0.0.1 on a random port.
// llama-server speaks the OpenAI-compatible API, so PanUrgos's chat, agent tools and Ctrl+K reuse
// the existing gateway unchanged.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');

const REPO_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20';
const BUILD_TAG = /^b(\d+)$/;

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => resolve({ err, out: `${stdout || ''}${stderr || ''}` }));
  });
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const buildNum = (tag) => Number((BUILD_TAG.exec(tag || '') || [])[1] || 0);
const verCmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); return (x[0] - y[0]) || ((x[1] || 0) - (y[1] || 0)); };

class LlamaRuntime extends EventEmitter {
  constructor({ dir, net: netApi, getSettings }) {
    super();
    this.root = path.join(dir, 'runtime', 'llama.cpp');
    this.dlDir = path.join(this.root, 'downloads');
    this.stateFile = path.join(this.root, 'state.json');
    this.net = netApi;
    this.getSettings = getSettings;
    this.hw = null;
    this.proc = null;
    this.server = { state: 'stopped', model: null, port: null, error: null };
    this.logs = [];
    this.installing = null;
    this.updateInfo = null;
    fs.mkdirSync(this.dlDir, { recursive: true });
    this.state = this._readState();
    this._registerBundled();
  }

  /**
   * The installer ships a ready-to-run llama.cpp build in resources/llama.cpp, so PanUrgos works offline
   * from the first launch. Bundled builds are read-only: never pruned, and updates install next to them.
   */
  _registerBundled() {
    const dir = process.resourcesPath ? path.join(process.resourcesPath, 'llama.cpp') : null;
    if (!dir || !fs.existsSync(path.join(dir, 'bundled.json'))) return;
    let list = [];
    try { list = JSON.parse(fs.readFileSync(path.join(dir, 'bundled.json'), 'utf8')); } catch { return; }
    // Forget bundled builds from an earlier install that no longer exists (old version, old app name).
    const before = this.state.installs.length;
    this.state.installs = this.state.installs.filter((i) => !i.bundled || fs.existsSync(i.exe));
    let changed = this.state.installs.length !== before;
    for (const b of list) {
      const exe = path.join(dir, b.folder, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
      if (!fs.existsSync(exe)) continue;
      const id = `${b.tag}-${b.backend}-bundled`;
      const rec = { id, tag: b.tag, backend: b.backend, version: b.version || b.tag, dir: path.dirname(exe), exe, installedAt: b.builtAt || 0, bundled: true };
      const i = this.state.installs.findIndex((x) => x.id === id);
      if (i === -1) { this.state.installs.push(rec); changed = true; }
      else if (this.state.installs[i].exe !== exe) { this.state.installs[i] = rec; changed = true; } // app moved/updated
    }
    // First launch, or the active build vanished: use the bundled one.
    if (!this.activeInstall()) {
      const b = this.state.installs.find((x) => x.bundled && fs.existsSync(x.exe));
      if (b) { this.state.active = b.id; changed = true; }
    }
    if (changed) this._saveState();
  }

  // ------------------------------------------------------------------ state
  _readState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return { installs: [], active: null }; }
  }
  _saveState() { fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2)); }
  activeInstall() {
    const a = this.state.installs.find((i) => i.id === this.state.active);
    return a && fs.existsSync(a.exe) ? a : null;
  }
  status() {
    const a = this.activeInstall();
    return {
      installed: !!a,
      active: a ? { tag: a.tag, backend: a.backend, version: a.version, installedAt: a.installedAt, bundled: !!a.bundled } : null,
      previous: this.state.installs.filter((i) => i.id !== this.state.active && fs.existsSync(i.exe)).map((i) => ({ id: i.id, tag: i.tag, backend: i.backend })),
      server: { ...this.server },
      installing: this.installing,
      update: this.updateInfo,
      hardware: this.hw,
      backend: this.resolveBackend()
    };
  }
  _emit() { this.emit('status', this.status()); }

  // ------------------------------------------------------------------ hardware + backend
  async detectHardware() {
    const hw = { platform: process.platform, arch: process.arch, ramMB: Math.round(os.totalmem() / 1048576), gpus: [], cuda: null, vulkan: false };
    const q = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
    if (!q.err) {
      hw.gpus = q.out.trim().split(/\r?\n/).filter(Boolean).map((l) => { const [name, mem] = l.split(','); return { vendor: 'nvidia', name: name.trim(), vramMB: Number(mem) || 0 }; });
      const head = await run('nvidia-smi', []);
      // Older drivers print "CUDA Version: 12.4", newer ones "CUDA UMD Version: 13.5".
      const m = /CUDA(?: UMD| Driver)? Version:\s*([\d.]+)/i.exec(head.out);
      if (m) hw.cuda = m[1];
    }
    if (process.platform === 'win32') hw.vulkan = fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'vulkan-1.dll'));
    else if (process.platform === 'linux') hw.vulkan = ['/usr/lib/x86_64-linux-gnu/libvulkan.so.1', '/usr/lib/libvulkan.so.1'].some((p) => fs.existsSync(p));
    this.hw = hw;
    return hw;
  }

  /** Backends offered for this platform, best first. */
  backendsForPlatform() {
    if (process.platform === 'darwin') return ['metal'];
    if (process.platform === 'win32') return process.arch === 'arm64' ? ['cpu', 'vulkan'] : ['cuda-13.5', 'cuda-12.4', 'vulkan', 'cpu'];
    return ['cuda-13.5', 'cuda-12.8', 'vulkan', 'cpu'];
  }
  resolveBackend() {
    const choice = this.getSettings().local?.backend || 'auto';
    if (choice !== 'auto') return choice;
    if (process.platform === 'darwin') return 'metal';
    const hw = this.hw || {};
    if (hw.gpus?.some((g) => g.vendor === 'nvidia') && hw.cuda && process.arch !== 'arm64') {
      const want = this.backendsForPlatform().filter((b) => b.startsWith('cuda-'));
      const fit = want.find((b) => verCmp(hw.cuda, b.slice(5)) >= 0);
      if (fit) return fit;
    }
    if (hw.vulkan) return 'vulkan';
    return 'cpu';
  }
  _assetPatterns(backend) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const esc = (s) => s.replace(/\./g, '\\.');
    if (process.platform === 'win32') {
      if (backend.startsWith('cuda-')) {
        const v = esc(backend.slice(5));
        return { main: new RegExp(`^llama-b\\d+-bin-win-cuda-${v}-${arch}\\.zip$`), extra: new RegExp(`^cudart-llama-bin-win-cuda-${v}-${arch}\\.zip$`) };
      }
      return { main: new RegExp(`^llama-b\\d+-bin-win-${backend === 'vulkan' ? 'vulkan' : 'cpu'}-${arch}\\.zip$`) };
    }
    if (process.platform === 'darwin') return { main: new RegExp(`^llama-b\\d+-bin-macos-${arch}\\.tar\\.gz$`) };
    if (backend.startsWith('cuda-')) {
      const v = esc(backend.slice(5));
      return { main: new RegExp(`^llama-b\\d+-bin-ubuntu-cuda-${v}-${arch}\\.tar\\.gz$`), extra: new RegExp(`^cudart-llama-b\\d+-bin-ubuntu-cuda-${v}-${arch}\\.tar\\.gz$`) };
    }
    return { main: new RegExp(`^llama-b\\d+-bin-ubuntu-${backend === 'vulkan' ? 'vulkan-' : ''}${arch}\\.tar\\.gz$`) };
  }

  // ------------------------------------------------------------------ updates
  /** Find the newest build that has every file this machine needs (builds upload asynchronously). */
  async checkForUpdate() {
    if (!this.hw) await this.detectHardware();
    const backend = this.resolveBackend();
    const pats = this._assetPatterns(backend);
    const releases = await this.net.getJson(REPO_API, { scope: 'updates', purpose: 'check llama.cpp builds', headers: { Accept: 'application/vnd.github+json' } });
    const builds = releases.filter((r) => BUILD_TAG.test(r.tag_name) && !r.draft).sort((a, b) => buildNum(b.tag_name) - buildNum(a.tag_name));
    for (const r of builds) {
      const main = r.assets.find((a) => pats.main.test(a.name));
      const extra = pats.extra ? r.assets.find((a) => pats.extra.test(a.name)) : null;
      if (!main || (pats.extra && !extra)) continue;
      const pick = (a) => a && { name: a.name, url: a.browser_download_url, size: a.size, sha256: (a.digest || '').startsWith('sha256:') ? a.digest.slice(7) : null };
      const current = this.activeInstall();
      this.updateInfo = {
        tag: r.tag_name, publishedAt: r.published_at, backend, main: pick(main), extra: pick(extra),
        notesUrl: r.html_url, checkedAt: Date.now(),
        available: !current || current.backend !== backend || buildNum(r.tag_name) > buildNum(current.tag)
      };
      this._emit();
      return this.updateInfo;
    }
    throw new Error(`No recent llama.cpp build has a ${backend} package for this platform.`);
  }

  async install({ signal } = {}) {
    if (this.installing) throw new Error('An install is already running.');
    const info = this.updateInfo && this.updateInfo.backend === this.resolveBackend() ? this.updateInfo : await this.checkForUpdate();
    const id = `${info.tag}-${info.backend}`;
    const target = path.join(this.root, id);
    this.installing = { tag: info.tag, backend: info.backend, phase: 'download', file: info.main.name, received: 0, total: info.main.size + (info.extra?.size || 0) };
    this._emit();
    const progress = (base) => ({ received, total }) => { this.installing = { ...this.installing, received: base + received }; this.emit('progress', this.installing); };
    try {
      // 1) core build
      const mainZip = path.join(this.dlDir, info.main.name);
      if (!fs.existsSync(mainZip)) {
        await this.net.download(info.main.url, mainZip, { scope: 'updates', purpose: `download ${info.main.name}`, sha256: info.main.sha256, size: info.main.size, signal, onProgress: progress(0) });
      }
      // 2) runtime libraries (CUDA). Not versioned per build, so reuse a cached copy.
      let extraZip = null;
      if (info.extra) {
        this.installing = { ...this.installing, file: info.extra.name };
        extraZip = path.join(this.dlDir, info.extra.name);
        const cached = fs.existsSync(extraZip) && fs.statSync(extraZip).size === info.extra.size;
        if (!cached) {
          fs.rmSync(extraZip, { force: true });
          await this.net.download(info.extra.url, extraZip, { scope: 'updates', purpose: `download ${info.extra.name}`, sha256: info.extra.sha256, size: info.extra.size, signal, onProgress: progress(info.main.size) });
        }
      }
      // 3) extract into a fresh folder, then swap in
      this.installing = { ...this.installing, phase: 'extract' }; this._emit();
      const tmp = target + '.tmp';
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      await this._extract(mainZip, tmp);
      const exe = this._findExe(tmp);
      if (!exe) throw new Error('llama-server was not found in the downloaded package.');
      if (extraZip) await this._extract(extraZip, path.dirname(exe));
      if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);

      // 4) smoke-test the binary
      this.installing = { ...this.installing, phase: 'verify' }; this._emit();
      const v = await run(exe, ['--version'], 20000);
      const version = (/version:\s*(\S+)/i.exec(v.out) || [])[1] || info.tag;
      if (v.err && !/version/i.test(v.out)) throw new Error(`The new build failed to start: ${v.out.trim().split(/\r?\n/).slice(-3).join(' ')}`);

      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(tmp, target);
      const rec = { id, tag: info.tag, backend: info.backend, version, dir: target, exe: path.join(target, path.relative(tmp, exe)), installedAt: Date.now() };
      this.state.installs = [rec, ...this.state.installs.filter((i) => i.id !== id)];
      const prev = this.state.active;
      this.state.active = id;
      this._prune(prev);
      this._saveState();
      fs.rmSync(mainZip, { force: true }); // keep the CUDA runtime zip cached; drop the build zip
      this.updateInfo = { ...info, available: false };
      return this.status();
    } finally {
      this.installing = null;
      this._emit();
    }
  }

  /** Keep the active build plus the one before it; remove the rest. */
  _prune(previousId) {
    const keep = new Set([this.state.active, previousId]);
    for (const i of this.state.installs) {
      if (keep.has(i.id) || i.bundled) continue;
      if (this.proc && this.server.exe && this.server.exe.startsWith(i.dir)) continue; // in use
      try { fs.rmSync(i.dir, { recursive: true, force: true }); } catch {}
    }
    this.state.installs = this.state.installs.filter((i) => (keep.has(i.id) || i.bundled) && fs.existsSync(i.exe));
  }

  rollback(id) {
    const target = this.state.installs.find((i) => i.id === id && i.id !== this.state.active);
    if (!target) throw new Error('No previous build to roll back to.');
    this.state.active = target.id;
    this._saveState();
    this._emit();
    return this.status();
  }

  _extract(archive, dest) {
    return new Promise((resolve, reject) => {
      // Windows 10+ ships bsdtar, which unpacks .zip as well as .tar.gz.
      const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      const p = spawn(tar, ['-xf', archive, '-C', dest], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Could not unpack ${path.basename(archive)}: ${err.trim().slice(0, 300)}`))));
      p.on('error', reject);
    });
  }
  _findExe(dir) {
    const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name === name) return full;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ server
  get baseUrl() { return this.server.port ? `http://127.0.0.1:${this.server.port}/v1` : null; }

  async start(modelPath) {
    const inst = this.activeInstall();
    if (!inst) throw new Error('llama.cpp is not installed yet. Install it from the Models panel.');
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found: ${modelPath}`);
    await this.stop();
    const s = this.getSettings().local || {};
    const port = await freePort();
    const alias = path.basename(modelPath).replace(/\.gguf$/i, '');
    // Lock the sidecar down: a fresh random API key per session (passed via a file that is deleted once the
    // server is up, so it never shows in the process list), same-origin CORS only so web pages in a browser
    // can't call it, no built-in web UI, and no /slots endpoint that could expose cached prompts.
    this.apiKey = crypto.randomBytes(32).toString('hex');
    const keyFile = path.join(this.root, `.session-${process.pid}.key`);
    fs.writeFileSync(keyFile, this.apiKey + '\n', { mode: 0o600 });
    const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-c', String(s.ctxSize || 8192),
      '-ngl', String(s.gpuLayers ?? 999), '--jinja', '--alias', alias,
      '--api-key-file', keyFile, '--cors-origins', 'localhost', '--no-webui', '--no-slots'];
    if (s.threads > 0) args.push('-t', String(s.threads));
    if (s.extraArgs) args.push(...String(s.extraArgs).split(/\s+/).filter(Boolean));

    this.logs = [];
    this.server = { state: 'starting', model: modelPath, alias, port, error: null, exe: inst.exe, startedAt: Date.now() };
    this._emit();
    const proc = spawn(inst.exe, args, { cwd: path.dirname(inst.exe), windowsHide: true });
    this.proc = proc;
    const onLine = (d) => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) this.logs.push(line);
      if (this.logs.length > 800) this.logs = this.logs.slice(-800);
      this.emit('log', d.toString());
    };
    proc.stdout.on('data', onLine);
    proc.stderr.on('data', onLine);
    proc.on('exit', (code) => {
      fs.rmSync(keyFile, { force: true });
      if (this.proc !== proc) return;
      this.proc = null;
      const wasReady = this.server.state === 'ready';
      this.server = { ...this.server, state: code === 0 || this.server.state === 'stopping' ? 'stopped' : 'error',
        error: code === 0 ? null : this._explainCrash(), port: null };
      if (wasReady && this.server.state === 'error') this.emit('crash', this.server.error);
      this._emit();
    });

    this.ready = (async () => {
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        if (this.proc !== proc) throw new Error(this.server.error || 'llama-server exited while loading the model.');
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
          if (r.ok) {
            fs.rmSync(keyFile, { force: true });
            this.server = { ...this.server, state: 'ready', loadMs: Date.now() - this.server.startedAt };
            this._emit();
            return this.server;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
      await this.stop();
      throw new Error('Timed out waiting for the model to load.');
    })();
    return this.ready;
  }

  _explainCrash() {
    const tail = this.logs.slice(-12).join('\n');
    if (/out of memory|cudaMalloc failed|failed to allocate/i.test(tail)) return 'Ran out of GPU memory. Lower “GPU layers” or the context size in Settings › Local Runtime, or pick a smaller quantization.';
    if (/unknown model architecture|failed to load model/i.test(tail)) return 'This llama.cpp build could not load the model. Try updating llama.cpp, or pick another GGUF.';
    if (/error while loading shared libraries|\.dll was not found|0xc0000135/i.test(tail)) return 'A runtime library is missing. Reinstall llama.cpp or switch the backend to Vulkan/CPU.';
    return `llama-server stopped unexpectedly:\n${tail.split('\n').slice(-4).join('\n')}`;
  }

  async stop() {
    const p = this.proc;
    if (!p) { if (this.server.state !== 'stopped') { this.server = { state: 'stopped', model: this.server.model, port: null, error: null }; this._emit(); } return; }
    this.server = { ...this.server, state: 'stopping' };
    this.proc = null;
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(); }, 4000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      try { p.kill(); } catch { resolve(); }
    });
    this.server = { state: 'stopped', model: this.server.model, port: null, error: null };
    this._emit();
  }

  /** Called by the gateway before a chat request routed to the built-in runtime. */
  async ensureRunning(onInfo) {
    if (this.server.state === 'ready' && this.proc) return this.server;
    if (this.server.state === 'starting' && this.ready) return this.ready;
    const model = this.getSettings().local?.lastModel;
    if (!model) throw new Error('No local model is loaded. Open the Models panel (cube icon) to download or pick one.');
    onInfo?.(`Loading ${path.basename(model)} into llama.cpp…`);
    return this.start(model);
  }
}

module.exports = { LlamaRuntime };
