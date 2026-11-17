// Install operations used by the wizard. Everything is per-user (HKCU, %LOCALAPPDATA%): no admin
// rights are needed except for the optional Microsoft VC++ runtime and machine-wide winget packages.
// Electron's patched `fs` treats .asar archives as folders, which breaks copying/removing app.asar.
// The installer must handle them as plain files, so use the unpatched module when available.
const fs = (() => { try { return require('original-fs'); } catch { return require('fs'); } })();
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const EXE = 'PanUrgos Studio.exe';
const APP = 'PanUrgos Studio';
const PROGID = 'PanUrgosStudio.Code';
const UNINST = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PanUrgosStudio';
const CAPS = 'Software\\PanUrgos Studio\\Capabilities';
// Must match FOR_EACH_EXT in build/installer.nsi (the uninstaller removes exactly these).
const EXTS = 'js mjs cjs jsx ts tsx json jsonc md markdown txt log html htm css scss less py pyw c h cpp cc hpp cs fs java kt kts go rs rb php swift lua sql sh bash ps1 psm1 bat cmd yml yaml toml ini cfg conf xml svg vue svelte dart r gradle properties env'.split(' ');

const tick = () => new Promise((r) => setImmediate(r));
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '';
    p.stdout?.on('data', (d) => (out += d)); p.stderr?.on('data', (d) => (out += d));
    p.on('error', (e) => resolve({ code: -1, out: e.message }));
    p.on('close', (code) => resolve({ code, out }));
  });
}
const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Is PanUrgos running from this folder? */
async function runningFrom(dir) {
  const r = await ps(`Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith(${psq(path.resolve(dir) + '\\')}, 'OrdinalIgnoreCase') } | ForEach-Object { 'PID:' + $_.Id }`);
  // Only count real process ids: PowerShell can print access-denied noise for system processes.
  const pids = [...r.out.matchAll(/PID:(\d+)/g)].map((m) => Number(m[1])).filter((id) => id !== process.pid);
  return pids.length > 0;
}

// ------------------------------------------------------------------ files
function listFiles(root, skip) {
  const out = []; let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(root, full);
      if (skip.some((s) => rel === s || rel.startsWith(s + path.sep))) continue;
      if (e.isDirectory()) walk(full);
      else { const size = fs.statSync(full).size; out.push({ rel, size }); bytes += size; }
    }
  };
  walk(root);
  return { files: out, bytes };
}

async function copyPayload(src, dest, onProgress) {
  if (path.resolve(src).toLowerCase() === path.resolve(dest).toLowerCase()) throw new Error('Choose a different install folder.');
  // Upgrade: replace program files; user data (%APPDATA%\PanUrgos Studio) is never touched.
  for (const d of ['resources', 'locales']) fs.rmSync(path.join(dest, d), { recursive: true, force: true });
  const { files, bytes } = listFiles(src, ['redist']);
  fs.mkdirSync(dest, { recursive: true });
  let done = 0; let last = 0;
  for (const f of files) {
    const to = path.join(dest, f.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    await fs.promises.copyFile(path.join(src, f.rel), to);
    done += f.size;
    if (Date.now() - last > 80) { onProgress(done / bytes, f.rel); last = Date.now(); await tick(); }
  }
  onProgress(1, '');
  return bytes;
}

function writeCli(dest) {
  const bin = path.join(dest, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'panurgos.cmd'), `@echo off\r\nstart "" "%~dp0..\\${EXE}" %*\r\n`);
  const helper = path.join(dest, 'resources', 'installer', 'path.ps1');
  if (fs.existsSync(helper)) fs.copyFileSync(helper, path.join(bin, 'path.ps1'));
}

async function addToPath(dest) {
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dest, 'bin', 'path.ps1'), '-Mode', 'add', '-Dir', path.join(dest, 'bin')]);
  if (r.code !== 0) throw new Error('Could not update PATH: ' + r.out.trim().slice(0, 200));
  await broadcastEnv();
}
function broadcastEnv() {
  return ps(`Add-Type -Namespace U -Name N -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h, uint m, System.UIntPtr w, string l, uint f, uint t, out System.UIntPtr r);'
$r = [UIntPtr]::Zero; [U.N]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$r) | Out-Null`);
}

async function shortcuts(dest, { startMenu, desktop }) {
  const target = path.join(dest, EXE);
  // Ask Windows for the real folders: Desktop and Start menu are often redirected (OneDrive, another drive).
  const folders = [startMenu && "'Programs'", desktop && "'Desktop'"].filter(Boolean);
  if (!folders.length) return;
  const r = await ps(`$ErrorActionPreference = 'Stop'
$w = New-Object -ComObject WScript.Shell
foreach ($f in @(${folders.join(', ')})) {
  $dir = [Environment]::GetFolderPath($f)
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $s = $w.CreateShortcut((Join-Path $dir ${psq(APP + '.lnk')}))
  $s.TargetPath = ${psq(target)}; $s.WorkingDirectory = ${psq(dest)}; $s.IconLocation = ${psq(target + ',0')}; $s.Description = 'Private AI code editor'
  $s.Save()
}`);
  if (r.code !== 0) throw new Error('Could not create shortcuts: ' + (r.out.trim().split(/\r?\n/).find((l) => l.trim()) || `exit ${r.code}`).slice(0, 160));
}

// ------------------------------------------------------------------ registry (.reg import: one call, no admin)
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
function regFile(dest, opts, version, sizeKB) {
  const exe = path.join(dest, EXE);
  const open = `"${exe}" "%1"`;
  const L = ['Windows Registry Editor Version 5.00', ''];
  const key = (k, vals) => { L.push(`[HKEY_CURRENT_USER\\${k}]`); for (const [n, v] of vals) L.push(`${n === '' ? '@' : `"${esc(n)}"`}=${typeof v === 'number' ? `dword:${v.toString(16).padStart(8, '0')}` : `"${esc(v)}"`}`); L.push(''); };
  // Application identity (always): App Paths, Applications, ProgID, Default Apps capabilities.
  key(`Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${EXE}`, [['', exe], ['Path', dest]]);
  key(`Software\\Classes\\Applications\\${EXE}`, [['FriendlyAppName', APP]]);
  key(`Software\\Classes\\Applications\\${EXE}\\DefaultIcon`, [['', `"${exe}",0`]]);
  key(`Software\\Classes\\Applications\\${EXE}\\shell\\open\\command`, [['', open]]);
  key(`Software\\Classes\\${PROGID}`, [['', 'Code file'], ['FriendlyTypeName', 'PanUrgos Studio code file']]);
  key(`Software\\Classes\\${PROGID}\\DefaultIcon`, [['', `"${exe}",0`]]);
  key(`Software\\Classes\\${PROGID}\\shell\\open\\command`, [['', open]]);
  if (opts.fileTypes) {
    key(CAPS, [['ApplicationName', APP], ['ApplicationDescription', 'Private, local-first AI code editor'], ['ApplicationIcon', `"${exe}",0`]]);
    key(`${CAPS}\\FileAssociations`, EXTS.map((e) => [`.${e}`, PROGID]));
    key('Software\\RegisteredApplications', [[APP, CAPS]]);
    key(`Software\\Classes\\Applications\\${EXE}\\SupportedTypes`, EXTS.map((e) => [`.${e}`, '']));
    // Add ourselves to each type's "Open with" list. Only a value is written; other apps' entries are untouched.
    for (const e of EXTS) key(`Software\\Classes\\.${e}\\OpenWithProgids`, [[PROGID, '']]);
  }
  if (opts.contextMenu) {
    for (const [k, arg] of [['*\\shell\\PanUrgosStudio', '%1'], ['Directory\\shell\\PanUrgosStudio', '%1'], ['Directory\\Background\\shell\\PanUrgosStudio', '%V']]) {
      key(`Software\\Classes\\${k}`, [['', 'Open with PanUrgos Studio'], ['Icon', `"${exe}",0`]]);
      key(`Software\\Classes\\${k}\\command`, [['', `"${exe}" "${arg}"`]]);
    }
  }
  const uninst = path.join(dest, 'Uninstall PanUrgos Studio.exe');
  key(UNINST, [['DisplayName', APP], ['DisplayVersion', version], ['Publisher', 'PanUrgos'], ['DisplayIcon', `"${exe}",0`],
    ['InstallLocation', dest], ['UninstallString', `"${uninst}"`], ['QuietUninstallString', `"${uninst}" /S`],
    ['URLInfoAbout', 'https://github.com/notpriyanshu/PanUrgos'], ['NoModify', 1], ['NoRepair', 1], ['EstimatedSize', Math.round(sizeKB)]]);
  return '﻿' + L.join('\r\n') + '\r\n';
}
async function writeRegistry(dest, opts, version, sizeKB) {
  const file = path.join(os.tmpdir(), `panurgos-setup-${process.pid}.reg`);
  fs.writeFileSync(file, regFile(dest, opts, version, sizeKB), 'utf16le');
  const r = await run('reg.exe', ['import', file]);
  fs.rmSync(file, { force: true });
  if (r.code !== 0) throw new Error('Registry update failed: ' + r.out.trim().slice(0, 200));
  await ps(`Add-Type -Namespace U -Name S -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, System.IntPtr a, System.IntPtr b);'; [U.S]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)`);
}

/** Microsoft VC++ runtime: elevated, silent. 0 = ok, 3010 = ok (restart later), 1638 = newer already present. */
async function installVcRedist(exe) {
  const r = await ps(`$p = Start-Process -FilePath ${psq(exe)} -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`);
  if (![0, 3010, 1638].includes(r.code)) throw new Error(r.code === 1 && /canceled|cancelled/i.test(r.out) ? 'Administrator permission was declined.' : `vc_redist exited with ${r.code}`);
  return r.code;
}

/** Ask the app to fetch the CUDA build on first launch (consent given here, in the wizard). */
function queueCuda() {
  const dir = path.join(process.env.APPDATA, APP);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'first-run.json'), JSON.stringify({ installCuda: true, at: Date.now() }));
}

function dirSizeKB(dir) { try { return listFiles(dir, []).bytes / 1024; } catch { return 0; } }

/**
 * Remove an install from before the rename (Umbra Studio): its uninstaller drops its PATH entry,
 * shortcuts and registry values. `_?=` makes the NSIS uninstaller run in place so we can wait for it;
 * its folder is then deleted here. User data was already moved to the new profile and is never touched.
 */
async function uninstallLegacy(legacy) {
  if (await runningFrom(legacy.dir)) throw new Error(`${legacy.name} is still running. Close it and try again.`);
  if (legacy.uninstaller) {
    const r = await run(legacy.uninstaller, ['/S', `_?=${legacy.dir}`]);
    if (r.code !== 0) throw new Error(`The ${legacy.name} uninstaller exited with ${r.code}`);
  }
  fs.rmSync(legacy.dir, { recursive: true, force: true });
  // Don't rely on the old uninstaller for PATH: remove its bin folder ourselves (no-op if already gone).
  await removeFromPath(path.join(legacy.dir, 'bin'));
}

/** Remove a folder from the user PATH without expanding other %VARIABLES% entries. */
async function removeFromPath(dir) {
  await ps(`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$cur = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$t = ${psq(path.resolve(dir))}.TrimEnd('\\').ToLowerInvariant()
$parts = @($cur -split ';' | Where-Object { $_.Trim() -ne '' -and $_.Trim().TrimEnd('\\').ToLowerInvariant() -ne $t })
$k.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close()`);
  await broadcastEnv();
}

module.exports = { uninstallLegacy, runningFrom, copyPayload, writeCli, addToPath, shortcuts, writeRegistry, installVcRedist, queueCuda, dirSizeKB, listFiles, EXE, EXTS };
