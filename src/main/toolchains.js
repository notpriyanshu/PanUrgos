// PanUrgos Studio — developer toolchains (Git, Node, Python, .NET, Java, Rust, VC++ runtime).
//
// Detection runs the tool with a PATH rebuilt from the registry, so something installed a minute ago
// (by winget, the setup screen, or the user in another terminal) is seen without restarting PanUrgos.
// Installation goes through winget from each publisher's official installer; output streams to the
// caller so it can be shown live in PanUrgos's terminal.
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const TOOLS = [
  { id: 'git', name: 'Git', desc: 'Version control. Needed for cloning repos and most package managers.', winget: 'Git.Git', brew: ['git'], apt: 'git', cmd: ['git', '--version'], parse: /git version ([\d.]+)/ },
  { id: 'node', name: 'Node.js LTS', desc: 'JavaScript/TypeScript runtime with npm.', winget: 'OpenJS.NodeJS.LTS', brew: ['node'], apt: 'nodejs npm', cmd: ['node', '--version'], parse: /v([\d.]+)/ },
  { id: 'python', name: 'Python 3.13', desc: 'Python runtime with pip and venv.', winget: 'Python.Python.3.13', brew: ['python@3.13'], apt: 'python3 python3-venv python3-pip', cmd: [process.platform === 'win32' ? 'python' : 'python3', '--version'], parse: /Python ([\d.]+)/ },
  { id: 'dotnet', name: '.NET 8 SDK', desc: 'Build and run C#/F# apps (includes the .NET runtime).', winget: 'Microsoft.DotNet.SDK.8', brew: ['--cask', 'dotnet-sdk'], apt: 'dotnet-sdk-8.0', cmd: ['dotnet', '--version'], parse: /^([\d.]+)/m },
  { id: 'java', name: 'Java 21 JDK (Eclipse Temurin)', desc: 'OpenJDK build for Java, Kotlin and Gradle/Maven projects.', winget: 'EclipseAdoptium.Temurin.21.JDK', brew: ['--cask', 'temurin@21'], apt: 'openjdk-21-jdk', cmd: ['java', '-version'], parse: /version "([\d._]+)"/ },
  { id: 'rust', name: 'Rust (rustup)', desc: 'Rust toolchain installer with cargo.', winget: 'Rustlang.Rustup', brew: ['rustup'], apt: 'rustup', cmd: ['cargo', '--version'], parse: /cargo ([\d.]+)/ },
  { id: 'vcredist', name: 'Visual C++ Redistributable', desc: 'Microsoft runtime required by llama.cpp and many native tools.', winget: 'Microsoft.VCRedist.2015+.x64', registry: true, required: true, windowsOnly: true }
];

/** Rebuild PATH from the registry (machine + user), keeping anything PanUrgos itself prepended. */
function readRegistryPath() {
  if (process.platform !== 'win32') return loginShellPath();
  const q = (key) => new Promise((resolve) => execFile('reg', ['query', key, '/v', 'Path'], { windowsHide: true }, (err, out) => {
    const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(out || '');
    resolve(err || !m ? '' : m[1].trim());
  }));
  return Promise.all([q('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), q('HKCU\\Environment')]).then(([sys, user]) => {
    const expand = (s) => s.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
    const parts = [...expand(sys).split(';'), ...expand(user).split(';'), ...(process.env.PATH || '').split(';')].filter(Boolean);
    const seen = new Set();
    return parts.filter((p) => { const k = p.toLowerCase().replace(/\\+$/, ''); if (seen.has(k)) return false; seen.add(k); return true; }).join(';');
  });
}

let shellPathCache = null;
/** macOS/Linux: the PATH a login shell would have, plus the standard Homebrew prefixes. */
function loginShellPath() {
  const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(require('os').homedir(), '.cargo', 'bin')];
  const merge = (p) => [...new Set([...(p || '').split(':'), ...extra, ...(process.env.PATH || '').split(':')].filter(Boolean))].join(':');
  if (shellPathCache) return Promise.resolve(merge(shellPathCache));
  return new Promise((resolve) => execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { timeout: 5000 }, (err, out) => {
    shellPathCache = (/__P__(.*?)__P__/s.exec(out || '') || [])[1] || '';
    resolve(merge(shellPathCache));
  }));
}

/** Environment for child processes with an up-to-date PATH. Also updates this process for later spawns. */
async function freshEnv() {
  const p = await readRegistryPath();
  process.env.PATH = p;
  return { ...process.env, PATH: p };
}

function runCapture(cmd, args, env, timeout = 15000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, windowsHide: true, shell: false });
    let out = '';
    const t = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: -1, out }); }, timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => { clearTimeout(t); resolve({ code: -1, out: '' }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

function vcRedistVersion() {
  return new Promise((resolve) => execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64', '/v', 'Version'], { windowsHide: true },
    (err, out) => resolve(err ? null : ((/Version\s+REG_SZ\s+v?([\d.]+)/.exec(out) || [])[1] || null))));
}

class Toolchains extends EventEmitter {
  constructor() { super(); this.busy = null; }

  async wingetAvailable(env) {
    const r = await runCapture('winget', ['--version'], env || await freshEnv(), 10000);
    return r.code === 0 ? r.out.trim() : null;
  }

  /** The package manager PanUrgos can drive on this OS: winget (Windows), Homebrew (macOS), none (Linux: shows the apt command). */
  async manager(env) {
    if (process.platform === 'win32') { const v = await this.wingetAvailable(env); return v ? { id: 'winget', label: 'winget', version: v } : null; }
    if (process.platform === 'darwin') {
      const r = await runCapture('brew', ['--version'], env, 10000);
      return r.code === 0 ? { id: 'brew', label: 'Homebrew', version: (r.out.split('\n')[0] || '').replace('Homebrew ', '') } : null;
    }
    return null;
  }

  async detect() {
    const env = await freshEnv();
    const list = TOOLS.filter((t) => !t.windowsOnly || process.platform === 'win32');
    const results = await Promise.all(list.map(async (t) => {
      if (t.registry) { const v = await vcRedistVersion(); return { id: t.id, installed: !!v, version: v }; }
      const r = await runCapture(t.cmd[0], t.cmd.slice(1), env);
      // The Microsoft Store "python" alias exits non-zero and prints nothing useful; treat as missing.
      const m = r.code === 0 || t.id === 'java' ? t.parse.exec(r.out) : null;
      return { id: t.id, installed: !!m, version: m ? m[1] : null };
    }));
    const mgr = await this.manager(env);
    return {
      winget: mgr?.id === 'winget' ? mgr.version : null, // kept for older callers
      manager: mgr, platform: process.platform,
      tools: list.map((t) => ({ ...t, parse: undefined, cmd: undefined, hint: process.platform === 'linux' ? `sudo apt install ${t.apt}` : null, ...results.find((r) => r.id === t.id) }))
    };
  }

  /** Install one tool with winget (Windows) or Homebrew (macOS); streams output through 'data' events. */
  install(id) {
    const t = TOOLS.find((x) => x.id === id);
    if (!t) return Promise.reject(new Error(`Unknown tool ${id}`));
    if (this.busy) return Promise.reject(new Error(`Already installing ${this.busy}. Wait for it to finish.`));
    if (process.platform === 'darwin') return this._brewInstall(t);
    if (process.platform !== 'win32') return Promise.reject(new Error(`Install ${t.name} with your package manager: sudo apt install ${t.apt}`));
    this.busy = t.name;
    const args = ['install', '--id', t.winget, '--exact', '--source', 'winget', '--silent',
      '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];
    this.emit('data', `\x1b[36m❯\x1b[0m \x1b[1mwinget ${args.join(' ')}\x1b[0m\n`);
    return freshEnv().then((env) => new Promise((resolve) => {
      const child = spawn('winget', args, { env, windowsHide: true });
      // winget draws spinners/progress bars with \r; keep only settled lines.
      const pump = (d) => {
        const text = d.toString().replace(/\r(?!\n)/g, '\n').split('\n')
          .filter((l) => l.trim() && !/^[\s\-\\|/█▒]+$/.test(l) && !/^\s*[\d.]+ [KMG]B \/ /.test(l)).join('\n');
        if (text) this.emit('data', text + '\n');
      };
      child.stdout.on('data', pump);
      child.stderr.on('data', pump);
      child.on('error', (e) => { this.busy = null; resolve({ ok: false, message: `winget could not start: ${e.message}` }); });
      child.on('close', async (code) => {
        this.busy = null;
        await freshEnv();
        // 0 = installed; 0x8A15002B (-1978335189) = already installed / no upgrade available.
        const ok = code === 0 || code === -1978335189 || code === 2316632107;
        this.emit('data', ok ? `\x1b[32m✔ ${t.name} is ready.\x1b[0m\n` : `\x1b[31m✗ ${t.name} failed (exit ${code}).\x1b[0m\n`);
        resolve({ ok, code });
      });
    }));
  }

  _brewInstall(t) {
    this.busy = t.name;
    const args = ['install', ...t.brew];
    this.emit('data', `\x1b[36m❯\x1b[0m \x1b[1mbrew ${args.join(' ')}\x1b[0m\n`);
    return freshEnv().then((env) => new Promise((resolve) => {
      const child = spawn('brew', args, { env: { ...env, HOMEBREW_NO_ENV_HINTS: '1', NONINTERACTIVE: '1' } });
      const pump = (d) => this.emit('data', d.toString());
      child.stdout.on('data', pump); child.stderr.on('data', pump);
      child.on('error', (e) => { this.busy = null; resolve({ ok: false, message: `brew could not start: ${e.message}` }); });
      child.on('close', async (code) => {
        this.busy = null; shellPathCache = null; await freshEnv();
        this.emit('data', code === 0 ? `\x1b[32m✔ ${t.name} is ready.\x1b[0m\n` : `\x1b[31m✗ ${t.name} failed (exit ${code}).\x1b[0m\n`);
        resolve({ ok: code === 0, code });
      });
    }));
  }
}

/** Dependency manifests PanUrgos knows how to install for, found in the workspace root. */
function detectProject(root) {
  if (!root || !fs.existsSync(root)) return { items: [], venv: false, hasPython: false };
  const has = (f) => fs.existsSync(path.join(root, f));
  const venvPy = ['.venv', 'venv'].map((d) => path.join(root, d, process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')).find((p) => fs.existsSync(p));
  // The integrated terminal runs PowerShell on Windows (call operator needed for a quoted path), bash elsewhere.
  const py = venvPy ? (process.platform === 'win32' ? `& "${venvPy}"` : `"${venvPy}"`) : (process.platform === 'win32' ? 'python' : 'python3');
  const found = [];
  if (has('package.json')) {
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : 'npm';
    found.push({ id: 'node', label: `package.json (${pm})`, install: `${pm} install`, add: pm === 'npm' ? 'npm install {pkg}' : `${pm} add {pkg}`, manager: pm });
  }
  if (has('requirements.txt')) found.push({ id: 'pip-req', label: `requirements.txt${venvPy ? ' (.venv)' : ''}`, install: `${py} -m pip install -r requirements.txt`, add: `${py} -m pip install {pkg}`, manager: 'pip' });
  if (has('pyproject.toml') && !has('requirements.txt')) found.push({ id: 'pip-proj', label: `pyproject.toml${venvPy ? ' (.venv)' : ''}`, install: `${py} -m pip install -e .`, add: `${py} -m pip install {pkg}`, manager: 'pip' });
  const csproj = fs.readdirSync(root).find((f) => /\.(csproj|fsproj|sln)$/i.test(f));
  if (csproj) found.push({ id: 'dotnet', label: csproj, install: 'dotnet restore', add: 'dotnet add package {pkg}', manager: 'NuGet' });
  if (has('pom.xml')) found.push({ id: 'maven', label: 'pom.xml (Maven)', install: 'mvn -q dependency:resolve', add: null, manager: 'Maven' });
  if (has('build.gradle') || has('build.gradle.kts')) found.push({ id: 'gradle', label: 'Gradle build', install: has('gradlew.bat') ? '.\\gradlew.bat dependencies' : 'gradle dependencies', add: null, manager: 'Gradle' });
  if (has('Cargo.toml')) found.push({ id: 'cargo', label: 'Cargo.toml', install: 'cargo fetch', add: 'cargo add {pkg}', manager: 'cargo' });
  if (has('go.mod')) found.push({ id: 'go', label: 'go.mod', install: 'go mod download', add: 'go get {pkg}', manager: 'go' });
  return { items: found, venv: !!venvPy, hasPython: has('requirements.txt') || has('pyproject.toml') || fs.readdirSync(root).some((f) => f.endsWith('.py')) };
}

module.exports = { Toolchains, TOOLS, freshEnv, detectProject };
