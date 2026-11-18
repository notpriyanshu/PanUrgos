// Enterprise call booking, against `wrangler dev --env dev`. Usage: node test/booking.mjs <dev-log-file>
import { readFileSync } from 'node:fs';
const API = 'http://127.0.0.1:8787', ORIGIN = 'http://127.0.0.1:4173';
const logFile = process.argv[2];
let failures = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!c) failures++; };
const book = (body, origin = ORIGIN) => fetch(API + '/book', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
const base = { name: 'Ada Tester', email: `ada+${Date.now()}@example.test`, company: 'Test Co', size: '51-250', topic: 'reports', tz: 'Europe/London', consent: true };

const s1 = await (await fetch(API + '/slots', { headers: { Origin: ORIGIN } })).json();
check('slots listed', Array.isArray(s1.slots) && s1.slots.length > 20, `${s1.slots?.length} open, ${s1.slotMinutes} min, host ${s1.hostTimezone}`);
const slot = s1.slots.at(-1);
check('slots are on the half hour in IST', s1.slots.every((s) => { const d = new Date(Date.parse(s) + 330 * 60000); return d.getUTCMinutes() % 30 === 0 && d.getUTCHours() >= 10 && d.getUTCHours() < 18 && d.getUTCDay() >= 1 && d.getUTCDay() <= 5; }));

check('rejects other origins', (await book({ ...base, slot }, 'https://evil.test')).status === 403);
check('requires consent', (await book({ ...base, slot, consent: false })).status === 400);
check('rejects a made-up time', (await book({ ...base, slot: '2026-11-21T03:17:00.000Z' })).status === 409);
const ok = await book({ ...base, slot });
const okBody = await ok.json();
check('books an open slot', ok.status === 200 && okBody.ok && okBody.start === slot, JSON.stringify(okBody));
const dup = await book({ ...base, email: `other+${Date.now()}@example.test`, slot });
check('same slot cannot be booked twice', dup.status === 409, String(dup.status));
const s2 = await (await fetch(API + '/slots')).json();
check('booked slot no longer offered', !s2.slots.includes(slot));
await new Promise((r) => setTimeout(r, 800));
check('confirmation email produced', readFileSync(logFile, 'utf8').includes(`to=${base.email} subject="Booked: PanUrgos call`));
check('bookings list needs the key', (await fetch(API + '/bookings')).status === 401);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
