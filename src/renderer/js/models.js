// Models panel: built-in llama.cpp runtime, Hugging Face search, and the local GGUF library.
U.models = (() => {
  const { $, el, esc, bus, toast, state } = U;
  let rt = null;              // runtime status from main
  let local = [];             // local models
  const jobs = new Map();     // active HF downloads by id
  const openRepos = new Map(); // repo -> files result
  let lastQuery = '';

  const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const gb = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
  const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
  const backendLabel = (b) => ({ 'cuda-13.5': 'CUDA 13.5', 'cuda-12.4': 'CUDA 12.4', 'cuda-12.8': 'CUDA 12.8', vulkan: 'Vulkan', cpu: 'CPU', metal: 'Metal' }[b] || b);

  // ------------------------------------------------------------ network consent
  const SCOPE = {
    hub: { flag: 'allowHub', host: 'huggingface.co', what: 'your search text and the names of models you pick. Your code and prompts are never sent.' },
    updates: { flag: 'allowUpdates', host: 'github.com', what: 'a request for the list of llama.cpp builds, then the build files. Nothing about your code or models is sent.' }
  };
  async function withConsent(scope, fn) {
    try { return await fn(); } catch (e) {
      if (!/is turned off/.test(clean(e))) throw e;
      const s = SCOPE[scope];
      const ok = await U.modal({ title: `Allow PanUrgos to contact ${s.host}?`, icon: '<span class="spark">✦</span> ',
        html: `<p>Model chats stay on this machine. This permission only lets PanUrgos’s main process reach <b>${s.host}</b>.</p>
               <p class="muted">It sends ${s.what}</p>
               <p class="muted small">Every request is listed in the Network Ledger. You can turn this off any time in Settings › Privacy &amp; Security.</p>`,
        buttons: [{ label: 'Not now', value: false }, { label: 'Allow', value: true, primary: true }] });
      if (!ok) throw new Error('cancelled');
      await U.settingsUI.patch({ privacy: { [s.flag]: true } }, true);
      return fn();
    }
  }

  // ------------------------------------------------------------ runtime card
  function fitBadge(size) {
    const hw = rt?.hardware;
    if (!hw) return '';
    const vram = Math.max(0, ...(hw.gpus || []).map((g) => g.vramMB)) * 1048576;
    const ram = hw.ramMB * 1048576;
    const need = size + 1.2e9; // weights + KV cache for ~8k context + CUDA/driver overhead
    if (vram && need <= vram * 0.95) return '<span class="tag local" title="Fits entirely in GPU memory">FITS GPU</span>';
    if (size <= vram + ram * 0.5) return `<span class="tag cloud" title="${vram ? 'Part of the model runs on CPU — slower' : 'Runs on CPU'}">${vram ? 'PARTIAL GPU' : 'CPU'}</span>`;
    return '<span class="tag blocked" title="Probably too large for this machine">TOO LARGE</span>';
  }

  function renderRuntime() {
    const card = $('#rt-card'); if (!card || !rt) return;
    const srv = rt.server || {};
    const gpu = rt.hardware?.gpus?.[0];
    const hwLine = gpu ? `${esc(gpu.name)} · ${(gpu.vramMB / 1024).toFixed(0)} GB VRAM` : `${(rt.hardware?.ramMB / 1024 || 0).toFixed(0)} GB RAM · no NVIDIA GPU found`;
    let body = '';
    if (rt.installing) {
      const p = rt.installing; const pct = p.total ? Math.round((p.received / p.total) * 100) : 0;
      body = `<div class="rt-line"><b>Installing llama.cpp ${esc(p.tag)}</b> · ${backendLabel(p.backend)}</div>
        <div class="muted small">${esc({ download: 'Downloading', extract: 'Unpacking', verify: 'Checking the build' }[p.phase] || p.phase)} ${esc(p.file || '')}</div>
        <div class="bar"><i style="width:${p.phase === 'download' ? pct : 100}%"></i></div>
        <div class="muted small">${p.phase === 'download' ? `${gb(p.received)} of ${gb(p.total)}` : ''}</div>`;
    } else if (!rt.installed) {
      body = `<div class="rt-line"><b>llama.cpp is not installed</b></div>
        <div class="muted small">Run models directly inside PanUrgos — no LM Studio or Unsloth needed. PanUrgos will install the <b>${backendLabel(rt.backend)}</b> build for ${hwLine}.</div>
        <button class="btn primary sm" id="rt-install">Install llama.cpp</button>`;
    } else {
      const st = srv.state || 'stopped';
      const dot = st === 'ready' ? 'ok' : st === 'error' ? 'bad' : st === 'starting' ? 'cloud' : '';
      const modelName = srv.model ? esc(srv.model.split(/[\\/]/).pop()) : 'No model loaded';
      body = `<div class="rt-line"><span class="dot ${dot}"></span><b>${modelName}</b></div>
        <div class="muted small">${{ ready: `Running on 127.0.0.1:${srv.port}${srv.loadMs ? ` · loaded in ${(srv.loadMs / 1000).toFixed(1)}s` : ''}`, starting: 'Loading model…', stopping: 'Stopping…', error: esc(srv.error || 'Stopped with an error'), stopped: 'Idle — loads on your first message' }[st]}</div>
        <div class="muted small">llama.cpp ${esc(rt.active.tag)} · ${backendLabel(rt.active.backend)} · ${hwLine}</div>
        <div class="rt-actions">
          ${st === 'ready' || st === 'starting' ? '<button class="btn sm" id="rt-stop">Unload</button>' : ''}
          ${rt.update?.available ? `<button class="btn primary sm" id="rt-update">${rt.update.backend !== rt.active.backend ? `Get ${backendLabel(rt.update.backend)} build` : `Update to ${esc(rt.update.tag)}`}</button>` : '<button class="btn sm ghost" id="rt-check">Check for updates</button>'}
          <button class="btn sm ghost" id="rt-logs">Logs</button>
        </div>`;
    }
    card.innerHTML = `<div class="rt-head"><span class="mdl-title" style="padding:0">LOCAL RUNTIME</span><span class="tag local">127.0.0.1</span></div>${body}`;
    card.querySelector('#rt-install')?.addEventListener('click', install);
    card.querySelector('#rt-update')?.addEventListener('click', install);
    card.querySelector('#rt-check')?.addEventListener('click', check);
    card.querySelector('#rt-stop')?.addEventListener('click', () => panurgos.runtime.stop());
    card.querySelector('#rt-logs')?.addEventListener('click', showLogs);
    renderStatusBar();
  }

  function renderStatusBar() {
    const sb = $('#st-runtime'); if (!sb || !rt) return;
    if (rt.installing) { sb.textContent = '⟳ Installing llama.cpp…'; return; }
    if (!rt.installed) { sb.textContent = ''; return; }
    const srv = rt.server || {};
    const name = srv.alias || (srv.model || '').split(/[\\/]/).pop().replace(/\.gguf$/i, '');
    sb.textContent = { ready: `● ${name}`, starting: '◌ Loading model…', error: '⚠ Model stopped', stopped: '○ llama.cpp idle', stopping: '○ Unloading…' }[srv.state] || '';
  }

  async function check() {
    try { const info = await withConsent('updates', () => panurgos.runtime.check()); toast(info.available ? `llama.cpp ${info.tag} is available` : `llama.cpp is up to date (${info.tag})`, 'ok'); }
    catch (e) { if (clean(e) !== 'cancelled') toast(clean(e), 'bad'); }
  }
  async function install() {
    try {
      await withConsent('updates', () => panurgos.runtime.install());
      toast(`llama.cpp ${rt?.active?.tag || ''} installed`, 'ok');
    } catch (e) { if (clean(e) !== 'cancelled') toast('Install failed: ' + clean(e), 'bad', 9000); }
  }
  async function showLogs() {
    const logs = await panurgos.runtime.logs();
    U.modal({ title: 'llama-server log', html: `<pre>${esc(logs.split('\n').slice(-200).join('\n') || '(empty)')}</pre>` });
  }

  // ------------------------------------------------------------ load a model
  async function load(modelPath) {
    if (!rt?.installed) {
      const ok = await U.confirm('Install llama.cpp first?', `PanUrgos needs the llama.cpp runtime to run this model. It will download the ${backendLabel(rt?.backend)} build from github.com.`, 'Install');
      if (!ok) return;
      await install();
      if (!rt?.installed) return;
    }
    try {
      if (state.settings.activeProvider !== 'panurgos') await U.settingsUI.patch({ activeProvider: 'panurgos' }, true);
      toast(`Loading ${modelPath.split(/[\\/]/).pop()}…`);
      await panurgos.runtime.start(modelPath);
      toast('Model ready — ask the agent anything', 'ok');
      U.setModelStatus('ok');
      renderLocal();
    } catch (e) { toast(clean(e), 'bad', 10000); U.setModelStatus('bad'); }
  }

  // ------------------------------------------------------------ Hugging Face
  const search = U.debounce(async (q) => {
    lastQuery = q;
    const box = $('#hf-results');
    box.innerHTML = '<div class="muted small pad">Searching…</div>';
    try {
      const res = await withConsent('hub', () => panurgos.hub.search(q));
      if (q !== lastQuery) return;
      box.innerHTML = '';
      if (!res.length) { box.innerHTML = '<div class="muted small pad">No GGUF models found.</div>'; return; }
      for (const m of res) box.append(repoRow(m));
    } catch (e) {
      box.innerHTML = clean(e) === 'cancelled' ? '<div class="muted small pad">Hugging Face access is off.</div>' : `<div class="err-line">${esc(clean(e))}</div>`;
    }
  }, 350);

  function repoRow(m) {
    const [owner, name] = m.id.split('/');
    const row = el('div', { class: 'hf-repo' });
    const head = el('button', { class: 'hf-head', title: m.id, html:
      `<div class="hf-name"><span class="muted">${esc(owner)}/</span>${esc(name)}</div>
       <div class="hf-meta muted small">↓ ${num(m.downloads)} · ♥ ${num(m.likes)}${m.gated ? ' · <span class="tag cloud">GATED</span>' : ''}${m.tags[0] ? ' · ' + esc(m.tags[0]) : ''}</div>` });
    const files = el('div', { class: 'hf-files hidden' });
    head.onclick = async () => {
      if (!files.classList.contains('hidden')) { files.classList.add('hidden'); return; }
      files.classList.remove('hidden');
      files.innerHTML = '<div class="muted small pad">Loading files…</div>';
      try {
        const r = openRepos.get(m.id) || await withConsent('hub', () => panurgos.hub.files(m.id));
        openRepos.set(m.id, r);
        renderVariants(files, r);
      } catch (e) { files.innerHTML = `<div class="err-line">${esc(clean(e))}</div>`; }
    };
    row.append(head, files);
    return row;
  }

  function renderVariants(box, r) {
    box.innerHTML = '';
    const vs = r.variants.filter((v) => !v.mmproj);
    if (!vs.length) { box.innerHTML = '<div class="muted small pad">No GGUF files in this repo.</div>'; return; }
    if (r.gated) box.append(el('div', { class: 'muted small pad', html: 'Gated model — add a Hugging Face token in Settings › Local Runtime and accept the license on huggingface.co.' }));
    for (const v of vs) {
      const job = jobs.get(`${r.repo}::${v.key}`);
      const line = el('div', { class: 'hf-variant', 'data-job': `${r.repo}::${v.key}` });
      line.innerHTML = `<div class="hv-main"><b>${esc(v.quant || v.name)}</b> <span class="muted small">${gb(v.size)}${v.files.length > 1 ? ` · ${v.files.length} parts` : ''}</span> ${fitBadge(v.size)}</div>`;
      const act = el('div', { class: 'hv-act' });
      if (job) act.append(progressEl(job));
      else if (v.downloaded) act.append(el('button', { class: 'btn sm primary', onclick: () => load(v.localPath) }, 'Use'));
      else act.append(el('button', { class: 'btn sm', onclick: () => startDownload(r, v) }, 'Download'));
      line.append(act);
      box.append(line);
    }
  }

  function progressEl(job) {
    const pct = job.total ? Math.round((job.received / job.total) * 100) : 0;
    return el('div', { class: 'dl' },
      el('div', { class: 'bar' }, el('i', { style: `width:${pct}%` })),
      el('div', { class: 'muted small dl-line' }, `${pct}% · ${gb(job.received)} / ${gb(job.total)}${job.speed ? ` · ${gb(job.speed)}/s` : ''}`,
        el('button', { class: 'link-btn', onclick: () => panurgos.hub.cancel(job.id) }, 'Cancel')));
  }

  async function startDownload(r, v) {
    try { await withConsent('hub', () => panurgos.hub.download(r.repo, v)); }
    catch (e) { if (clean(e) !== 'cancelled') toast(clean(e), 'bad'); }
  }

  function refreshOpenVariants() {
    document.querySelectorAll('.hf-files:not(.hidden)').forEach((box) => {
      const repo = box.parentElement.querySelector('.hf-head').title;
      const r = openRepos.get(repo); if (r) renderVariants(box, r);
    });
  }

  panurgos.hub.onProgress(async (job) => {
    if (job.state === 'downloading') jobs.set(job.id, job); else jobs.delete(job.id);
    const line = document.querySelector(`.hf-variant[data-job="${CSS.escape(job.id)}"] .hv-act`);
    if (job.state === 'downloading') { if (line) { line.innerHTML = ''; line.append(progressEl(job)); } return; }
    if (job.state === 'done') {
      const r = openRepos.get(job.repo);
      if (r) { const v = r.variants.find((x) => `${r.repo}::${x.key}` === job.id); if (v) { v.downloaded = true; v.localPath = job.path; } }
      toast(`${job.name} downloaded`, 'ok');
      refreshOpenVariants(); listLocal();
      if (await U.confirm(`Load ${job.name} now?`, 'PanUrgos will start it with the built-in llama.cpp runtime and make it the active model.', 'Load model')) load(job.path);
    } else {
      if (job.state === 'error') toast(`Download failed: ${job.error}`, 'bad', 9000);
      refreshOpenVariants();
    }
  });

  // ------------------------------------------------------------ local library
  async function listLocal() {
    const r = await panurgos.models.list();
    local = r.models;
    renderLocal();
  }
  function renderLocal() {
    const box = $('#local-models'); if (!box) return;
    $('#local-count').textContent = local.length;
    box.innerHTML = '';
    if (!local.length) { box.append(el('div', { class: 'muted small pad' }, 'No GGUF models yet. Search Hugging Face above to download one.')); return; }
    const activePath = rt?.server?.model;
    for (const m of local) {
      const isActive = activePath === m.path && rt?.server?.state === 'ready';
      const row = el('div', { class: `lm-row ${isActive ? 'active' : ''}`, title: m.path });
      row.innerHTML = `<div class="lm-main"><div class="lm-name">${isActive ? '<span class="dot ok"></span>' : ''}${esc(m.name.replace(/\.gguf$/i, ''))}</div>
        <div class="muted small">${gb(m.size)} · ${esc(m.source)} ${fitBadge(m.size)}</div></div>`;
      const act = el('div', { class: 'lm-act' });
      act.append(isActive
        ? el('button', { class: 'btn sm', onclick: () => panurgos.runtime.stop() }, 'Unload')
        : el('button', { class: 'btn sm primary', onclick: () => load(m.path) }, 'Load'));
      act.append(el('button', { class: 'icon-btn', title: 'More', onclick: (e) => {
        const items = [['Reveal in File Explorer', () => panurgos.models.reveal(m.path)], ['Copy path', () => navigator.clipboard.writeText(m.path)]];
        if (m.deletable) items.push('-', ['Delete…', async () => {
          if (!(await U.confirm(`Move ${m.name} to the trash?`, `${gb(m.size)} will be freed after you empty the trash.`, 'Move to Trash', true))) return;
          try { await panurgos.models.delete(m.path); listLocal(); } catch (err) { toast(clean(err), 'bad'); }
        }]);
        U.showMenu(e.clientX, e.clientY, items);
      }, html: '<svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>' }));
      row.append(act);
      box.append(row);
    }
  }

  // ------------------------------------------------------------ events + boot
  panurgos.runtime.onEvent(({ type, data }) => {
    if (type === 'status') { rt = data; renderRuntime(); renderLocal(); bus.emit('runtime', rt); if (state.settings?.activeProvider === 'panurgos') U.setModelStatus(rt.server?.state === 'ready' ? 'ok' : rt.server?.state === 'error' ? 'bad' : ''); }
    if (type === 'progress' && rt) { rt.installing = data; renderRuntime(); }
    if (type === 'crash') toast(data, 'bad', 12000);
    if (type === 'notice') toast(data, 'ok', 8000);
    if (type === 'update') toast(`llama.cpp ${data.tag} is available — open the Models panel to update.`, '', 9000);
    if (type === 'log') { const o = $('#output-view'); if (o) { o.textContent += data; if (o.textContent.length > 200000) o.textContent = o.textContent.slice(-150000); } }
  });

  document.addEventListener('DOMContentLoaded', async () => {
    rt = await panurgos.runtime.status();
    renderRuntime();
    listLocal();
    for (const j of await panurgos.hub.jobs()) jobs.set(j.id, j);
    $('#hf-input').addEventListener('input', (e) => search(e.target.value));
    $('#hf-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(e.target.value); });
    $('#mdl-refresh').onclick = () => { listLocal(); panurgos.runtime.status().then((s) => { rt = s; renderRuntime(); }); };
    $('#mdl-settings').onclick = () => U.settingsUI.open('runtime');
    $('#st-runtime').onclick = () => U.showView('models');
  });

  return { load, listLocal, install, check, status: () => rt, backendLabel };
})();
