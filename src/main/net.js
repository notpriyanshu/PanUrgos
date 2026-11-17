// PanUrgos Studio — guarded outbound networking for the model hub and runtime updater.
//
// Every request:
//   * must target an allow-listed host (redirects are followed MANUALLY and re-checked hop by hop),
//   * is gated by the matching privacy permission (privacy.allowHub / privacy.allowUpdates),
//   * is written to the Network Ledger, including each redirect hop.
// Downloads stream to a `.part` file, resume with HTTP Range, and are verified with SHA-256
// when the server publishes a digest.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const SCOPES = {
  hub: {
    setting: 'allowHub',
    label: 'Hugging Face',
    hosts: ['huggingface.co', 'hf.co'] // includes cdn-lfs*.hf.co, cas-bridge.xethub.hf.co
  },
  updates: {
    setting: 'allowUpdates',
    label: 'runtime updates',
    hosts: ['github.com', 'githubusercontent.com'] // api.github.com, objects/release-assets.githubusercontent.com
  }
};

const TRANSIENT = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'EAI_AGAIN']);

class NetworkPermissionError extends Error {
  constructor(scope) {
    super(`Network access for ${SCOPES[scope].label} is turned off. Allow it in Settings › Privacy & Security.`);
    this.code = 'NET_PERMISSION';
    this.scope = scope;
  }
}

function hostAllowed(url, scope) {
  let h;
  try { h = new URL(url); } catch { return false; }
  if (h.protocol !== 'https:') return false;
  return SCOPES[scope].hosts.some((d) => h.hostname === d || h.hostname.endsWith('.' + d));
}

function createNet({ ledger, getSettings, getSecret }) {
  function assertAllowed(scope) {
    if (!getSettings().privacy?.[SCOPES[scope].setting]) throw new NetworkPermissionError(scope);
  }

  /** fetch() with manual, allow-list-checked redirects and ledger entries. */
  async function guardedFetch(url, init = {}, { scope, purpose }) {
    assertAllowed(scope);
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      if (!hostAllowed(current, scope)) throw new Error(`Blocked: ${new URL(current).host} is not an allowed host for ${SCOPES[scope].label}.`);
      const headers = { 'User-Agent': 'PanUrgosStudio', ...(init.headers || {}) };
      // Only send credentials to the origin host family, never to CDNs we were redirected to.
      if (hop > 0) delete headers.Authorization;
      const started = Date.now();
      const entry = {
        id: Math.random().toString(36).slice(2), ts: started, method: init.method || 'GET',
        url: current, host: new URL(current).host, local: false, scope, purpose: hop ? `${purpose} (redirect)` : purpose,
        bytesOut: 0, status: 'pending'
      };
      ledger.add(entry);
      let res;
      for (let attempt = 1; ; attempt++) {
        try {
          res = await fetch(current, { ...init, headers, redirect: 'manual' });
          break;
        } catch (e) {
          // CDNs (CloudFront for Hugging Face) sometimes hand out an edge that doesn't answer; a new
          // connection usually lands on a healthy one. Only retry idempotent requests that never connected.
          if (attempt < 3 && (init.method || 'GET') === 'GET' && TRANSIENT.has(e.cause?.code) && !init.signal?.aborted) {
            await new Promise((r) => setTimeout(r, 400 * attempt));
            continue;
          }
          const why = e.cause?.code ? `${e.message} (${e.cause.code})` : e.message;
          ledger.update(entry.id, { status: 'error', error: why, ms: Date.now() - started });
          throw new Error(e.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ? `Could not reach ${entry.host} (connection timed out). Check your connection and try again.` : why);
        }
      }
      ledger.update(entry.id, { status: res.status, ms: Date.now() - started });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).toString();
        try { await res.body?.cancel(); } catch {}
        continue;
      }
      return res;
    }
    throw new Error('Too many redirects.');
  }

  async function getJson(url, opts) {
    const res = await guardedFetch(url, { headers: opts.headers || {}, signal: opts.signal || AbortSignal.timeout(20000) }, opts);
    if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Download `url` to `dest` with resume + optional SHA-256 verification.
   * onProgress({ received, total, speed }) is throttled to ~4 Hz.
   */
  async function download(url, dest, { scope, purpose, sha256, size, headers = {}, signal, onProgress }) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = dest + '.part';
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (size && have > size) { fs.rmSync(part); have = 0; }

    // Pre-flight disk space check.
    if (size) {
      try {
        const st = fs.statfsSync(path.dirname(dest));
        const free = st.bavail * st.bsize;
        if (free < size - have + 256 * 1024 * 1024) throw new Error(`Not enough disk space: need ${(size / 1e9).toFixed(1)} GB, ${(free / 1e9).toFixed(1)} GB free.`);
      } catch (e) { if (/disk space/.test(e.message)) throw e; }
    }

    const res = await guardedFetch(url, { headers: { ...headers, ...(have ? { Range: `bytes=${have}-` } : {}) }, signal }, { scope, purpose });
    const complete = res.status === 416 && size && have === size;
    if (!complete && !(res.ok || res.status === 206)) throw new Error(`Download failed: HTTP ${res.status}`);
    if (have && res.status === 200) have = 0; // server ignored Range: start over

    let hash = sha256 ? crypto.createHash('sha256') : null;
    if (hash && have) {
      // Re-hash what we already have so the final digest covers the whole file.
      await new Promise((resolve, reject) => fs.createReadStream(part).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject));
    }

    const total = size || (Number(res.headers.get('content-length') || 0) + have);
    let received = have;
    let lastEmit = 0; let lastBytes = received; let lastTime = Date.now();
    if (!complete) {
      const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
      const body = Readable.fromWeb(res.body);
      try {
        for await (const chunk of body) {
          if (signal?.aborted) throw Object.assign(new Error('Download cancelled'), { name: 'AbortError' });
          hash?.update(chunk);
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          received += chunk.length;
          const now = Date.now();
          if (onProgress && now - lastEmit > 250) {
            const speed = ((received - lastBytes) / ((now - lastTime) / 1000)) || 0;
            onProgress({ received, total, speed });
            lastEmit = now; lastBytes = received; lastTime = now;
          }
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
    }
    onProgress?.({ received, total, speed: 0 });
    if (hash) {
      const got = hash.digest('hex');
      if (got.toLowerCase() !== sha256.toLowerCase()) {
        fs.rmSync(part, { force: true });
        throw new Error(`Checksum mismatch for ${path.basename(dest)} — the file was deleted. Try again.`);
      }
    }
    fs.renameSync(part, dest);
    return dest;
  }

  return { guardedFetch, getJson, download, assertAllowed, hostAllowed, getHfToken: () => getSecret('huggingface') };
}

module.exports = { createNet, NetworkPermissionError, SCOPES };
