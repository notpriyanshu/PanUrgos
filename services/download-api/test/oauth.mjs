// Checks the Google/GitHub sign-in routes against `wrangler dev --env dev` with placeholder client IDs.
// (The real token exchange needs real OAuth apps and is tested live.)
const API = 'http://127.0.0.1:8787';
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) failures++; };
const go = (path) => fetch(API + path, { redirect: 'manual' });

for (const [provider, host] of [['google', 'accounts.google.com'], ['github', 'github.com']]) {
  const r = await go(`/auth/${provider}?platform=win&notify=1&consent=1`);
  const loc = new URL(r.headers.get('location') || 'http://x/');
  check(`${provider}: start redirects to ${host}`, r.status === 302 && loc.host === host, `${r.status} ${loc.host}`);
  check(`${provider}: asks only for email`, loc.searchParams.get('scope') === (provider === 'google' ? 'openid email' : 'user:email'));
  check(`${provider}: callback URL is ours`, loc.searchParams.get('redirect_uri') === `${API}/auth/${provider}/callback`);
  const state = loc.searchParams.get('state');
  check(`${provider}: has a state value`, /^[A-Za-z0-9_-]{43}$/.test(state || ''));

  const noConsent = await go(`/auth/${provider}?platform=win`);
  check(`${provider}: no consent -> back to site`, noConsent.status === 302 && /#download$/.test(noConsent.headers.get('location')));

  const denied = await go(`/auth/${provider}/callback?error=access_denied&state=${state}`);
  check(`${provider}: user cancels -> e=denied`, /e=denied/.test(denied.headers.get('location')));

  const forged = await go(`/auth/${provider}/callback?code=abc&state=${'Z'.repeat(43)}`);
  check(`${provider}: forged state -> e=expired`, /e=expired/.test(forged.headers.get('location')));

  // Real state + fake code: the exchange fails (placeholder app), and the state can't be replayed.
  const bad = await go(`/auth/${provider}/callback?code=fake&state=${state}`);
  check(`${provider}: bad code -> e=noemail`, /e=noemail/.test(bad.headers.get('location')), bad.headers.get('location'));
  const replay = await go(`/auth/${provider}/callback?code=fake&state=${state}`);
  check(`${provider}: state is single use`, /e=expired/.test(replay.headers.get('location')));
}
const odd = await go('/auth/facebook?platform=win&consent=1');
check('unknown provider -> 404', odd.status === 404);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
