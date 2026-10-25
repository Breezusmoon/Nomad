/* NOMAD Pro — payments Worker (Cloudflare Workers, free plan). No database: Stripe is the source of truth.
 *
 * Secrets / variables to set in Cloudflare (Settings → Variables and Secrets):
 *   STRIPE_SECRET    (secret)  Stripe secret key, sk_live_… (sk_test_… while testing)
 *   SIGNING_SECRET   (secret)  any long random string (40+ characters) — signs Pro tokens
 *   PRICE_MONTHLY    (text)    Stripe Price ID for A$4.99/month, price_…
 *   PRICE_YEARLY     (text)    Stripe Price ID for A$39/year, price_…
 *   APP_URL          (text)    https://breezusmoon.github.io/Nomad/
 *
 * Endpoints (all JSON):
 *   POST /checkout {plan:'monthly'|'yearly'}  → {url}       Stripe Checkout page
 *   GET  /verify?sid=cs_…                     → {token,…}   after Stripe sends the buyer back
 *   POST /refresh {token}                     → {token,…}   renewals / cancellations
 *   POST /restore {key:'XXXX-XXXX-XXXX'}      → {token,…}   new phone
 *   POST /portal  {token}                     → {url}       manage / cancel subscription
 */
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GRACE = 3 * 86400 * 1000;          // keep Pro 3 days past period end while Stripe retries a card
const OK_STATUS = ['active', 'trialing', 'past_due'];

export default {
  async fetch(req, env) {
    const origin = new URL(env.APP_URL).origin;
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    try {
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      switch (url.pathname) {
        case '/checkout': return json(await checkout(env, body.plan));
        case '/verify': return json(await verify(env, url.searchParams.get('sid') || ''));
        case '/refresh': return json(await refresh(env, body.token || ''));
        case '/restore': return json(await restore(env, body.key || ''));
        case '/portal': return json(await portal(env, body.token || ''));
        case '/': return json({ ok: true, service: 'nomad-pro' });
        default: return json({ error: 'not_found' }, 404);
      }
    } catch (e) {
      const code = e.status || 500;
      return json({ error: e.message || 'error' }, code);
    }
  }
};

/* ── Stripe helpers ── */
async function stripe(env, method, path, params) {
  const opt = { method, headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET } };
  let u = 'https://api.stripe.com/v1' + path;
  if (params) {
    const qs = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.append(k, String(v));
    if (method === 'GET') u += (u.includes('?') ? '&' : '?') + qs; else { opt.body = qs; opt.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  }
  const r = await fetch(u, opt); const j = await r.json();
  if (!r.ok) throw httpErr(502, (j.error && j.error.message) || 'stripe_error');
  return j;
}
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const periodEnd = sub => (sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end) || 0) * 1000;
const planOf = (env, sub) => { const p = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id; return p === env.PRICE_YEARLY ? 'yearly' : 'monthly'; };
const restoreCode = () => { const b = crypto.getRandomValues(new Uint8Array(12)); let s = ''; b.forEach((x, i) => { s += ALPHA[x % ALPHA.length]; if (i === 3 || i === 7) s += '-'; }); return s; };

/* ── Tokens: base64url(payload).base64url(HMAC-SHA256) ── */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const hmacKey = env => crypto.subtle.importKey('raw', new TextEncoder().encode(env.SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
async function sign(env, payload) {
  const p = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const s = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(p));
  return p + '.' + b64u(s);
}
async function unsign(env, token) {
  const [p, s] = String(token).split('.'); if (!p || !s) throw httpErr(401, 'bad_token');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(s), new TextEncoder().encode(p));
  if (!ok) throw httpErr(401, 'bad_token');
  return JSON.parse(new TextDecoder().decode(unb64u(p)));
}
async function issue(env, sub, key) {
  const active = OK_STATUS.includes(sub.status);
  const until = active ? periodEnd(sub) + GRACE : 0;
  const payload = { s: sub.id, c: typeof sub.customer === 'string' ? sub.customer : sub.customer.id, p: planOf(env, sub), u: until, k: key || (sub.metadata && sub.metadata.restore) || '' };
  return { active: active && until > Date.now(), until, plan: payload.p, key: payload.k, cancelAtPeriodEnd: !!sub.cancel_at_period_end, token: await sign(env, payload) };
}

/* ── Endpoints ── */
async function checkout(env, plan) {
  const price = plan === 'yearly' ? env.PRICE_YEARLY : plan === 'monthly' ? env.PRICE_MONTHLY : '';
  if (!price) throw httpErr(400, 'unknown_plan');
  const s = await stripe(env, 'POST', '/checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': price, 'line_items[0][quantity]': 1,
    success_url: env.APP_URL + '?pro=ok&sid={CHECKOUT_SESSION_ID}',
    cancel_url: env.APP_URL + '?pro=cancel',
    allow_promotion_codes: 'true',
    'subscription_data[metadata][restore]': restoreCode(),
    'subscription_data[metadata][app]': 'nomad'
  });
  return { url: s.url };
}
async function verify(env, sid) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) throw httpErr(400, 'bad_session');
  const s = await stripe(env, 'GET', '/checkout/sessions/' + sid, { 'expand[]': 'subscription' });
  if (s.status !== 'complete' || !s.subscription) throw httpErr(402, 'not_paid');
  return issue(env, s.subscription);
}
async function refresh(env, token) {
  const t = await unsign(env, token);
  const sub = await stripe(env, 'GET', '/subscriptions/' + t.s);
  return issue(env, sub, t.k);
}
async function restore(env, key) {
  key = String(key).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (key.length !== 12) throw httpErr(400, 'bad_key');
  key = key.slice(0, 4) + '-' + key.slice(4, 8) + '-' + key.slice(8);
  const r = await stripe(env, 'GET', '/subscriptions/search', { query: `metadata['restore']:'${key}'`, limit: 5 });
  const sub = (r.data || []).sort((a, b) => (OK_STATUS.includes(b.status) - OK_STATUS.includes(a.status)) || b.created - a.created)[0];
  if (!sub) throw httpErr(404, 'key_not_found');
  return issue(env, sub, key);
}
async function portal(env, token) {
  const t = await unsign(env, token);
  const p = await stripe(env, 'POST', '/billing_portal/sessions', { customer: t.c, return_url: env.APP_URL + '?pro=manage' });
  return { url: p.url };
}
