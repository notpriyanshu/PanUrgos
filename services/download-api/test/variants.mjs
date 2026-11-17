// macOS / Linux downloads with several files (Apple Silicon / Intel, AppImage / .deb), against `wrangler dev --env dev`.
// Usage: node test/variants.mjs <dev-log-file>
import { readFileSync } from 'node:fs';

const API = 'http://127.0.0.1:8787';
const ORIGIN = 'http://127.0.0.1:4173';
const logFile = process.argv[2];
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) failures++; };
const post = (path, body) => fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const linkFor = (email) => {
  const line = readFileSync(logFile, 'utf8').split(/\r?\n/).filter((l) => l.includes(`to=${email}`)).at(-1) || '';
  const m = /link=(\S+)/.exec(line);
  return m && new URL(m[1]).searchParams.get('t');
};

for (const [platform, ids, names] of [
  ['mac', ['arm64', 'x64'], [/mac-arm64\.dmg/, /mac-x64\.dmg/]],
  ['linux', ['appimage', 'deb'], [/x86_64\.AppImage/, /amd64\.deb/]]
]) {
  const email = `${platform}+${Date.now()}@example.test`;
  await post('/signup', { email, platform, consent: true });
  await wait(800);
  const r = await (await post('/redeem', { token: linkFor(email) })).json();
  check(`${platform}: available with ${ids.length} choices`, r.available === true && Array.isArray(r.variants) && r.variants.map((v) => v.id).join() === ids.join(), JSON.stringify(r.variants?.map((v) => v.id)));
  check(`${platform}: choices have labels and hints`, r.variants?.every((v) => v.label && v.hint));
  for (const [i, id] of ids.entries()) {
    const f = await fetch(`${API}/file/${r.ticket}?v=${id}`);
    await f.arrayBuffer();
    check(`${platform}/${id}: downloads the right file`, f.status === 200 && names[i].test(f.headers.get('content-disposition') || ''), `${f.status} ${f.headers.get('content-disposition')}`);
  }
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
