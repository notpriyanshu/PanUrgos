// Builds dist/PanUrgos-Studio-Setup-<version>.exe
//
//   1. Fetch the llama.cpp Vulkan build from github.com/ggml-org/llama.cpp (SHA-256 checked) → build/llama.cpp
//   2. Fetch Microsoft's VC++ 2015–2022 x64 redistributable (Authenticode-checked)   → build/redist
//   3. Package the Electron app with electron-builder (--dir)                          → dist/win-unpacked
//   4. Fetch NSIS (electron-builder's pinned copy) and compile build/installer.nsi
//
// No GGUF model files are bundled. Usage: npm run dist
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = __dirname;
const CACHE = path.join(BUILD, '.cache');
const pkg = require(path.join(ROOT, 'package.json'));
const LLAMA_TAG = process.env.LLAMA_TAG || ''; // empty = newest build with a Windows Vulkan package
const NSIS_URL = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z';
const VC_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

const log = (...a) => console.log('\x1b[36m›\x1b[0m', ...a);
fs.mkdirSync(CACHE, { recursive: true });

async function download(url, dest, sha256) {
  if (fs.existsSync(dest) && (!sha256 || hashFile(dest) === sha256)) return dest;
  log('download', url);
  const res = await fetch(url, { headers: { 'User-Agent': 'PanUrgosStudio-build' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  if (sha256 && hashFile(dest) !== sha256) { fs.rmSync(dest); throw new Error(`SHA-256 mismatch for ${path.basename(dest)}`); }
  return dest;
}
const hashFile = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

/**
 * The llama.cpp build bundled for each target. Vulkan covers NVIDIA/AMD/Intel GPUs on Windows and
 * Linux and falls back to the CPU; macOS gets Metal on Apple Silicon and the CPU build on Intel.
 * NVIDIA users can add the CUDA build from inside PanUrgos.
 */
function llamaTarget(platform, arch) {
  if (platform === 'win32') return { re: /-bin-win-vulkan-x64\.zip$/, backend: 'vulkan', exe: 'llama-server.exe' };
  if (platform === 'darwin') return arch === 'arm64'
    ? { re: /-bin-macos-arm64\.tar\.gz$/, backend: 'metal', exe: 'llama-server' }
    : { re: /-bin-macos-x64\.tar\.gz$/, backend: 'cpu', exe: 'llama-server' };
  return { re: /-bin-ubuntu-vulkan-x64\.tar\.gz$/, backend: 'vulkan', exe: 'llama-server' };
}

async function prepareLlama(platform, arch) {
  const t = llamaTarget(platform, arch);
  const out = path.join(BUILD, 'llama.cpp');
  // Authenticated when a token is available (CI): unauthenticated calls are limited to 60/hour.
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const cachedManifest = path.join(out, 'bundled.json');
  const cached = fs.existsSync(cachedManifest) ? JSON.parse(fs.readFileSync(cachedManifest, 'utf8'))[0] : null;
  let releases;
  try {
    const res = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20', { headers: { 'User-Agent': 'PanUrgosStudio-build', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}${res.status === 403 ? ' (rate limit — set GH_TOKEN, or wait an hour)' : ''}`);
    releases = await res.json();
  } catch (e) {
    // Offline or rate-limited: an already prepared build for this platform is good enough.
    if (cached?.backend === t.backend && fs.existsSync(path.join(out, cached.folder, t.exe))) { log(`llama.cpp: ${e.message}; using prepared ${cached.tag}`); return cached.tag; }
    throw e;
  }
  const rel = releases.filter((r) => /^b\d+$/.test(r.tag_name)).sort((a, b) => Number(b.tag_name.slice(1)) - Number(a.tag_name.slice(1)))
    .find((r) => (!LLAMA_TAG || r.tag_name === LLAMA_TAG) && r.assets.some((a) => t.re.test(a.name)));
  if (!rel) throw new Error(`No llama.cpp release with a ${platform}/${arch} ${t.backend} build found.`);
  const asset = rel.assets.find((a) => t.re.test(a.name));
  const folder = `${rel.tag_name}-${t.backend}`;
  const manifest = path.join(out, 'bundled.json');
  const prev = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8'))[0] : null;
  if (prev?.tag === rel.tag_name && prev.folder === folder) { log('llama.cpp', rel.tag_name, t.backend, 'already prepared'); return rel.tag_name; }
  const archive = await download(asset.browser_download_url, path.join(CACHE, asset.name), asset.digest?.replace(/^sha256:/, ''));
  fs.rmSync(out, { recursive: true, force: true });
  const tmp = path.join(out, '.extract');
  fs.mkdirSync(tmp, { recursive: true });
  execFileSync(platform === 'win32' ? tar : 'tar', ['-xf', archive, '-C', tmp]);
  // Archives nest differently per OS (bin/, build/bin/, …): use the folder that holds llama-server.
  const find = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isFile() && e.name === t.exe) return d; if (e.isDirectory()) { const r = find(p); if (r) return r; } } return null; };
  const binDir = find(tmp);
  if (!binDir) throw new Error(`${t.exe} missing from ${asset.name}`);
  fs.renameSync(binDir, path.join(out, folder));
  fs.rmSync(tmp, { recursive: true, force: true });
  if (platform !== 'win32') for (const f of fs.readdirSync(path.join(out, folder))) if (!/\.(dylib|so[.\d]*|metal|txt|md)$/.test(f)) fs.chmodSync(path.join(out, folder, f), 0o755);
  fs.writeFileSync(manifest, JSON.stringify([{ tag: rel.tag_name, backend: t.backend, folder, version: rel.tag_name, builtAt: Date.now(), source: asset.browser_download_url, sha256: asset.digest }], null, 2));
  log('llama.cpp', rel.tag_name, t.backend, 'build ready');
  return rel.tag_name;
}

async function prepareVcRedist() {
  const dir = path.join(BUILD, 'redist');
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'vc_redist.x64.exe');
  if (!fs.existsSync(exe)) await download(VC_URL, exe);
  // Must be signed by Microsoft — refuse to bundle anything else.
  // Run Windows PowerShell with a clean module path: when the build is started from PowerShell 7,
  // the inherited PSModulePath stops Windows PowerShell from loading Get-AuthenticodeSignature.
  const env = { ...process.env }; delete env.PSModulePath;
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', `$s = Get-AuthenticodeSignature '${exe}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`], { encoding: 'utf8', env });
  const [status, subject] = (ps.stdout || '').trim().split('|');
  if (!status) throw new Error(`Could not verify the vc_redist signature: ${(ps.stderr || '').trim().split('\n')[0]}`);
  if (status !== 'Valid' || !/O=Microsoft Corporation/.test(subject)) { fs.rmSync(exe); throw new Error(`vc_redist signature check failed: ${status} ${subject}`); }
  log('VC++ redistributable signed by Microsoft ✔');
}

async function prepareNsis() {
  const dir = path.join(CACHE, 'nsis');
  const makensis = path.join(dir, 'Bin', 'makensis.exe');
  if (fs.existsSync(makensis)) return makensis;
  const archive = await download(NSIS_URL, path.join(CACHE, 'nsis.7z'));
  const sevenZip = require('7zip-bin').path7za;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // The archive has no top-level folder: unpack straight into cache/nsis.
  execFileSync(sevenZip, ['x', archive, `-o${dir}`, '-y'], { stdio: 'ignore' });
  if (!fs.existsSync(makensis)) throw new Error('makensis.exe not found after extracting NSIS');
  return makensis;
}

function electronBuilder(args) {
  log('electron-builder', args.join(' '));
  const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  // Never publish from here: installers are distributed through panurgos.com's signup gate, not public releases.
  // CI passes signing secrets as empty strings when they aren't configured; electron-builder would read an
  // empty CSC_LINK as a path ("... not a file"). Drop empty signing variables so it falls back cleanly.
  const env = { ...process.env };
  for (const k of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) if (!env[k]) delete env[k];
  if (!env.CSC_LINK) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const r = spawnSync(process.execPath, [cli, ...args, '--publish', 'never'], { cwd: ROOT, stdio: 'inherit', env });
  if (r.status !== 0) throw new Error('electron-builder failed');
}

// Usage: npm run dist            → installer for this OS/arch
//        npm run dist -- --arch=x64   (macOS: build the Intel variant on an Apple Silicon Mac)
(async () => {
  const platform = process.platform;
  const arch = (process.argv.find((a) => a.startsWith('--arch=')) || '').slice(7) || process.arch;
  for (const f of ['icon.ico', 'icon.png']) if (!fs.existsSync(path.join(BUILD, f))) throw new Error('Run `npm run assets` first to render the icon and installer art.');
  const tag = await prepareLlama(platform, arch);
  const list = (dir, re) => fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => `${path.join(dir, f)} (${(fs.statSync(path.join(dir, f)).size / 1048576).toFixed(0)} MB)`);

  if (platform === 'win32') {
    // Windows: package the app, then wrap it in the Setup.exe bootstrapper + wizard.
    await prepareVcRedist();
    electronBuilder(['--win', '--dir', '--x64']);
    const makensis = await prepareNsis();
    log('makensis');
    const r = spawnSync(makensis, ['-V2', `-DVERSION=${pkg.version}`, `-DLLAMA_TAG=${tag}`, path.join(BUILD, 'installer.nsi')], { cwd: BUILD, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('makensis failed');
    list(path.join(ROOT, 'dist'), /^PanUrgos-Studio-Setup-.*\.exe$/).forEach((f) => log(`\x1b[32m✔\x1b[0m ${f}`));
  } else if (platform === 'darwin') {
    // macOS: drag-to-Applications DMG (+ zip for auto-update/side-loading). Signing and notarization run
    // automatically when CSC_LINK / APPLE_ID credentials are present in the environment.
    // Without a Developer ID certificate, sign ad-hoc: a fully unsigned app is reported as "damaged" on
    // Apple Silicon. Users then approve it once (System Settings > Privacy & Security > Open Anyway).
    const adHoc = process.env.CSC_LINK ? [] : ['-c.mac.identity=-'];
    if (adHoc.length) log('No signing certificate: ad-hoc signing (Gatekeeper will ask the user to approve once).');
    electronBuilder(['--mac', 'dmg', 'zip', `--${arch}`, ...adHoc]);
    list(path.join(ROOT, 'dist'), /\.(dmg|zip)$/).forEach((f) => log(`\x1b[32m✔\x1b[0m ${f}`));
  } else {
    electronBuilder(['--linux', 'AppImage', 'deb', `--${arch === 'arm64' ? 'arm64' : 'x64'}`]);
    list(path.join(ROOT, 'dist'), /\.(AppImage|deb)$/).forEach((f) => log(`\x1b[32m✔\x1b[0m ${f}`));
  }
})().catch((e) => { console.error('\x1b[31m✗\x1b[0m', e.message); process.exit(1); });
