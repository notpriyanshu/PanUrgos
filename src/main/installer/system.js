// System check for the installer: OS, CPU, memory, GPUs (with real VRAM), disk, runtimes.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PS_SCAN = `
$ErrorActionPreference = 'SilentlyContinue'
$os  = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$vram = @{}
Get-ChildItem 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  $m = $p.'HardwareInformation.qwMemorySize'
  if ($m -is [byte[]]) { $m = [BitConverter]::ToInt64($m, 0) }
  if ($p.DriverDesc -and $m) { $vram[$p.DriverDesc] = [int64]$m }
}
Add-Type -Name K -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint f);'
$gpus = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Basic Display|Remote|Virtual' } | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; driver = $_.DriverVersion; vram = $(if ($vram[$_.Name]) { $vram[$_.Name] } else { [int64]$_.AdapterRAM }) }
})
[pscustomobject]@{
  os = $os.Caption; version = $os.Version; build = $os.BuildNumber; arch = $os.OSArchitecture
  cpu = $cpu.Name.Trim(); cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors
  avx2 = [W.K]::IsProcessorFeaturePresent(40); avx512 = [W.K]::IsProcessorFeaturePresent(41)
  gpus = $gpus
} | ConvertTo-Json -Depth 4 -Compress
`;

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? '' : String(stdout))));
}

async function scanHardware() {
  const enc = Buffer.from(PS_SCAN, 'utf16le').toString('base64');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], 30000);
  let hw = {};
  try { hw = JSON.parse(out.trim()); } catch {}
  hw.gpus = Array.isArray(hw.gpus) ? hw.gpus : hw.gpus ? [hw.gpus] : [];
  hw.ramBytes = os.totalmem();
  hw.cpu ||= os.cpus()[0]?.model; hw.threads ||= os.cpus().length;
  // NVIDIA: authoritative VRAM + supported CUDA version.
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (smi.trim()) {
    for (const line of smi.trim().split(/\r?\n/)) {
      const [name, mem, drv] = line.split(',').map((s) => s.trim());
      const g = hw.gpus.find((x) => x.name === name) || (hw.gpus.push({ name }), hw.gpus.at(-1));
      g.vendor = 'nvidia'; g.vram = Number(mem) * 1048576; g.nvDriver = drv;
    }
    const head = await run('nvidia-smi', []);
    hw.cuda = (/CUDA(?: UMD| Driver)? Version:\s*([\d.]+)/i.exec(head) || [])[1] || null;
  }
  for (const g of hw.gpus) g.vendor ||= /nvidia/i.test(g.name) ? 'nvidia' : /amd|radeon/i.test(g.name) ? 'amd' : /intel/i.test(g.name) ? 'intel' : 'other';
  hw.vulkan = fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'vulkan-1.dll'));
  return hw;
}

function vcRedist() {
  return run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64', '/v', 'Version'])
    .then((out) => (/Version\s+REG_SZ\s+v?([\d.]+)/.exec(out) || [])[1] || null);
}

async function existingInstall() {
  const out = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PanUrgosStudio']);
  if (!out) return null;
  const v = (k) => (new RegExp(`${k}\\s+REG_SZ\\s+(.*)`).exec(out) || [])[1]?.trim();
  const dir = v('InstallLocation');
  return dir && fs.existsSync(path.join(dir, 'PanUrgos Studio.exe')) ? { dir, version: v('DisplayVersion') } : null;
}

/** An install from before the product was renamed (Umbra Studio). Setup replaces it. */
async function legacyInstall() {
  const out = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\UmbraStudio']);
  if (!out) return null;
  const v = (k) => (new RegExp(`${k}\\s+REG_SZ\\s+(.*)`).exec(out) || [])[1]?.trim();
  const dir = v('InstallLocation');
  const uninstaller = dir && path.join(dir, 'Uninstall Umbra Studio.exe');
  return dir ? { dir, version: v('DisplayVersion'), name: 'Umbra Studio', uninstaller: uninstaller && fs.existsSync(uninstaller) ? uninstaller : null } : null;
}

function diskFree(dir) {
  // Walk up to the nearest existing parent (the target folder may not exist yet).
  let d = path.resolve(dir);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch { return null; }
}

/** Pick the llama.cpp backend PanUrgos will recommend for this machine. */
function recommendBackend(hw) {
  const cmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); return (x[0] - y[0]) || ((x[1] || 0) - (y[1] || 0)); };
  if (hw.gpus.some((g) => g.vendor === 'nvidia') && hw.cuda) {
    if (cmp(hw.cuda, '13.5') >= 0) return 'cuda-13.5';
    if (cmp(hw.cuda, '12.4') >= 0) return 'cuda-12.4';
  }
  return hw.vulkan ? 'vulkan' : 'cpu';
}

module.exports = { scanHardware, vcRedist, existingInstall, legacyInstall, diskFree, recommendBackend };
