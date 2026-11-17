// End-to-end test against `wrangler dev --env dev` (emails are logged, not sent).
// Usage: node test/e2e.mjs <dev-log-file>
import { readFileSync } from 'node:fs';

const API = 'http://127.0.0.1:8787';
const ORIGIN = 'http://127.0.0.1:4173';
const logFile = process.argv[2];
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) failures++; };
const post = (path, body, origin = ORIGIN) => fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
const lastLink = (email) => {
  const lines = readFileSync(logFile, 'utf8').split(/\r?\n/).filter((l) => l.includes('[dev email]') && l.includes(`to=${email}`));
  const m = /link=(\S+)/.exec(lines.at(-1) || '');
  return m && new URL(m[1]).searchParams.get('t');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const email = `tester+${Date.now()}@example.test`;

// Guards
check('rejects other origins', (await post('/signup', { email, platform: 'win', consent: true }, 'https://evil.test')).status === 403);
check('rejects bad email', (await post('/signup', { email: 'nope', platform: 'win', consent: true })).status === 400);
check('rejects bad platform', (await post('/signup', { email, platform: 'amiga', consent: true })).status === 400);
check('requires consent', (await post('/signup', { email, platform: 'win' })).status === 400);
const pre = await fetch(API + '/signup', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
check('CORS preflight allowed for site', pre.status === 204 && pre.headers.get('access-control-allow-origin') === ORIGIN);

// Signup -> email link
const s1 = await post('/signup', { email, platform: 'win', notify: true, consent: true });
check('signup accepted', s1.status === 200, String(s1.status));
await wait(800);
const token = lastLink(email);
check('email with link was produced', !!token);

// Cooldown: a second request within 2 minutes is accepted but sends nothing new
await post('/signup', { email, platform: 'win', consent: true });
await wait(800);
check('cooldown: no second email', lastLink(email) === token);

// Redeem
const r1 = await (await post('/redeem', { token })).json();
check('redeem gives a download ticket', r1.ok && r1.available && !!r1.ticket, JSON.stringify({ ok: r1.ok, available: r1.available }));
const r2 = await post('/redeem', { token });
check('link is single use', r2.status === 410);

// File download
const f1 = await fetch(`${API}/file/${r1.ticket}`);
const bytes = new Uint8Array(await f1.arrayBuffer());
check('file streams', f1.status === 200 && bytes.length === 200, `${f1.status} ${bytes.length}B`);
check('file has download filename', /PanUrgos-Studio-Setup-1\.0\.0\.exe/.test(f1.headers.get('content-disposition') || ''));
check('bogus ticket refused', (await fetch(`${API}/file/${'x'.repeat(43)}`)).status === 410);

// Platform without a build: verified, but nothing to download
const macEmail = `mac+${Date.now()}@example.test`;
await post('/signup', { email: macEmail, platform: 'mac', notify: true, consent: true });
await wait(800);
const r3 = await (await post('/redeem', { token: lastLink(macEmail) })).json();
check('macOS: verified, marked coming soon', r3.ok && r3.available === false && r3.platform === 'mac');

// Stats are protected
check('stats need the key', (await fetch(`${API}/stats`)).status === 401);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
