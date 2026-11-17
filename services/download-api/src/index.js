// PanUrgos download API (Cloudflare Worker).
//
//   POST /signup  {email, platform, notify}  -> emails a single-use sign-in link (30 min)
//   POST /redeem  {token}                    -> verifies the email, returns a short-lived download ticket
//   GET  /file/:ticket                       -> streams the installer from the private R2 bucket
//   GET  /stats   (Authorization: Bearer STATS_KEY) -> user and download counts
//   GET  /auth/:provider?platform&notify&consent=1   -> Google / GitHub sign-in (instead of the email step)
//   GET  /auth/:provider/callback                     -> takes the verified email, then the normal download link
//
// Stored: email, platform, notify choice, sign-in method, timestamps, hashed tokens, download rows. Nothing else.
// From Google/GitHub we read only the verified email address and discard their access token immediately.

const PLATFORMS = { win: 'Windows', mac: 'macOS', linux: 'Linux' };
const LINK_TTL = 30 * 60 * 1000;
const FILE_TTL = 15 * 60 * 1000;
const COOLDOWN = 2 * 60 * 1000;
const MAX_SENDS_PER_DAY = 5;
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
      : {};
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });

    if (req.method === 'OPTIONS') return new Response(null, { status: allowed.includes(origin) ? 204 : 403, headers: cors });

    try {
      if (url.pathname === '/signup' || url.pathname === '/redeem') {
        if (req.method !== 'POST') return json({ error: 'method' }, 405);
        if (!allowed.includes(origin)) return json({ error: 'origin' }, 403);
        if (!(await underLimit(env, req))) return json({ error: 'busy', message: 'Too many requests. Try again in a minute.' }, 429);
        const body = await req.json().catch(() => ({}));
        return url.pathname === '/signup' ? await signup(env, ctx, body, json) : await redeem(env, body, json);
      }
      const auth = /^\/auth\/(google|github)(\/callback)?$/.exec(url.pathname);
      if (auth && req.method === 'GET') return auth[2] ? await oauthCallback(env, auth[1], url) : await oauthStart(env, req, auth[1], url);
      if (url.pathname.startsWith('/file/') && req.method === 'GET') return await file(env, url.pathname.slice(6), url.searchParams.get('v'));
      if (url.pathname === '/stats' && req.method === 'GET') return await stats(env, req);
      if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'panurgos-api' });
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      console.error('Unhandled', e && e.stack || e);
      return json({ error: 'server', message: 'Something went wrong. Please try again.' }, 500);
    }
  },

  async scheduled(_event, env) {
    const now = Date.now();
    // Retention promised on panurgos.com/privacy: two years after the last download (or sign-up, if none).
    const cutoff = now - 730 * 24 * 3600 * 1000;
    const stale = `SELECT u.id FROM users u WHERE COALESCE((SELECT MAX(d.at) FROM downloads d WHERE d.user_id = u.id), u.created_at) < ?`;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM tokens WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(now),
      env.DB.prepare(`DELETE FROM tokens WHERE user_id IN (${stale})`).bind(cutoff),
      env.DB.prepare(`DELETE FROM downloads WHERE user_id IN (${stale})`).bind(cutoff),
      env.DB.prepare(`DELETE FROM users WHERE id IN (${stale})`).bind(cutoff)
    ]);
  }
};

// ---------------------------------------------------------------- handlers

async function signup(env, ctx, body, json) {
  const email = String(body.email || '').trim().toLowerCase();
  const platform = String(body.platform || '');
  const notify = body.notify ? 1 : 0;
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: 'email', message: 'Enter a valid email address.' }, 400);
  if (!PLATFORMS[platform]) return json({ error: 'platform', message: 'Choose Windows, macOS or Linux.' }, 400);
  if (body.consent !== true) return json({ error: 'consent', message: 'Please agree to the privacy terms to continue.' }, 400);

  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO users (email, platform, notify_opt_in, created_at, via) VALUES (?, ?, ?, ?, 'email')
     ON CONFLICT(email) DO UPDATE SET platform = excluded.platform, notify_opt_in = MAX(users.notify_opt_in, excluded.notify_opt_in), via = 'email'`
  ).bind(email, platform, notify, now).run();
  const user = await env.DB.prepare('SELECT id, last_sent_at, sends_day, sends_today FROM users WHERE email = ?').bind(email).first();

  // Same answer whether or not we actually send, so the endpoint can't be used to probe or spam an inbox.
  const accepted = json({ ok: true, message: 'Check your inbox for a download link. It works once, for 30 minutes.' });
  const sentToday = user.sends_day === today ? user.sends_today : 0;
  if ((user.last_sent_at && now - user.last_sent_at < COOLDOWN) || sentToday >= MAX_SENDS_PER_DAY) return accepted;

  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO tokens (hash, user_id, kind, platform, expires_at, uses_left) VALUES (?, ?, ?, ?, ?, 1)').bind(await sha256(token), user.id, 'link', platform, now + LINK_TTL),
    env.DB.prepare('UPDATE users SET last_sent_at = ?, sends_day = ?, sends_today = ? WHERE id = ?').bind(now, today, sentToday + 1, user.id)
  ]);
  const link = `${env.SITE_URL}/download/?t=${token}`;
  const available = !!installers(env)[platform];
  ctx.waitUntil(sendEmail(env, email, platform, link, available).catch((e) => console.error('Email failed', e && e.message)));
  return accepted;
}

async function redeem(env, body, json) {
  const token = String(body.token || '');
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return json({ error: 'token', message: 'This link is not valid.' }, 400);
  const now = Date.now();
  const hash = await sha256(token);
  // Atomically consume the link: only one request can win.
  const row = await env.DB.prepare(
    `UPDATE tokens SET uses_left = uses_left - 1 WHERE hash = ? AND kind = 'link' AND uses_left > 0 AND expires_at > ? RETURNING user_id, platform`
  ).bind(hash, now).first();
  if (!row) return json({ error: 'expired', message: 'This link has expired or was already used. Request a new one.' }, 410);

  await env.DB.prepare('UPDATE users SET verified_at = COALESCE(verified_at, ?) WHERE id = ?').bind(now, row.user_id).run();
  const inst = installers(env)[row.platform];
  if (!inst) return json({ ok: true, available: false, platform: row.platform, platformName: PLATFORMS[row.platform] });

  const ticket = randomToken();
  await env.DB.prepare('INSERT INTO tokens (hash, user_id, kind, platform, expires_at, uses_left) VALUES (?, ?, ?, ?, ?, 4)')
    .bind(await sha256(ticket), row.user_id, 'file', row.platform, now + FILE_TTL).run();
  const variants = variantsOf(inst).map(({ id, label, file, hint }) => ({ id, label, file, hint }));
  return json({ ok: true, available: true, platform: row.platform, platformName: PLATFORMS[row.platform], version: inst.version, file: variants[0].file, variants, ticket });
}

// An installer entry is either one file ({key, file, version}) or several ({version, variants: {id: {key, file, label, hint}}}),
// e.g. Apple Silicon / Intel on macOS, AppImage / .deb on Linux.
function variantsOf(inst) {
  if (!inst.variants) return [{ id: 'default', label: null, key: inst.key, file: inst.file }];
  return Object.entries(inst.variants).map(([id, v]) => ({ id, label: v.label || id, key: v.key, file: v.file, hint: v.hint || '' }));
}

async function file(env, ticket, variant) {
  const plain = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(ticket)) return plain(400, 'Invalid download link.');
  const now = Date.now();
  const row = await env.DB.prepare(
    `UPDATE tokens SET uses_left = uses_left - 1 WHERE hash = ? AND kind = 'file' AND uses_left > 0 AND expires_at > ? RETURNING user_id, platform, uses_left`
  ).bind(await sha256(ticket), now).first();
  if (!row) return plain(410, 'This download link has expired. Go back to panurgos.com and request a new one.');
  const inst = installers(env)[row.platform];
  const all = inst ? variantsOf(inst) : [];
  const pick = all.find((v) => v.id === variant) || all[0];
  const obj = pick && await env.INSTALLERS_BUCKET.get(pick.key);
  if (!obj) return plain(503, 'The installer is not available right now. Please try again later.');
  // Count one download per ticket (the first fetch), not retries.
  if (row.uses_left === 3) {
    const version = pick.id === 'default' ? inst.version : `${inst.version}/${pick.id}`;
    await env.DB.prepare('INSERT INTO downloads (user_id, platform, version, at) VALUES (?, ?, ?, ?)').bind(row.user_id, row.platform, version, now).run();
  }
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Content-Disposition': `attachment; filename="${pick.file}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

async function stats(env, req) {
  const auth = req.headers.get('Authorization') || '';
  if (!env.STATS_KEY || !timingSafeEqual(auth, `Bearer ${env.STATS_KEY}`)) return new Response('Unauthorized', { status: 401 });
  const one = (sql) => env.DB.prepare(sql).first();
  const all = (sql) => env.DB.prepare(sql).all().then((r) => r.results);
  const body = {
    users: (await one('SELECT COUNT(*) AS n FROM users')).n,
    verified: (await one('SELECT COUNT(*) AS n FROM users WHERE verified_at IS NOT NULL')).n,
    downloads: (await one('SELECT COUNT(*) AS n FROM downloads')).n,
    byPlatform: await all('SELECT platform, COUNT(*) AS signups, SUM(verified_at IS NOT NULL) AS verified, SUM(notify_opt_in) AS notify FROM users GROUP BY platform'),
    bySignIn: await all("SELECT COALESCE(via, 'email') AS via, COUNT(*) AS users FROM users GROUP BY 1"),
    downloadsByDay: await all("SELECT date(at / 1000, 'unixepoch') AS day, platform, COUNT(*) AS n FROM downloads GROUP BY day, platform ORDER BY day DESC LIMIT 90")
  };
  return new Response(JSON.stringify(body, null, 2), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

// ---------------------------------------------------------------- Google / GitHub sign-in

const OAUTH = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email',
    id: (env) => env.GOOGLE_CLIENT_ID, secret: (env) => env.GOOGLE_CLIENT_SECRET,
    extra: { prompt: 'select_account', access_type: 'online' },
    async email(env, code, redirectUri) {
      const tok = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' })
      }).then((r) => r.json());
      if (!tok.access_token) return null;
      const me = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
      return me.email && me.email_verified === true ? me.email : null;
    }
  },
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    scope: 'user:email',
    id: (env) => env.GITHUB_CLIENT_ID, secret: (env) => env.GITHUB_CLIENT_SECRET,
    extra: { allow_signup: 'true' },
    async email(env, code, redirectUri) {
      const tok = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri })
      }).then((r) => r.json());
      if (!tok.access_token) return null;
      const list = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'panurgos-api' }
      }).then((r) => r.json());
      if (!Array.isArray(list)) return null;
      const pick = list.find((e) => e.primary && e.verified) || list.find((e) => e.verified && !/noreply\.github\.com$/i.test(e.email));
      return pick ? pick.email : null;
    }
  }
};

const back = (env, query) => Response.redirect(`${env.SITE_URL}/download/?${query}`, 302);

async function oauthStart(env, req, provider, url) {
  const p = OAUTH[provider];
  if (!p.id(env) || !p.secret(env)) return back(env, 'e=unavailable');
  if (!(await underLimit(env, req))) return back(env, 'e=busy');
  const platform = url.searchParams.get('platform');
  if (!PLATFORMS[platform] || url.searchParams.get('consent') !== '1') return Response.redirect(`${env.SITE_URL}/#download`, 302);
  const state = randomToken();
  await env.DB.prepare('INSERT INTO oauth_states (hash, provider, platform, notify, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(state), provider, platform, url.searchParams.get('notify') === '1' ? 1 : 0, Date.now() + 10 * 60 * 1000).run();
  const q = new URLSearchParams({ client_id: p.id(env), redirect_uri: `${env.API_URL}/auth/${provider}/callback`, scope: p.scope, state, response_type: 'code', ...p.extra });
  return Response.redirect(`${p.authorize}?${q}`, 302);
}

async function oauthCallback(env, provider, url) {
  const p = OAUTH[provider];
  if (url.searchParams.get('error')) return back(env, 'e=denied');
  const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(state) || !code) return back(env, 'e=failed');
  const now = Date.now();
  const st = await env.DB.prepare('DELETE FROM oauth_states WHERE hash = ? AND provider = ? AND expires_at > ? RETURNING platform, notify')
    .bind(await sha256(state), provider, now).first();
  if (!st) return back(env, 'e=expired');

  let email = null;
  try { email = await p.email(env, code, `${env.API_URL}/auth/${provider}/callback`); } catch (e) { console.error('OAuth exchange failed', provider, e && e.message); }
  if (!email) return back(env, 'e=noemail');
  email = email.trim().toLowerCase();

  await env.DB.prepare(
    `INSERT INTO users (email, platform, notify_opt_in, created_at, verified_at, via) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET platform = excluded.platform, notify_opt_in = MAX(users.notify_opt_in, excluded.notify_opt_in),
       verified_at = COALESCE(users.verified_at, excluded.verified_at), via = excluded.via`
  ).bind(email, st.platform, st.notify, now, now, provider).run();
  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  // Hand over to the normal flow: a single-use link the download page redeems straight away.
  const token = randomToken();
  await env.DB.prepare('INSERT INTO tokens (hash, user_id, kind, platform, expires_at, uses_left) VALUES (?, ?, ?, ?, ?, 1)')
    .bind(await sha256(token), user.id, 'link', st.platform, now + 5 * 60 * 1000).run();
  return back(env, `t=${token}`);
}

// ---------------------------------------------------------------- email

async function sendEmail(env, to, platform, link, available) {
  const name = PLATFORMS[platform];
  const subject = available ? 'Your PanUrgos Studio download' : `PanUrgos for ${name}: you're verified`;
  const lead = available
    ? `Here is your download link for PanUrgos Studio for ${name}. It works once and expires in 30 minutes.`
    : `Confirm your email and we'll record your interest. PanUrgos Studio for ${name} isn't out yet; if you asked to be told, we'll email you once when it is.`;
  const button = available ? 'Download PanUrgos Studio' : 'Confirm my email';
  const text = `${lead}\n\n${link}\n\nIf you didn't ask for this, ignore this email and nothing will happen.\n\nPanUrgos · panurgos.com`;
  const html = `<!doctype html><html><body style="margin:0;background:#050506;padding:40px 16px;font-family:Segoe UI,-apple-system,Helvetica,Arial,sans-serif;color:#ece6da">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="520" cellspacing="0" cellpadding="0" style="max-width:520px;width:100%;background:#0b0a09;border:1px solid #2a211b">
<tr><td style="padding:36px 36px 8px;font:600 12px/1 Consolas,Menlo,monospace;letter-spacing:4px;color:#ff6a2b">PANURGOS</td></tr>
<tr><td style="padding:16px 36px 0;font:400 30px/1.15 Palatino Linotype,Palatino,Georgia,serif;color:#ece6da">${available ? 'Your download is ready.' : 'One step left.'}</td></tr>
<tr><td style="padding:16px 36px 0;font-size:15px;line-height:1.6;color:#a7a197">${escapeHtml(lead)}</td></tr>
<tr><td style="padding:28px 36px"><a href="${link}" style="display:inline-block;background:#ff6a2b;color:#120604;text-decoration:none;font:600 13px/1 Consolas,Menlo,monospace;letter-spacing:2px;text-transform:uppercase;padding:16px 24px">${button}</a></td></tr>
<tr><td style="padding:0 36px 32px;font-size:12px;line-height:1.6;color:#6c675f">If the button doesn't work, paste this into your browser:<br><span style="color:#a7a197;word-break:break-all">${link}</span><br><br>If you didn't ask for this, ignore this email and nothing will happen.</td></tr>
</table></td></tr></table></body></html>`;

  if (env.DEV_LOG_EMAILS) { console.log(`[dev email] to=${to} subject="${subject}" link=${link}`); return; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject, html, text })
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// ---------------------------------------------------------------- helpers

function installers(env) { try { return JSON.parse(env.INSTALLERS || '{}'); } catch { return {}; } }

async function underLimit(env, req) {
  if (!env.LIMITER) return true;
  const key = req.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.LIMITER.limit({ key });
  return success;
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
