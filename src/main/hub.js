// PanUrgos Studio — Hugging Face model hub + local GGUF library.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const HF = 'https://huggingface.co';
const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i;
const QUANT = /(?:^|[-_.])((?:I?Q\d(?:_[A-Z0-9]+)*)|BF16|FP16|F16|F32|MXFP4(?:_MOE)?)(?=[-_.]|\.gguf$)/i;

const quantOf = (name) => ((QUANT.exec(name) || [])[1] || '').toUpperCase();
const isMmproj = (name) => /mmproj/i.test(name);

class ModelHub extends EventEmitter {
  constructor({ net, getSettings, defaultDir }) {
    super();
    this.net = net;
    this.getSettings = getSettings;
    this.defaultDir = defaultDir;
    this.jobs = new Map();
  }
  get modelsDir() { return this.getSettings().local?.modelsDir || this.defaultDir; }
  _auth() { const t = this.net.getHfToken(); return t ? { Authorization: `Bearer ${t}` } : {}; }

  // ------------------------------------------------------------------ search
  async search(query, { sort = 'downloads' } = {}) {
    const q = new URLSearchParams({ filter: 'gguf', sort, direction: '-1', limit: '40', full: 'false' });
    if (query?.trim()) q.set('search', query.trim());
    const list = await this.net.getJson(`${HF}/api/models?${q}`, { scope: 'hub', purpose: 'search models', headers: this._auth() });
    return list.map((m) => ({
      id: m.id, downloads: m.downloads || 0, likes: m.likes || 0, updated: m.lastModified || m.createdAt,
      gated: !!m.gated, pipeline: m.pipeline_tag || '',
      tags: (m.tags || []).filter((t) => /^(license:|base_model:quantized:)/.test(t)).map((t) => t.replace(/^license:/, '').replace(/^base_model:quantized:/, 'base: '))
    }));
  }

  /** List GGUF variants in a repo, grouping split (sharded) files into one entry. */
  async files(repo) {
    const enc = repo.split('/').map(encodeURIComponent).join('/');
    const [tree, info] = await Promise.all([
      this.net.getJson(`${HF}/api/models/${enc}/tree/main?recursive=true`, { scope: 'hub', purpose: `list files of ${repo}`, headers: this._auth() }),
      this.net.getJson(`${HF}/api/models/${enc}`, { scope: 'hub', purpose: `model card of ${repo}`, headers: this._auth() }).catch(() => ({}))
    ]);
    const ggufs = tree.filter((e) => e.type === 'file' && /\.gguf$/i.test(e.path));
    const groups = new Map();
    for (const f of ggufs) {
      // Some repos publish the same quant both as one file and as split parts: keep those apart.
      const split = SHARD.test(f.path);
      const base = f.path.replace(SHARD, '.gguf');
      const key = split ? `${base}#split` : base;
      const g = groups.get(key) || { key, name: path.basename(base), quant: quantOf(path.basename(base)), mmproj: isMmproj(f.path), split, files: [], size: 0 };
      g.files.push({ path: f.path, size: f.lfs?.size ?? f.size, sha256: f.lfs?.oid || null });
      g.size += f.lfs?.size ?? f.size;
      groups.set(key, g);
    }
    // Prefer the single-file copy when both exist.
    for (const [key, g] of groups) if (g.split && groups.has(key.replace(/#split$/, ''))) groups.delete(key);
    const variants = [...groups.values()].map((g) => {
      g.files.sort((a, b) => a.path.localeCompare(b.path));
      g.downloaded = g.files.every((f) => fs.existsSync(this._dest(repo, f.path)));
      g.localPath = g.downloaded ? this._dest(repo, g.files[0].path) : null;
      return g;
    }).sort((a, b) => (a.mmproj - b.mmproj) || a.size - b.size);
    return { repo, gated: info.gated || false, license: info.cardData?.license || '', variants };
  }

  _dest(repo, file) { return path.join(this.modelsDir, ...repo.split('/'), ...file.split('/')); }

  // ------------------------------------------------------------------ download
  download(repo, variant) {
    const id = `${repo}::${variant.key}`;
    if (this.jobs.has(id)) return id;
    const ctrl = new AbortController();
    const job = { id, repo, name: variant.name, quant: variant.quant, total: variant.size, received: 0, speed: 0, state: 'downloading', error: null };
    this.jobs.set(id, { job, ctrl });
    const emit = () => this.emit('progress', { ...job });
    emit();
    (async () => {
      let done = 0;
      try {
        for (const f of variant.files) {
          const dest = this._dest(repo, f.path);
          if (fs.existsSync(dest) && fs.statSync(dest).size === f.size) { done += f.size; continue; }
          const url = `${HF}/${repo}/resolve/main/${f.path.split('/').map(encodeURIComponent).join('/')}`;
          await this.net.download(url, dest, {
            scope: 'hub', purpose: `download ${path.basename(f.path)}`, sha256: f.sha256, size: f.size, headers: this._auth(), signal: ctrl.signal,
            onProgress: ({ received, speed }) => { job.received = done + received; job.speed = speed; emit(); }
          });
          done += f.size;
        }
        job.state = 'done'; job.received = job.total; job.path = this._dest(repo, variant.files[0].path);
      } catch (e) {
        job.state = e.name === 'AbortError' || ctrl.signal.aborted ? 'cancelled' : 'error';
        job.error = job.state === 'error' ? e.message : null;
      } finally {
        emit();
        this.jobs.delete(id);
      }
    })();
    return id;
  }
  cancel(id) { this.jobs.get(id)?.ctrl.abort(); }
  activeJobs() { return [...this.jobs.values()].map((j) => ({ ...j.job })); }

  // ------------------------------------------------------------------ local library
  scanDirs() {
    const home = os.homedir();
    const hfHome = process.env.HF_HOME ? path.join(process.env.HF_HOME, 'hub') : path.join(home, '.cache', 'huggingface', 'hub');
    const dirs = [{ dir: this.modelsDir, source: 'PanUrgos' }];
    if (this.getSettings().local?.scanOtherApps !== false) {
      dirs.push(
        { dir: path.join(home, '.lmstudio', 'models'), source: 'LM Studio' },
        { dir: path.join(home, '.cache', 'lm-studio', 'models'), source: 'LM Studio' },
        { dir: hfHome, source: 'HF cache' }
      );
    }
    return dirs.filter((d) => fs.existsSync(d.dir));
  }
  list() {
    const out = []; const seen = new Set();
    for (const { dir, source } of this.scanDirs()) {
      const stack = [[dir, 0]];
      while (stack.length) {
        const [d, depth] = stack.pop();
        if (depth > 8) continue;
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) { if (e.name !== 'blobs' && e.name !== '.locks') stack.push([full, depth + 1]); continue; }
          if (!/\.gguf$/i.test(e.name) || isMmproj(e.name)) continue;
          const shard = SHARD.exec(e.name);
          if (shard && shard[1] !== '00001') continue;
          let st; try { st = fs.statSync(full); } catch { continue; }
          let size = st.size;
          if (shard) {
            size = 0;
            for (let i = 1; i <= Number(shard[2]); i++) {
              try { size += fs.statSync(full.replace(SHARD, `-${String(i).padStart(5, '0')}-of-${shard[2]}.gguf`)).size; } catch {}
            }
          }
          const key = `${e.name}:${size}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const rel = path.relative(dir, full).split(path.sep);
          const repo = source === 'HF cache' ? (rel[0] || '').replace(/^models--/, '').replace(/--/g, '/') : rel.length >= 3 ? `${rel[0]}/${rel[1]}` : '';
          out.push({ path: full, name: e.name.replace(SHARD, '.gguf'), size, quant: quantOf(e.name), source, repo, modified: st.mtimeMs, deletable: source === 'PanUrgos' });
        }
      }
    }
    return out.sort((a, b) => b.modified - a.modified);
  }
  inModelsDir(p) {
    const r = path.resolve(this.modelsDir); const f = path.resolve(p);
    return f.startsWith(r + path.sep);
  }
}

module.exports = { ModelHub, quantOf };
