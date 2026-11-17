// PanUrgos Studio Setup — wizard controller.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const GB = 1024 ** 3;
  const fmt = (b) => (b >= GB ? (b / GB).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1048576)) + ' MB');
  const cmpVer = (a, b) => { const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number); return (x[0] - y[0]) || ((x[1] || 0) - (y[1] || 0)); };

  const PAGES = ['welcome', 'system', 'location', 'components', 'ready', 'install', 'finish'];
  const S = { page: 0, info: null, scan: null, dir: '', dirInfo: null, sel: {}, plan: null, result: null };

  // Approximate winget download sizes, for the summary only.
  const TOOL_SIZE = { git: 330, node: 110, python: 120, dotnet: 800, java: 330, rust: 20 };
  const MACHINE_WIDE = new Set(['git', 'dotnet', 'java', 'node', 'python']);

  // ---------------------------------------------------------------- navigation
  function go(i) {
    const prev = $(`.page[data-page="${PAGES[S.page]}"]`);
    const next = $(`.page[data-page="${PAGES[i]}"]`);
    if (prev !== next) { prev.classList.remove('show'); prev.classList.add('leave'); setTimeout(() => prev.classList.remove('leave'), 500); }
    next.classList.add('show');
    S.page = i;
    $$('#steps li').forEach((li, n) => { li.classList.toggle('active', n === i); li.classList.toggle('done', n < i); });
    document.body.classList.toggle('installing', PAGES[i] === 'install');
    ENTER[PAGES[i]]?.();
    updateButtons();
  }
  function updateButtons() {
    const p = PAGES[S.page];
    const back = $('#back'); const next = $('#next'); const cancel = $('#cancel');
    back.style.visibility = ['welcome', 'install'].includes(p) || (p === 'finish' && S.result?.ok) ? 'hidden' : 'visible';
    cancel.style.visibility = p === 'finish' ? 'hidden' : 'visible';
    next.textContent = p === 'ready' ? (S.result && !S.result.ok ? 'Retry install' : 'Install') : p === 'finish' ? (S.result?.ok ? 'Finish' : 'Close') : 'Next';
    if (p === 'finish' && S.result && !S.result.ok) back.textContent = 'Back'; 
    next.disabled = !canNext(p);
    $('#foot-note').textContent = p === 'finish' ? '' : `PanUrgos Studio ${S.info?.version || ''} · Setup`;
  }
  function canNext(p) {
    if (p === 'welcome') return $('#accept').checked;
    if (p === 'system') return !!S.scan && !S.scan.blocking;
    if (p === 'location') return !!S.dirInfo && !S.dirInfo.error && !S.dirInfo.running && (S.dirInfo.free == null || S.dirInfo.free > needBytes());
    return true;
  }
  $('#next').onclick = () => {
    const p = PAGES[S.page];
    if (p === 'ready') return startInstall();
    if (p === 'finish') return setup.finish({ launch: $('#launch').checked && S.result?.ok });
    go(S.page + 1);
  };
  $('#back').onclick = () => go(PAGES[S.page] === 'finish' ? PAGES.indexOf('ready') : Math.max(0, S.page - 1));
  $('#cancel').onclick = () => { if (PAGES[S.page] === 'install' || confirm('Exit PanUrgos Studio Setup? Nothing has been installed yet.')) setup.close(); };
  $('#tb-close').onclick = () => $('#cancel').onclick();
  $('#tb-min').onclick = () => setup.minimize();
  $('#accept').onchange = updateButtons;

  // ---------------------------------------------------------------- page: system check
  const ICON = {
    os: '<path d="M3 5.5 10.5 4.4v7.1H3V5.5zm0 13 7.5 1.1v-7H3v5.9zm8.4 1.2L21 21V12.6h-9.6v7.1zm0-15.4v7.2H21V3l-9.6 1.3z"/>',
    cpu: '<path d="M9 2v2H7a3 3 0 0 0-3 3v2H2v2h2v2H2v2h2v2a3 3 0 0 0 3 3h2v2h2v-2h2v2h2v-2h2a3 3 0 0 0 3-3v-2h2v-2h-2v-2h2V9h-2V7a3 3 0 0 0-3-3h-2V2h-2v2h-2V2H9zm-1 6h8v8H8V8z"/>',
    ram: '<path d="M2 7h20v8h-2v2h-2v-2h-3v2h-2v-2H8v2H6v-2H4v2H2V7zm3 2v4h2V9H5zm4 0v4h2V9H9zm4 0v4h2V9h-2zm4 0v4h2V9h-2z"/>',
    gpu: '<path d="M2 7h18a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2v2h-2v-2H8v2H6v-2H4v2H2V7zm5 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zm8 0a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/>',
    disk: '<path d="M6 2h12l4 8v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10l4-8zm-1.7 9v9h15.4v-9H4.3zM17 14a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/>',
    pkg: '<path d="M12 2 3 7v10l9 5 9-5V7l-9-5zm0 2.3 6.7 3.7L12 11.7 5.3 8 12 4.3zM5 9.7l6 3.3v6.6l-6-3.3V9.7zm8 9.9V13l6-3.3v6.6l-6 3.3z"/>',
    app: '<path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3z"/>'
  };
  function scanItem(icon, k, wide) {
    const el = document.createElement('div');
    el.className = `scan-item${wide ? ' wide' : ''}`;
    el.innerHTML = `<div class="scan-icon"><svg viewBox="0 0 24 24">${ICON[icon]}</svg></div><div class="scan-main"><div class="k">${k}</div><div class="v">Checking…</div><div class="s"></div></div><div class="scan-state"><div class="spin"></div></div>`;
    $('#scan').append(el);
    requestAnimationFrame(() => el.classList.add('in'));
    return (v, s, st = 'ok') => {
      el.querySelector('.v').textContent = v;
      el.querySelector('.s').textContent = s || '';
      el.querySelector('.scan-state').innerHTML = `<div class="st-${st}">${st === 'ok' ? '✓' : st === 'warn' ? '!' : '✕'}</div>`;
    };
  }

  /** Turn raw hardware into PanUrgos's recommendation for THIS machine (any vendor, any size). */
  function analyse(hw) {
    const gpus = (hw.gpus || []).map((g) => ({ ...g, vram: Number(g.vram) || 0 }));
    const discrete = gpus.filter((g) => g.vendor !== 'other' && g.vram >= 1.5 * GB).sort((a, b) => b.vram - a.vram);
    const best = discrete[0] || null;
    const nvidia = gpus.find((g) => g.vendor === 'nvidia');
    const cudaOk = !!(nvidia && hw.cuda && cmpVer(hw.cuda, '12.4') >= 0);
    let accel, accelNote;
    if (cudaOk) { accel = `NVIDIA CUDA ${cmpVer(hw.cuda, '13.5') >= 0 ? '13.5' : '12.4'}`; accelNote = `Fastest option for your ${nvidia.name}. Optional download after setup.`; }
    else if (nvidia) { accel = 'Vulkan (GPU)'; accelNote = 'Update your NVIDIA driver to unlock CUDA. Vulkan acceleration works in the meantime.'; }
    else if (best && hw.vulkan) { accel = 'Vulkan (GPU)'; accelNote = `GPU-accelerated on your ${best.name} with the bundled Vulkan runtime.`; }
    else if (hw.vulkan && gpus.length) { accel = 'Vulkan (integrated GPU)'; accelNote = 'Integrated graphics will help with small models; larger ones run on the CPU.'; }
    else { accel = 'CPU'; accelNote = hw.avx2 ? 'No supported GPU found — models run on your CPU with AVX2.' : 'No supported GPU found — models run on the CPU (no AVX2: expect slower generation).'; }
    // Rough model budget: GPU memory when accelerated, else ~half of system RAM.
    const budget = best ? best.vram : (hw.ramBytes || 0) * 0.5;
    const tier = budget >= 40 * GB ? 'up to 70B' : budget >= 20 * GB ? 'up to 32B' : budget >= 10 * GB ? 'up to 14B' : budget >= 5 * GB ? '7B–8B' : budget >= 3 * GB ? '3B–4B' : '1B–2B';
    return { gpus, best, nvidia, cudaOk, accel, accelNote, tier, budget };
  }

  async function runScan() {
    $('#scan').innerHTML = '';
    S.scan = null; updateButtons();
    const items = {
      os: scanItem('os', 'Operating system'), cpu: scanItem('cpu', 'Processor'),
      ram: scanItem('ram', 'Memory'), disk: scanItem('disk', 'Disk space'),
      gpu: scanItem('gpu', 'Graphics', true),
      vc: scanItem('pkg', 'Visual C++ runtime'), app: scanItem('app', 'PanUrgos Studio')
    };
    const t0 = Date.now();
    const r = await setup.scan();
    await sleep(Math.max(0, 900 - (Date.now() - t0)));
    const hw = r.hw; const a = analyse(hw);
    const issues = [];
    const reveal = async (fn) => { fn(); await sleep(170); };

    await reveal(() => {
      const build = Number(hw.build || 0);
      const old = build && build < 17763;
      if (!/64/.test(hw.arch || '64')) issues.push({ bad: true, t: '64-bit Windows is required.' });
      items.os(`${hw.os || 'Windows'}`, `Version ${hw.version || '?'} · ${hw.arch || ''}`, old ? 'warn' : 'ok');
      if (old) issues.push({ t: 'Windows 10 version 1809 or newer is recommended.' });
    });
    await reveal(() => items.cpu(hw.cpu || 'Unknown CPU', `${hw.cores || '?'} cores · ${hw.threads || '?'} threads${hw.avx2 ? ' · AVX2' : ''}${hw.avx512 ? ' · AVX-512' : ''}`, hw.avx2 ? 'ok' : 'warn'));
    await reveal(() => {
      const ram = hw.ramBytes || 0;
      const st = ram < 8 * GB ? 'warn' : 'ok';
      if (st === 'warn') issues.push({ t: 'Less than 8 GB of memory: stick to small models (1B–3B).' });
      items.ram(fmt(ram), ram >= 31 * GB ? 'Plenty of room for large models' : ram >= 15 * GB ? 'Comfortable for most coding models' : ram >= 8 * GB ? 'Good for small and medium models' : 'Limited', st);
    });
    S.dir ||= r.existing?.dir || S.info.defaultDir;
    const di = await setup.dirInfo(S.dir);
    await reveal(() => items.disk(di.free != null ? `${fmt(di.free)} free` : 'Unknown', `PanUrgos needs ${fmt(needBytes())} on this drive`, di.free != null && di.free < needBytes() ? 'bad' : 'ok'));
    await reveal(() => {
      if (!a.gpus.length) items.gpu('No graphics adapter detected', a.accelNote, 'warn');
      else items.gpu(a.gpus.map((g) => `${g.name}${g.vram >= GB ? ` (${fmt(g.vram)})` : ''}`).join('  ·  '),
        `${a.accel} recommended${r.hw.cuda && a.nvidia ? ` · driver supports CUDA ${r.hw.cuda}` : ''} — ${a.accelNote}`, a.best || a.cudaOk ? 'ok' : 'warn');
    });
    await reveal(() => items.vc(r.vc ? `Installed (${r.vc})` : 'Not installed', r.vc ? 'Required by llama.cpp — already present' : 'Required by llama.cpp — Setup will install it (needs administrator permission)', r.vc ? 'ok' : 'warn'));
    await reveal(() => items.app(r.existing ? `Version ${r.existing.version} installed` : r.legacy ? `${r.legacy.name} ${r.legacy.version || ''} found` : 'Not installed', r.existing ? 'Setup will upgrade it. Settings, keys and models are kept.' : r.legacy ? `PanUrgos replaces ${r.legacy.name}. Your settings, keys and models carry over.` : 'Fresh installation', 'ok'));

    S.scan = { ...r, a, issues, blocking: issues.some((i) => i.bad) };
    const v = $('#verdict');
    v.className = `verdict${issues.length ? ' warn' : ''}`;
    v.innerHTML = `<div class="big">${S.scan.blocking ? '✕' : issues.length ? '⚠' : '✦'}</div><div><b>${S.scan.blocking ? 'This PC can’t run PanUrgos Studio' : issues.length ? 'Ready, with notes' : 'Your PC is ready for local AI'}</b>
      <p>${esc(a.accel)} acceleration · comfortable with <b>${a.tier}</b> parameter models (4-bit)${issues.length ? '<br>' + issues.map((i) => esc(i.t)).join('<br>') : ''}</p></div>`;
    initSelection();
    updateButtons();
  }

  // ---------------------------------------------------------------- page: location
  const needBytes = () => (S.info?.sizes.total || 400e6) + 50e6;
  async function checkDir() {
    const d = await setup.dirInfo($('#dir').value);
    S.dirInfo = d;
    const need = needBytes();
    $('#need-txt').textContent = fmt(need);
    $('#free-txt').textContent = d.free != null ? fmt(d.free) : 'Unknown';
    $('#space-used').style.width = d.free ? `${Math.min(100, Math.max(2, (need / d.free) * 100))}%` : '0%';
    const notes = [];
    if (d.error) notes.push(['bad', d.error]);
    if (d.free != null && d.free < need) notes.push(['bad', `Not enough space: ${fmt(need)} needed, ${fmt(d.free)} available.`]);
    if (d.running) { notes.push(['bad', 'PanUrgos Studio is running from this folder. Close it to continue — Setup will notice automatically.']); clearTimeout(S.recheck); S.recheck = setTimeout(() => { if (PAGES[S.page] === 'location') checkDir(); }, 2000); }
    if (d.existingApp && !d.running) notes.push(['info', 'PanUrgos Studio is installed here. Setup will upgrade it in place.']);
    if (d.nonEmpty) notes.push(['warn', 'This folder already contains other files. Consider an empty folder.']);
    $('#loc-notes').innerHTML = notes.map(([k, t]) => `<div class="note ${k}">${esc(t)}</div>`).join('');
    S.dir = d.dir;
    updateButtons();
  }
  $('#dir').addEventListener('input', debounce(checkDir, 300));
  $('#browse').onclick = async () => { const p = await setup.browse($('#dir').value); if (p) { $('#dir').value = p; checkDir(); } };
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ---------------------------------------------------------------- page: components
  function initSelection() {
    if (S.sel.init) return;
    const a = S.scan.a;
    S.sel = { init: true, startMenu: true, desktop: true, path: true, contextMenu: true, fileTypes: true, cuda: a.cudaOk, tools: new Set() };
  }
  function components() {
    const r = S.scan; const a = r.a; const sz = S.info.sizes; const L = S.info.llama;
    const toolsById = Object.fromEntries((r.tools.tools || []).map((t) => [t.id, t]));
    return [
      { group: 'Core', note: 'always installed', items: [
        { id: 'app', title: 'PanUrgos Studio', sub: 'Editor, agent, model manager and terminal', locked: true, tag: ['req', 'Required'], size: fmt(sz.app) },
        { id: 'llama', title: `llama.cpp runtime (${L.tag})`, sub: 'Local inference engine — Vulkan GPU acceleration with automatic CPU fallback', locked: true, tag: ['req', 'Required'], size: fmt(sz.llama) },
        r.vc ? { id: 'vc', title: 'Microsoft Visual C++ runtime', sub: `Already installed (${r.vc})`, present: true, tag: ['inst', 'Installed'] }
          : { id: 'vc', title: 'Microsoft Visual C++ runtime', sub: 'Needed by llama.cpp — Windows will ask for permission', locked: true, tag: ['admin', 'Requires admin'], size: '25 MB' }
      ] },
      { group: 'Acceleration', items: [
        a.cudaOk ? { id: 'cuda', title: `NVIDIA CUDA acceleration (CUDA ${cmpVer(r.hw.cuda, '13.5') >= 0 ? '13.5' : '12.4'})`, sub: `Fastest on your ${a.nvidia.name}. Downloads in the background on first launch.`, key: 'cuda', tag: ['rec', 'Recommended'], size: '≈610 MB download' }
          : { id: 'cuda', title: 'NVIDIA CUDA acceleration', sub: a.nvidia ? 'Your NVIDIA driver is too old for CUDA 12.4+. Update it, then add CUDA later from the Models panel.' : 'Not available — no NVIDIA GPU detected. The bundled Vulkan runtime is used instead.', present: true, disabled: true, tag: ['opt', 'Unavailable'] }
      ] },
      { group: 'Windows integration', items: [
        { id: 'startMenu', title: 'Start menu shortcut', sub: 'Find PanUrgos Studio in Start', key: 'startMenu', tag: ['opt', 'Optional'] },
        { id: 'desktop', title: 'Desktop shortcut', sub: 'Icon on your desktop', key: 'desktop', tag: ['opt', 'Optional'] },
        { id: 'path', title: 'Add “panurgos” to PATH', sub: 'Open folders from any terminal: panurgos .', key: 'path', tag: ['rec', 'Recommended'] },
        { id: 'contextMenu', title: '“Open with PanUrgos Studio” in File Explorer', sub: 'Right-click files, folders and folder backgrounds', key: 'contextMenu', tag: ['rec', 'Recommended'] },
        { id: 'fileTypes', title: 'Register as an editor for code files', sub: '57 file types. You choose the default in Windows Settings.', key: 'fileTypes', tag: ['opt', 'Optional'] }
      ] },
      { group: 'Developer runtimes', note: r.tools.winget ? 'installed from each publisher via winget' : 'winget is not available on this PC', items: ['git', 'node', 'python', 'dotnet', 'java', 'rust'].map((id) => {
        const t = toolsById[id]; if (!t) return null;
        if (t.installed) return { id, title: t.name, sub: `Already installed${t.version ? ` (${t.version})` : ''}`, present: true, tag: ['inst', 'Installed'] };
        if (!r.tools.winget) return { id, title: t.name, sub: 'Install manually, or later from the Packages panel', present: true, disabled: true, tag: ['opt', 'Unavailable'] };
        return { id, title: t.name, sub: t.desc, tool: true, tag: MACHINE_WIDE.has(id) ? ['admin', 'May ask for admin'] : ['opt', 'Optional'], size: `≈${TOOL_SIZE[id]} MB download` };
      }).filter(Boolean) }
    ];
  }
  const isOn = (c) => (c.tool ? S.sel.tools.has(c.id) : c.key ? !!S.sel[c.key] : false);
  function renderComponents() {
    const box = $('#components'); box.innerHTML = '';
    for (const g of components()) {
      const grp = document.createElement('div');
      grp.className = 'comp-group';
      grp.innerHTML = `<h3>${esc(g.group)}${g.note ? `<em>${esc(g.note)}</em>` : ''}</h3>`;
      for (const c of g.items) {
        const el = document.createElement('div');
        el.className = `comp${c.locked ? ' locked' : ''}${c.present ? ' present' : ''}${isOn(c) ? ' on' : ''}`;
        el.innerHTML = `<span class="cbx" ${c.disabled ? 'style="opacity:.35"' : ''}></span><div class="comp-main"><b>${esc(c.title)}</b><span>${esc(c.sub)}</span></div>
          <div class="comp-meta"><span class="tag ${c.tag[0]}">${esc(c.tag[1])}</span>${c.size ? `<span class="size">${esc(c.size)}</span>` : ''}</div>`;
        if (!c.locked && !c.present) el.onclick = () => {
          if (c.tool) { S.sel.tools.has(c.id) ? S.sel.tools.delete(c.id) : S.sel.tools.add(c.id); } else S.sel[c.key] = !S.sel[c.key];
          el.classList.toggle('on', isOn(c)); renderTotals();
        };
        grp.append(el);
      }
      box.append(grp);
    }
    renderTotals();
  }
  function plan() {
    const r = S.scan;
    return {
      dir: S.dir, startMenu: S.sel.startMenu, desktop: S.sel.desktop, path: S.sel.path, contextMenu: S.sel.contextMenu, fileTypes: S.sel.fileTypes,
      cuda: S.sel.cuda && r.a.cudaOk, vcredist: !r.vc, tools: [...S.sel.tools], legacy: r.legacy || null
    };
  }
  function downloadMB(p) { return (p.cuda ? 610 : 0) + p.tools.reduce((n, id) => n + (TOOL_SIZE[id] || 0), 0); }
  function renderTotals() {
    const p = plan();
    const dl = downloadMB(p);
    $('#comp-total').innerHTML = `<span>Install size <b>${fmt(needBytes())}</b></span><span>Downloads <b>${dl ? `≈${dl >= 1024 ? (dl / 1024).toFixed(1) + ' GB' : dl + ' MB'}` : 'none'}</b></span>`;
  }

  // ---------------------------------------------------------------- page: ready
  function renderSummary() {
    const p = S.plan = plan();
    const names = Object.fromEntries((S.scan.tools.tools || []).map((t) => [t.id, t.name]));
    const integ = [p.startMenu && 'Start menu shortcut', p.desktop && 'Desktop shortcut', p.path && 'panurgos command on PATH', p.contextMenu && '“Open with PanUrgos Studio”', p.fileTypes && 'Code file types'].filter(Boolean);
    const admin = [p.vcredist && 'Microsoft Visual C++ runtime', ...p.tools.filter((id) => MACHINE_WIDE.has(id)).map((id) => names[id])].filter(Boolean);
    const dl = downloadMB(p);
    const rows = [
      ['Destination', `<code>${esc(p.dir)}</code>`],
      ['Install for', 'Current user only — no administrator rights needed for PanUrgos itself'],
      ['Core', `PanUrgos Studio ${esc(S.info.version)} · llama.cpp ${esc(S.info.llama.tag)}${p.vcredist ? ' · Visual C++ runtime' : ''}`],
      ...(p.legacy ? [['Replaces', `${esc(p.legacy.name)} ${esc(p.legacy.version || '')} — removed first; settings, keys and models carry over`]] : []),
      ['Acceleration', p.cuda ? 'NVIDIA CUDA (downloads on first launch) + bundled Vulkan' : esc(S.scan.a.accel)],
      ['Integration', integ.length ? integ.map(esc).join(' · ') : 'None'],
      ['Developer runtimes', p.tools.length ? p.tools.map((id) => esc(names[id])).join(' · ') : 'None selected'],
      ['Downloads', dl ? `≈${dl} MB from official publishers` : 'None — everything is in this installer'],
      ['Permission prompts', admin.length ? `Windows will ask for permission for: ${admin.map(esc).join(', ')}` : 'None'],
      ['Disk space', `${fmt(needBytes())} required · ${S.dirInfo?.free != null ? fmt(S.dirInfo.free) + ' available' : ''}`]
    ];
    $('#summary').innerHTML = rows.map(([k, v]) => `<div class="k">${k}</div><div>${v}</div>`).join('');
  }

  // ---------------------------------------------------------------- page: install (cinematic)
  const SLIDE_MS = 7000;
  let slideTimer = null; let slideIdx = 0; let typer = null;
  function slides() {
    const a = S.scan.a;
    const accelLabel = S.plan.cuda ? `CUDA · ${a.nvidia.name.replace(/^NVIDIA\s+/i, '')}` : a.best ? `${a.accel} · ${a.best.name.replace(/^(NVIDIA|AMD|Intel\(R\))\s+/i, '')}` : `${a.accel} · ${S.scan.hw.threads || ''} threads`;
    const logo = '<svg viewBox="0 0 32 32"><defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><path d="M16 2 4 8v8c0 7 5.2 12.4 12 14 6.8-1.6 12-7 12-14V8L16 2z" fill="url(#sg)"/></svg>';
    const bg = (x, y, c, c2 = 'rgba(34,211,238,.10)') => `<div class="bg" style="background:radial-gradient(800px 500px at ${x}% ${y}%, ${c}, transparent 65%), radial-gradient(600px 400px at ${100 - x}% ${100 - y}%, ${c2}, transparent 65%), #030409"></div>`;
    return [
      { html: `${bg(80, 40, 'rgba(139,92,246,.35)')}<div class="copy"><div class="kicker">Privacy by architecture</div><h1>Your code never <span class="grad">leaves this machine.</span></h1><p>No telemetry. No cloud round-trips. PanUrgos’s interface is sealed off from the network, and every model runs on 127.0.0.1.</p></div>
          <div class="art"><div class="shield-art"><div class="ring"></div><div class="ring"></div><div class="ring"></div><i class="packet" style="top:38%"></i><i class="packet" style="top:62%;animation-delay:1.2s"></i>${logo.replace('<svg', '<svg class="sh"')}</div></div>` },
      { html: `${bg(20, 70, 'rgba(248,113,113,.18)', 'rgba(52,211,153,.12)')}<div class="copy"><div class="kicker">Break it. Fix it.</div><h1>From red to green <span class="grad">in seconds.</span></h1><p>Your agent reads the stack trace, finds the bug and proposes the patch, then waits for your OK before it touches a file.</p></div>
          <div class="art"><div class="codewin"><div class="tb"><i></i><i></i><i></i><span>tests/test_parser.py</span></div><div class="body" id="typer"></div></div></div>`, onShow: runTyper },
      { html: `${bg(75, 70, 'rgba(99,102,241,.32)')}<div class="copy"><div class="kicker">Your silicon, unleashed</div><h1>Intelligence that runs <span class="grad">on your hardware.</span></h1><p>llama.cpp is tuned for this PC: ${esc(accelLabel)}. Comfortable with ${esc(a.tier)} parameter models, offline and always available.</p></div>
          <div class="art"><div class="gpu">${'<i></i>'.repeat(72)}<div class="tps grad">${esc(a.accel.split(' (')[0])}</div><div class="label">${esc(accelLabel.toUpperCase())}</div></div></div>`, onShow: staggerCores },
      { html: `${bg(30, 30, 'rgba(52,211,153,.16)')}<div class="copy"><div class="kicker">The numbers</div><h1>Zero telemetry. <span class="grad">Zero tokens billed.</span></h1><p>Local models flip the economics of AI coding. Run the agent all day: there’s no meter running and nobody watching.</p></div>
          <div class="art"><div class="counters"><div class="counter"><b class="grad">$0</b><span>per token, forever</span></div><div class="counter"><b>0</b><span>prompts sent to the cloud by default</span></div><div class="counter"><b style="color:#34d399">127.0.0.1</b><span>where every model listens</span></div></div></div>` },
      { html: `${bg(70, 30, 'rgba(139,92,246,.28)')}<div class="copy"><div class="kicker">You stay in command</div><h1>An agent that <span class="grad">asks first.</span></h1><p>It can read, search, edit and run code in your project, sandboxed to the folder you opened, and every change waits for your approval.</p></div>
          <div class="art"><div class="approval"><div class="h">✦ The agent wants to run a command</div><pre>pytest tests/test_parser.py -q</pre><div class="f"><span>Deny</span><span class="a">Allow</span></div></div></div>` },
      { html: `${bg(25, 60, 'rgba(34,211,238,.20)')}<div class="copy"><div class="kicker">Open weights, open future</div><h1>Every open model, <span class="grad">one search away.</span></h1><p>Search Hugging Face from inside the editor. PanUrgos checks each model against your hardware before you download, then loads it in a click.</p></div>
          <div class="art"><div class="river">${riverCols()}</div></div>` },
      { html: `${bg(50, 45, 'rgba(139,92,246,.42)')}<div class="copy"><div class="kicker">PanUrgos · from the Greek <span style="text-transform:none;letter-spacing:.04em">πανοῦργος</span>, “capable of anything”</div><h1>Capable of <span class="grad">anything.</span></h1><p>Every model, every tool, every line of code, answering only to you and the people you trust. Welcome to PanUrgos.</p></div>
          <div class="art finale">${logo}</div>` }
    ];
  }
  function riverCols() {
    const models = [['Qwen2.5 Coder', '7B · Q4_K_M'], ['DeepSeek Coder', '6.7B · Q5_K_M'], ['Llama 3.1', '8B · Q4_K_M'], ['Gemma', '9B · Q4_K_M'], ['Mistral', '7B · Q4_K_M'], ['Phi', '3.8B · Q8_0'], ['StarCoder2', '15B · Q4_K_M'], ['Codestral', '22B · IQ4_XS'], ['Qwen2.5 Coder', '32B · Q4_K_M'], ['Granite Code', '8B · Q6_K']];
    const chip = ([n, s]) => `<div class="chip"><b>${n}</b><span>${s} · GGUF</span></div>`;
    const col = (arr) => `<div class="col">${[...arr, ...arr].map(chip).join('')}</div>`;
    return col(models) + col([...models].reverse());
  }
  function staggerCores() { $$('.slide.on .gpu i').forEach((c, i) => (c.style.animationDelay = `${(i % 12) * 0.08 + Math.floor(i / 12) * 0.13}s`)); }
  function runTyper() {
    clearInterval(typer);
    const box = $('#typer'); if (!box) return;
    const frames = [
      '<span class="kc"># tests/test_parser.py</span>\n<span class="k1">def</span> <span class="k2">test_parse_empty</span>():\n    <span class="k1">assert</span> parse(<span class="k3">""</span>) == []\n\n',
      '<span class="line-bad"><span class="k4">FAILED</span> test_parse_empty — IndexError</span>\n',
      '<span class="kc">  ✦ PanUrgos: tokens[0] is read before the\n    length check. Proposing a fix…</span>\n\n',
      '<span class="k1">def</span> <span class="k2">parse</span>(src):\n<span class="line-good">    <span class="k1">if not</span> src: <span class="k1">return</span> []</span>\n    tokens = lex(src)\n\n',
      '<span class="line-good"><span style="color:#34d399">PASSED</span> 24 passed in 0.31s</span>'
    ];
    let i = 0; box.innerHTML = '<span class="caret"></span>';
    typer = setInterval(() => {
      if (i >= frames.length) { clearInterval(typer); return; }
      box.innerHTML = frames.slice(0, ++i).join('') + '<span class="caret"></span>';
    }, 1100);
  }
  function startSlides() {
    const cin = $('#cinema');
    const list = slides();
    cin.innerHTML = list.map((s) => `<div class="slide">${s.html}</div>`).join('') + `<div class="dots">${list.map(() => '<i></i>').join('')}</div>`;
    cin.style.setProperty('--slide-ms', SLIDE_MS + 'ms');
    const show = (n) => {
      const els = $$('.slide', cin); const dots = $$('.dots i', cin);
      els.forEach((e, k) => e.classList.toggle('on', k === n));
      dots.forEach((d, k) => { d.classList.remove('on'); if (k === n) { void d.offsetWidth; d.classList.add('on'); } });
      list[n].onShow?.();
    };
    slideIdx = 0; show(0);
    slideTimer = setInterval(() => { slideIdx = (slideIdx + 1) % list.length; show(slideIdx); }, SLIDE_MS);
  }

  // progress HUD
  const ansi = (t) => {
    const map = { 31: 'c-red', 32: 'c-green', 33: 'c-yellow', 34: 'c-blue', 35: 'c-magenta', 36: 'c-cyan', 90: 'c-dim', 1: 'c-bold' };
    let open = 0;
    const out = esc(t).replace(/\x1b\[([\d;]*)m/g, (_, c) => { let s = ''; for (const n of (c || '0').split(';').map(Number)) { if (n === 0) { s += '</span>'.repeat(open); open = 0; } else if (map[n]) { s += `<span class="${map[n]}">`; open++; } } return s; });
    return out + '</span>'.repeat(open);
  };
  let steps = []; let filesPct = 0;
  function hudSteps(p) {
    const names = Object.fromEntries((S.scan.tools.tools || []).map((t) => [t.id, t.name]));
    steps = [...(p.legacy ? [['legacy', 'Replace ' + p.legacy.name]] : []), ['files', 'Program files'], ['cli', 'Command line'], ['shell', 'Windows integration']];
    if (p.vcredist) steps.push(['vcredist', 'Visual C++ runtime']);
    if (p.cuda) steps.push(['cuda', 'CUDA']);
    for (const id of p.tools) steps.push([`tool:${id}`, names[id] || id]);
    $('#hud-checks').innerHTML = steps.map(([id, l]) => `<span data-s="${id}"><i></i>${esc(l)}</span>`).join('');
  }
  function overall() {
    // Program files are the bulk of the work; the rest share the remainder.
    const rest = steps.filter(([id]) => id !== 'files');
    const others = rest.length;
    const done = rest.filter(([id]) => /done|warn|fail/.test($(`#hud-checks [data-s="${CSS.escape(id)}"]`)?.className || '')).length;
    return Math.min(1, filesPct * 0.72 + (others ? (done / others) * 0.28 : 0.28 * filesPct));
  }
  function setPct(f) { $('#hud-bar').style.width = `${(f * 100).toFixed(1)}%`; $('#hud-pct').textContent = `${Math.floor(f * 100)}%`; }
  setup.onProgress((m) => {
    if (m.log) { const l = $('#log'); l.insertAdjacentHTML('beforeend', ansi(m.log)); l.scrollTop = l.scrollHeight; }
    if (m.step) {
      const el = $(`#hud-checks [data-s="${CSS.escape(m.step)}"]`);
      if (el && m.state) el.className = m.state;
      if (m.step === 'files' && m.pct != null) filesPct = m.pct;
      if (m.state === 'done' && m.step === 'files') filesPct = 1;
      const label = steps.find(([id]) => id === m.step)?.[1] || m.step;
      if (m.state === 'run' || m.detail) $('#hud-step').textContent = m.state === 'fail' || m.state === 'warn' ? `${label}: ${m.detail}` : m.step === 'files' && m.detail ? `Installing program files · ${m.detail.split(/[\\/]/).pop()}` : m.detail || label;
      setPct(overall());
    }
  });
  $('#toggle-log').onclick = () => { const l = $('#log'); l.classList.toggle('hidden'); $('#toggle-log').textContent = l.classList.contains('hidden') ? 'Show details' : 'Hide details'; };

  async function startInstall() {
    S.plan = plan();
    go(PAGES.indexOf('install'));
    hudSteps(S.plan); setPct(0); startSlides();
    const r = await setup.install(S.plan);
    S.result = r;
    if (r.ok) { setPct(1); $('#hud-step').textContent = 'PanUrgos Studio successfully installed.'; await sleep(1600); }
    clearInterval(slideTimer); clearInterval(typer);
    go(PAGES.indexOf('finish'));
  }

  // ---------------------------------------------------------------- page: finish
  function renderFinish() {
    const r = S.result || { ok: false, results: [] };
    $('#finish-mark').classList.toggle('fail', !r.ok);
    $('#finish-mark path').setAttribute('d', r.ok ? 'M15 27l7 7 15-16' : 'M18 18l16 16M34 18L18 34');
    $('#finish-title').textContent = r.ok ? 'PanUrgos Studio is ready.' : 'Setup didn’t finish.';
    $('#finish-lead').textContent = r.ok ? 'Your editor, your models, your machine.' : (r.error || 'Something went wrong.');
    const names = Object.fromEntries((S.scan.tools.tools || []).map((t) => [t.id, t.name]));
    const label = (x) => (x.id.startsWith('tool:') ? names[x.id.slice(5)] || x.id.slice(5) : x.label);
    $('#results').innerHTML = (r.results || []).map((x) => `<div class="res"><span class="${x.ok ? 'st-ok' : x.id.startsWith('tool:') || x.id === 'cuda' ? 'st-warn' : 'st-bad'}">${x.ok ? '✓' : '!'}</span>${esc(label(x))}${x.ok ? '' : ` — <span style="color:var(--fg3)">${esc(x.error)}${x.id.startsWith('tool:') ? ' (retry later from the Packages panel)' : ''}</span>`}</div>`).join('');
    $('#launch').closest('label').style.display = r.ok ? '' : 'none';
  }

  const ENTER = {
    system: () => { if (!S.scan) runScan(); },
    location: () => { $('#dir').value = S.dir || S.info.defaultDir; checkDir(); },
    components: renderComponents,
    ready: renderSummary,
    finish: renderFinish
  };

  // ---------------------------------------------------------------- boot
  (async () => {
    S.info = await setup.info();
    $('#rail-version').textContent = `Version ${S.info.version}`;
    $('#license').textContent = S.info.license;
    go(0);
    requestAnimationFrame(() => $('.page[data-page="welcome"]').classList.add('show'));
  })();
})();
