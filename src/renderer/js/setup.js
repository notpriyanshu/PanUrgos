// First-run setup: Claude-Code-style readout + optional components.
(() => {
  const { $, el, esc, ansiToHtml } = U;
  const term = $('#term');
  const selected = new Set();
  let info = null; let tools = null; let busy = false;

  const write = (s) => { term.insertAdjacentHTML('beforeend', ansiToHtml(s)); term.scrollTop = term.scrollHeight; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const G = (s) => `\x1b[32m${s}\x1b[0m`; const D = (s) => `\x1b[90m${s}\x1b[0m`; const C = (s) => `\x1b[36m${s}\x1b[0m`; const B = (s) => `\x1b[1m${s}\x1b[0m`;
  const backendName = (b) => ({ vulkan: 'Vulkan', cpu: 'CPU', 'cuda-13.5': 'CUDA 13.5', 'cuda-12.4': 'CUDA 12.4', metal: 'Metal' }[b] || b);

  async function intro() {
    write(D('Setting up PanUrgos Studio…\n'));
    info = await panurgos.setup.info();
    document.body.classList.add('platform-' + info.platform);
    await sleep(250);
    write(`${G('✔')} ${B('PanUrgos Studio ' + info.version)} installed\n`);
    write(`  ${D('Location:')} ${info.installDir}\n`);
    if (info.platform === 'win32') write(`  ${D('Command: ')} ${C('panurgos')} ${D('(open a folder from any terminal: panurgos .)')}\n`);
    await sleep(200);
    if (info.runtime) write(`${G('✔')} llama.cpp ${info.runtime.tag} (${backendName(info.runtime.backend)}) ready ${D('— runs models offline')}\n`);
    const gpu = info.hardware?.gpus?.[0];
    if (info.platform === 'darwin') write(`${C('◆')} ${info.arch === 'arm64' ? 'Apple Silicon · Metal GPU acceleration with unified memory' : 'Intel Mac · CPU inference'}\n`);
    else if (gpu) write(`${C('◆')} GPU: ${gpu.name} · ${(gpu.vramMB / 1024).toFixed(0)} GB${info.hardware.cuda ? ` · CUDA ${info.hardware.cuda}` : ''}\n`);
    else write(`${C('◆')} No NVIDIA GPU found ${D('— Vulkan/CPU will be used')}\n`);
  }

  function rowEl({ id, title, sub, on, done, state }) {
    const r = el('div', { class: `row ${on ? 'on' : ''} ${done ? 'done' : ''}`, 'data-id': id });
    r.innerHTML = `<i class="check"></i><div><b>${esc(title)}</b><span>${esc(sub)}</span></div><em class="state ${done ? 'ok' : ''}">${esc(state || '')}</em>`;
    if (!done) r.onclick = () => { if (busy) return; selected.has(id) ? selected.delete(id) : selected.add(id); r.classList.toggle('on', selected.has(id)); updateGo(); };
    return r;
  }

  function renderAccel() {
    const box = $('#accel'); box.innerHTML = '';
    if (info.platform === 'darwin') {
      box.append(rowEl({ id: 'accel-ok', done: true, title: info.arch === 'arm64' ? 'Metal acceleration' : 'CPU inference', sub: 'Bundled with PanUrgos — nothing to download.', state: 'ready' }));
      return;
    }
    const nvidia = info.hardware?.gpus?.some((g) => g.vendor === 'nvidia');
    if (nvidia && info.hardware.cuda && info.runtime?.backend !== info.backend && info.backend.startsWith('cuda')) {
      selected.add('cuda');
      box.append(rowEl({ id: 'cuda', on: true, title: `NVIDIA CUDA build (${backendName(info.backend)})`, sub: 'Fastest on your GPU. ~610 MB from github.com/ggml-org, verified by SHA-256. Downloads in the background.' }));
    } else {
      box.append(rowEl({ id: 'accel-ok', done: true, title: `${backendName(info.runtime?.backend || 'vulkan')} acceleration`, sub: info.runtime?.bundled ? 'Bundled with the installer — nothing to download.' : 'Already installed — nothing to download.', state: 'ready' }));
    }
  }

  async function loadTools() {
    tools = await panurgos.tools.detect();
    const box = $('#tools'); box.innerHTML = '';
    $('#mgr-label').textContent = tools.manager ? 'optional · via ' + tools.manager.label : 'optional';
    if (!tools.manager) { box.innerHTML = `<div class="muted">${tools.platform === 'darwin' ? 'Install Homebrew (brew.sh) to add runtimes from PanUrgos. You can do this later from the Packages panel.' : tools.platform === 'linux' ? 'Install runtimes with your distribution’s package manager — the Packages panel shows the exact commands.' : 'winget isn’t available on this PC, so runtimes can’t be installed automatically. You can install them later from the Packages panel.'}</div>`; return; }
    for (const t of tools.tools) {
      if (t.required && !t.installed) selected.add(t.id);
      box.append(rowEl({ id: t.id, title: t.name, sub: t.installed ? `Already installed${t.version ? ' · ' + t.version : ''}` : t.desc, on: selected.has(t.id), done: t.installed, state: t.installed ? 'installed' : '' }));
    }
    updateGo();
  }

  function updateGo() {
    const n = [...selected].length;
    $('#go').textContent = n ? `Install ${n} & launch` : 'Launch PanUrgos Studio';
  }
  const setState = (id, cls, text) => { const s = document.querySelector(`.row[data-id="${id}"] .state`); if (s) { s.className = `state ${cls}`; s.textContent = text; } };

  async function go() {
    if (busy) return;
    busy = true;
    $('#go').disabled = true; $('#skip').disabled = true;
    const toolIds = [...selected].filter((id) => id !== 'cuda');
    for (const id of toolIds) {
      const t = tools.tools.find((x) => x.id === id);
      setState(id, 'run', 'installing…');
      write(`\n${C('→')} Installing ${B(t.name)} ${D('via ' + tools.manager.label)}\n`);
      try {
        const r = await panurgos.tools.install(id);
        setState(id, r.ok ? 'ok' : 'bad', r.ok ? 'installed' : `failed (${r.code})`);
      } catch (e) { setState(id, 'bad', 'failed'); write(`\x1b[31m${String(e.message || e)}\x1b[0m\n`); }
    }
    if (selected.has('cuda')) { setState('cuda', 'run', 'queued'); write(`\n${C('→')} CUDA build will download in the background ${D('— progress shows in the Models panel')}\n`); }
    write(`\n${G('✔')} ${B('All set.')} Opening PanUrgos Studio…\n`);
    await sleep(900);
    panurgos.setup.finish({ installCuda: selected.has('cuda') });
  }

  panurgos.setup.onLog((d) => write(d));
  $('#go').onclick = go;
  $('#skip').onclick = () => panurgos.setup.finish({});
  $('#close').onclick = () => panurgos.setup.finish({});
  $('#defaults').onclick = () => panurgos.tools.openDefaultApps();

  if (!/win/i.test(navigator.platform)) { $('#integ-h').style.display = 'none'; $('#integ-row').style.display = 'none'; }
  (async () => {
    await intro();
    renderAccel();
    await loadTools();
  })();
})();
