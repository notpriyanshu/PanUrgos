// Packages panel: install toolchains (winget on Windows, Homebrew on macOS, apt hints on Linux) and project libraries (npm, pip, NuGet, cargo, go)
// from inside PanUrgos. Everything runs visibly in the integrated terminal.
U.packages = (() => {
  const { $, el, esc, bus, toast, state } = U;
  let tools = null;
  let project = { items: [], venv: false, hasPython: false };
  let installing = null;
  const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // Each package name is single-quoted for the shell, so specs like requests>=2.31 can't redirect or chain commands.
  const VALID = /^[A-Za-z0-9@_.][A-Za-z0-9@/_.\-=<>!~^,\[\]:+]*$/;
  const isWin = () => state.appInfo?.platform === 'win32';
  const quote = (s) => (isWin() ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`);

  async function refresh() {
    renderTools(true);
    try { [tools, project] = await Promise.all([panurgos.tools.detect(), panurgos.tools.project()]); }
    catch (e) { toast(clean(e), 'bad'); }
    renderTools(); renderProject();
  }

  // ------------------------------------------------------------ toolchains
  function renderTools(loading) {
    const box = $('#pkg-tools'); if (!box) return;
    if (loading && !tools) { box.innerHTML = '<div class="muted small pad">Detecting installed tools…</div>'; return; }
    if (!tools) return;
    box.innerHTML = '';
    const mgr = tools.manager;
    $('#pkg-mgr').textContent = mgr ? 'via ' + mgr.label : '';
    if (!mgr) box.append(el('div', { class: 'err-line' }, tools.platform === 'darwin' ? 'Homebrew isn’t installed, so toolchains can’t be installed from here. Get it from brew.sh, then refresh.' : tools.platform === 'linux' ? 'Install toolchains with your distribution’s package manager. Copy a command below and run it in a terminal (it needs sudo).' : 'winget isn’t available, so toolchains can’t be installed from here. Install “App Installer” from the Microsoft Store, or install the tools manually.'));
    for (const t of tools.tools) {
      const row = el('div', { class: 'lm-row' });
      row.innerHTML = `<div class="lm-main"><div class="lm-name">${t.installed ? '<span class="dot ok"></span>' : ''}${esc(t.name)}${t.required ? ' <span class="tag cloud">REQUIRED</span>' : ''}</div>
        <div class="muted small">${t.installed ? `Installed${t.version ? ' · ' + esc(t.version) : ''}` : esc(t.desc)}</div></div>`;
      const act = el('div', { class: 'lm-act' });
      if (installing === t.id) act.append(el('span', { class: 'muted small' }, 'Installing…'));
      else if (!t.installed && t.hint && !mgr) act.append(el('button', { class: 'btn sm', title: t.hint, onclick: () => { navigator.clipboard.writeText(t.hint); toast('Copied: ' + t.hint, 'ok'); } }, 'Copy command'));
      else if (!t.installed) act.append(el('button', { class: 'btn sm', disabled: !mgr || !!installing, onclick: () => installTool(t) }, 'Install'));
      row.append(act);
      box.append(row);
    }
  }

  async function installTool(t) {
    const ok = await U.confirm(`Install ${t.name}?`,
      tools.manager?.id === 'brew' ? `PanUrgos will run “brew install ${t.brew.join(' ')}” to install ${t.name}. macOS may ask for your password. By continuing you accept that package’s license.` : `PanUrgos will run winget to install ${t.name} (${t.winget}) from its publisher’s official installer. Windows may ask for administrator permission. By continuing you accept that package’s license.`, 'Install');
    if (!ok) return;
    installing = t.id; renderTools();
    U.showPanel('terminal');
    try {
      const r = await panurgos.tools.install(t.id);
      toast(r.ok ? `${t.name} installed — the terminal can use it right away.` : `${t.name} didn’t install (exit ${r.code}). See the terminal for details.`, r.ok ? 'ok' : 'bad', 7000);
    } catch (e) { toast(clean(e), 'bad'); }
    installing = null;
    refresh();
  }

  // ------------------------------------------------------------ project libraries
  function renderProject() {
    const box = $('#pkg-project'); if (!box) return;
    box.innerHTML = '';
    if (!state.workspace) { box.append(el('div', { class: 'muted small pad' }, 'Open a folder to manage its dependencies.')); return; }
    if (!project.items.length && !project.hasPython) {
      box.append(el('div', { class: 'muted small pad' }, 'No package.json, requirements.txt, pyproject.toml, .csproj, Cargo.toml or go.mod found in this folder.'));
    }
    if (project.hasPython && !project.venv) {
      box.append(el('div', { class: 'pkg-card' },
        el('div', { class: 'lm-name' }, 'Python virtual environment'),
        el('div', { class: 'muted small' }, 'Keep this project’s packages separate from your system Python.'),
        el('button', { class: 'btn sm', onclick: () => run(isWin() ? 'python -m venv .venv' : 'python3 -m venv .venv') }, 'Create .venv')));
    }
    for (const p of project.items) {
      const input = el('input', { class: 'input', placeholder: `Add a ${p.manager} package…`, spellcheck: 'false' });
      const add = () => {
        const names = input.value.trim().split(/\s+/).filter(Boolean);
        if (!names.length) return;
        const bad = names.find((n) => !VALID.test(n));
        if (bad) { toast(`“${bad}” doesn’t look like a package name.`, 'bad'); return; }
        run(p.add.replace('{pkg}', names.map(quote).join(' ')));
        input.value = '';
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
      box.append(el('div', { class: 'pkg-card' },
        el('div', { class: 'lm-name' }, p.label),
        el('div', { class: 'pkg-cmd' }, el('code', {}, p.install), el('button', { class: 'btn sm primary', onclick: () => run(p.install) }, 'Install deps')),
        p.add ? el('div', { class: 'pkg-add' }, input, el('button', { class: 'btn sm', onclick: add }, 'Add')) : null));
    }
  }

  function run(cmd) {
    U.showPanel('terminal');
    U.terminal.run(cmd);
    setTimeout(async () => { project = await panurgos.tools.project(); renderProject(); }, 4000);
  }

  bus.on('workspace', async () => { project = await panurgos.tools.project(); renderProject(); });
  bus.on('view', (v) => { if (v === 'packages' && !tools) refresh(); });
  document.addEventListener('DOMContentLoaded', () => { $('#pkg-refresh').onclick = refresh; });
  return { refresh };
})();
