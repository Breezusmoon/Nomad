/* NOMAD Pro — payments Worker (Cloudflare Workers, free plan). No database: Stripe is the source of truth.
 *
 * Secrets / variables to set in Cloudflare (Settings → Variables and Secrets):
 *   STRIPE_SECRET    (secret)  Stripe secret key, sk_live_… (sk_test_… while testing)
 *   SIGNING_SECRET   (secret)  any long random string (40+ characters) — signs Pro tokens
 *   PRICE_MONTHLY    (text)    Stripe Price ID for A$4.99/month, price_…
 *   PRICE_YEARLY     (text)    Stripe Price ID for A$39/year, price_…
 *   APP_URL          (text)    https://breezusmoon.github.io/Nomad/
 *   QLD_FUEL_TOKEN   (secret)  optional — QLD Fuel Price Reporting subscriber token  → live QLD prices
 *   NSW_FUEL_KEY / NSW_FUEL_SECRET (secret) optional — api.nsw.gov.au Fuel API          → live NSW, ACT, TAS prices
 *   SA_FUEL_TOKEN    (secret)  optional — SA Fuel Pricing Information token          → live SA prices
 *   GH_TOKEN         (secret)  optional — GitHub fine-grained token (repo Nomad, Actions: read & write).
 *                              With a Cron Trigger of  "every 15 minutes" (cron 0/15 * * * * — see setup steps)  this refreshes fuel prices every 15 minutes.
 *
 * Endpoints (all JSON):
 *   POST /checkout {plan:'monthly'|'yearly'}  → {url}       Stripe Checkout page
 *   GET  /verify?sid=cs_…                     → {token,…}   after Stripe sends the buyer back
 *   POST /refresh {token}                     → {token,…}   renewals / cancellations
 *   POST /restore {key:'XXXX-XXXX-XXXX'}      → {token,…}   new phone
 *   POST /portal  {token}                     → {url}       manage / cancel subscription
 *   GET  /fuel?lat=&lng=                      → {v,s:[…]}   live government servo prices within ~150 km (refreshed every 2 min)
 */
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GRACE = 3 * 86400 * 1000;          // keep Pro 3 days past period end while Stripe retries a card
const OK_STATUS = ['active', 'trialing', 'past_due'];

export default {
  // Cron Trigger: kick the fuel-price job on GitHub (GitHub's own schedule only runs every few hours)
  async scheduled(event, env, ctx) {
    if (!env.GH_TOKEN) return;
    ctx.waitUntil(fetch('https://api.github.com/repos/Breezusmoon/Nomad/actions/workflows/fuel.yml/dispatches', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'nomad-pro', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' })
    }));
  },
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
        case '/fuel': return fuelHandler(env, url, cors);
        case '/': return json({ ok: true, service: 'nomad-pro', fuel: fuelStates(env) });
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


/* ── Live fuel: government feeds, cached at the edge for 2 minutes, filtered to the user's area ── */
const FUEL_TTL = 120, SITE_TTL = 86400;
const FEEDS = {
  QLD: { need: e => e.QLD_FUEL_TOKEN, box: [-29.3, -9, 137.9, 154], build: e => fpdState(e.QLD_FUEL_TOKEN, 'https://fppdirectapi-prod.fuelpricesqld.com.au', 1, 'QLD') },
  SA:  { need: e => e.SA_FUEL_TOKEN,  box: [-38.2, -25.9, 129, 141.1], build: e => fpdState(e.SA_FUEL_TOKEN, 'https://fppdirectapi-prod.safuelpricinginformation.com.au', 4, 'SA') },
  // NSW free plan = 2,500 calls/month, so NSW refreshes every 90 min and TAS every 6 h (QLD/SA every 2 min)
  NSW: { ttl: 5400, need: e => e.NSW_FUEL_KEY && e.NSW_FUEL_SECRET, box: [-37.6, -28.1, 140.9, 153.7], build: e => nswState(e, '') },
  TAS: { ttl: 21600, need: e => e.NSW_FUEL_KEY && e.NSW_FUEL_SECRET, box: [-43.8, -39.4, 143.5, 148.6], build: e => nswState(e, '?states=TAS') }
};
const fuelStates = env => Object.keys(FEEDS).filter(k => FEEDS[k].need(env));
async function fuelHandler(env, url, cors) {
  const lat = +url.searchParams.get('lat'), lng = +url.searchParams.get('lng');
  const hdr = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' };
  if (!(lat < -9 && lat > -45 && lng > 112 && lng < 155)) return new Response(JSON.stringify({ error: 'bad_location' }), { status: 400, headers: hdr });
  const pad = 1.6, want = fuelStates(env).filter(k => { const b = FEEDS[k].box; return lat > b[0] - pad && lat < b[1] + pad && lng > b[2] - pad && lng < b[3] + pad; });
  const out = [], states = {};
  await Promise.all(want.map(async k => {
    try {
      const rows = await edgeCached('fuel/' + k, FEEDS[k].ttl || FUEL_TTL, () => FEEDS[k].build(env));
      states[k] = rows.length;
      for (const r of rows) if (Math.abs(r[0] - lat) < 1.4 && Math.abs(r[1] - lng) < 1.6) out.push(r);
    } catch (e) { states[k] = 'error: ' + String(e.message || e).slice(0, 80); }
  }));
  return new Response(JSON.stringify({ v: Math.floor(Date.now() / 1000), states, s: out }), { headers: hdr });
}
// Cache API at this edge location (free); one upstream call per location per TTL
async function edgeCached(name, ttl, make) {
  const key = new Request('https://nomad-cache.internal/' + name), c = caches.default;
  const hit = await c.match(key);
  if (hit) return hit.json();
  const data = await make();
  await c.put(key, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + ttl } }));
  return data;
}
async function getJ(u, headers) {
  const r = await fetch(u, { headers: { 'User-Agent': 'NOMAD-fuel/1.0', Accept: 'application/json', ...headers } });
  if (!r.ok) throw new Error('upstream ' + r.status + ' ' + new URL(u).pathname.split('/').slice(-2).join('/'));
  return r.json();
}
function fGrade(name) {
  const n = String(name).toLowerCase().replace(/ /g, '');
  if (/premiumdiesel|pdl|pdsl|branddiesel|ultimatediesel|vortexdiesel/.test(n)) return 'PDSL';
  if (/diesel|^dl$|^dsl$/.test(n)) return 'DSL';
  if (/e10/.test(n)) return 'E10';
  if (/e85/.test(n)) return 'E85';
  if (/lpg|autogas/.test(n)) return 'LPG';
  if (/98/.test(n)) return 'P98';
  if (/95|pulp|premiumunleaded/.test(n)) return 'P95';
  if (/91|ulp|unleaded|petrol/.test(n)) return 'U91';
  return null;
}
function fDollars(v) {
  v = parseFloat(v); if (!(v > 0) || v >= 9999) return null;
  if (v > 1000) v /= 1000; else if (v > 20) v /= 100;
  return v > 1.2 && v < 6 ? Math.round(v * 1000) / 1000 : null;
}
function fEpoch(s) {
  if (!s) return 0; s = String(s);
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  const t = m ? Date.UTC(+m[3], m[2] - 1, +m[1], +m[4], +m[5], +m[6]) : Date.parse(s.endsWith('Z') ? s : s + 'Z');
  return t ? Math.floor(t / 1000) : 0;
}
// NSW FuelCheck times are Sydney local time, not UTC
function sydToEpoch(s) {
  const naive = fEpoch(s) * 1000; if (!naive) return 0;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(naive)).map(p => [p.type, p.value]));
  const off = Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - naive;
  return Math.floor((naive - off) / 1000);
}
function fRow(lat, lng, name, brand, prices, ts, st) {
  lat = +lat; lng = +lng;
  if (!(lat > -44.5 && lat < -9 && lng > 112 && lng < 154.5) || !Object.keys(prices).length) return null;
  return [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5, String(name || '').slice(0, 60), String(brand || '').slice(0, 30), prices, ts || Math.floor(Date.now() / 1000), st];
}
async function fpdState(token, base, region, st) {
  const H = { Authorization: 'FPDAPI SubscriberToken=' + token, 'Content-Type': 'application/json' };
  const q = 'countryId=21&geoRegionLevel=3&geoRegionId=' + region;
  const meta = await edgeCached('fuelmeta/' + st, SITE_TTL, async () => {
    const [f, b, s] = await Promise.all([getJ(base + '/Subscriber/GetCountryFuelTypes?countryId=21', H), getJ(base + '/Subscriber/GetCountryBrands?countryId=21', H), getJ(base + '/Subscriber/GetFullSiteDetails?' + q, H)]);
    const fuels = {}, brands = {}, sites = {};
    (f.Fuels || []).forEach(x => fuels[x.FuelId] = fGrade(x.Name));
    (b.Brands || []).forEach(x => brands[x.BrandId] = x.Name);
    (s.S || []).forEach(x => sites[x.S] = [x.Lat, x.Lng, x.N, brands[x.B] || '']);
    return { fuels, sites };
  });
  const per = {};
  for (const p of (await getJ(base + '/Price/GetSitesPrices?' + q, H)).SitePrices || []) {
    const g = meta.fuels[p.FuelId], v = fDollars(p.Price); if (!g || !v) continue;
    const e = per[p.SiteId] || (per[p.SiteId] = [{}, 0]); e[0][g] = v; e[1] = Math.max(e[1], fEpoch(p.TransactionDateUtc));
  }
  const rows = [];
  for (const id in per) { const s = meta.sites[id]; if (s) { const r = fRow(s[0], s[1], s[2], s[3], per[id][0], per[id][1], st); if (r) rows.push(r); } }
  return rows;
}
async function nswState(env, qs) {
  const tok = await edgeCached('fuelmeta/nswtoken', 43000, async () => (await getJ('https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials', { Authorization: 'Basic ' + btoa(env.NSW_FUEL_KEY + ':' + env.NSW_FUEL_SECRET) })).access_token);
  const d = new Date(), pad = n => String(n).padStart(2, '0'), h = d.getUTCHours() % 12 || 12;
  const stamp = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(h)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCHours() < 12 ? 'AM' : 'PM'}`;
  const j = await getJ('https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices' + qs, { Authorization: 'Bearer ' + tok, apikey: env.NSW_FUEL_KEY, transactionid: crypto.randomUUID(), requesttimestamp: stamp, 'Content-Type': 'application/json; charset=utf-8' });
  const st = {}; (j.stations || []).forEach(s => st[s.code] = s);
  const per = {};
  for (const p of j.prices || []) {
    const g = fGrade(p.fueltype), v = fDollars(p.price); if (!g || !v) continue;
    const e = per[p.stationcode] || (per[p.stationcode] = [{}, 0]); e[0][g] = v; e[1] = Math.max(e[1], sydToEpoch(p.lastupdated));
  }
  const rows = [];
  for (const code in per) { const s = st[code]; if (!s) continue; const loc = s.location || {}; const r = fRow(loc.latitude, loc.longitude, s.name, s.brand, per[code][0], per[code][1], String(s.state || 'NSW').toUpperCase()); if (r) rows.push(r); }
  return rows;
}
