"""NOMAD fuel prices: pulls live servo prices from Australian government feeds every few hours.
Output: out/fuel.json  {v, n, attr, states, s:[[lat,lng,name,brand,{grade:$/L},updated_epoch,state], ...]}
Sources switch on automatically when their GitHub secret is set:
  WA          FuelWatch (via FuelWide, free, no key)
  NSW/ACT/TAS NSW FuelCheck API          secrets NSW_FUEL_KEY + NSW_FUEL_SECRET   (api.nsw.gov.au)
  QLD         QLD Fuel Price Reporting   secret  QLD_FUEL_TOKEN                   (fuelpricesqld.com.au)
  SA          SA Fuel Pricing Info       secret  SA_FUEL_TOKEN                    (safuelpricinginformation.com.au)
"""
import json, os, re, time, base64, uuid, datetime, urllib.request, traceback

OUT = 'out'; os.makedirs(OUT, exist_ok=True)
S, LOG, ATTR, STATES = [], [], [], {}

def get(url, headers=None, timeout=90):
    h = {'User-Agent': 'NOMAD-fuel/1.0 (+https://breezusmoon.github.io/Nomad/)', 'Accept': 'application/json'}
    h.update(headers or {})
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
        return json.loads(r.read())

def grade(name):
    n = str(name).lower().replace(' ', '')
    if re.search(r'premiumdiesel|pdl|pdsl|branddiesel|ultimatediesel|vortexdiesel', n): return 'PDSL'
    if re.search(r'diesel|^dl$|^dsl$', n): return 'DSL'
    if re.search(r'e10', n): return 'E10'
    if re.search(r'e85', n): return 'E85'
    if re.search(r'lpg|autogas', n): return 'LPG'
    if re.search(r'98', n): return 'P98'
    if re.search(r'95|pulp|premiumunleaded', n): return 'P95'
    if re.search(r'91|ulp|unleaded|petrol', n): return 'U91'
    return None

def dollars(v):
    try: v = float(v)
    except Exception: return None
    if v <= 0 or v >= 9999: return None
    if v > 1000: v /= 1000      # tenths of a cent (QLD/SA)
    elif v > 20: v /= 100       # cents
    return round(v, 3) if 0.8 < v < 6 else None

def add(lat, lng, name, brand, prices, ts, st):
    try: lat, lng = float(lat), float(lng)
    except Exception: return
    if not (-44.5 < lat < -9 and 112 < lng < 154.5) or not prices: return
    S.append([round(lat, 5), round(lng, 5), (name or '')[:60], (brand or '')[:30], prices, int(ts or time.time()), st])
    STATES[st] = STATES.get(st, 0) + 1

def epoch(s):
    if not s: return None
    for f in ('%Y-%m-%dT%H:%M:%S', '%d/%m/%Y %H:%M:%S', '%Y-%m-%dT%H:%M:%S.%f'):
        try: return int(datetime.datetime.strptime(str(s)[:26].rstrip('Z'), f).replace(tzinfo=datetime.timezone.utc).timestamp())
        except Exception: pass
    return None

# ── WA: FuelWatch via FuelWide (shape detected at runtime, logged for checking) ──
def find_list(o):
    if isinstance(o, list) and o and isinstance(o[0], dict): return o
    if isinstance(o, dict):
        for v in o.values():
            r = find_list(v)
            if r: return r
    return None

def pick(d, rx):
    for k, v in d.items():
        if re.search(rx, k, re.I) and not isinstance(v, (dict, list)): return v
    for k, v in d.items():
        if isinstance(v, dict):
            r = pick(v, rx)
            if r is not None: return r
    return None

def wa():
    j = get('https://fuelwide.com/api/stations/australia?limit=5000')
    rows = find_list(j) or []
    LOG.append('WA sample: ' + json.dumps(rows[:1])[:700])
    attr = j.get('attribution') if isinstance(j, dict) else None
    ATTR.append(attr if isinstance(attr, str) else 'Station prices: FuelWatch, Government of Western Australia, CC BY 4.0')
    for r in rows:
        lat = pick(r, r'^lat'); lng = pick(r, r'^(lon|lng)')
        prices = {}
        for key in ('prices', 'fuels', 'grades', 'price'):
            p = r.get(key)
            if isinstance(p, dict):
                for g, v in p.items():
                    if isinstance(v, dict): v = v.get('price', v.get('value'))
                    gg, dv = grade(g), dollars(v)
                    if gg and dv: prices[gg] = dv
            elif isinstance(p, list):
                for it in p:
                    if isinstance(it, dict):
                        gg = grade(it.get('fuel') or it.get('grade') or it.get('type') or it.get('name') or '')
                        dv = dollars(it.get('price') or it.get('value'))
                        if gg and dv: prices[gg] = dv
        if not prices:  # flat fields like petrol91 / diesel
            for k, v in r.items():
                if isinstance(v, (int, float)) and not re.search(r'lat|lon|lng|id|post|phone', k, re.I):
                    gg, dv = grade(k), dollars(v)
                    if gg and dv: prices[gg] = dv
        add(lat, lng, pick(r, r'^(name|site|trading)'), pick(r, r'brand'), prices, None, 'WA')

# ── QLD / SA: Informed Sources direct API ──
def fpd(base, token, region, st, attr):
    H = {'Authorization': f'FPDAPI SubscriberToken={token}', 'Content-Type': 'application/json'}
    q = f'countryId=21&geoRegionLevel=3&geoRegionId={region}'
    fuels = {f['FuelId']: f['Name'] for f in get(f'{base}/Subscriber/GetCountryFuelTypes?countryId=21', H).get('Fuels', [])}
    brands = {b['BrandId']: b['Name'] for b in get(f'{base}/Subscriber/GetCountryBrands?countryId=21', H).get('Brands', [])}
    sites = {s['S']: s for s in get(f'{base}/Subscriber/GetFullSiteDetails?{q}', H).get('S', [])}
    per = {}
    for p in get(f'{base}/Price/GetSitesPrices?{q}', H).get('SitePrices', []):
        g, dv = grade(fuels.get(p.get('FuelId'), '')), dollars(p.get('Price'))
        if not g or not dv: continue
        e = per.setdefault(p['SiteId'], [{}, 0]); e[0][g] = dv; e[1] = max(e[1], epoch(p.get('TransactionDateUtc')) or 0)
    for sid, (prices, ts) in per.items():
        s = sites.get(sid)
        if s: add(s.get('Lat'), s.get('Lng'), s.get('N'), brands.get(s.get('B'), ''), prices, ts, st)
    ATTR.append(attr)

# ── NSW + ACT + TAS: FuelCheck ──
def nsw(key, secret):
    tok = get('https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials',
              {'Authorization': 'Basic ' + base64.b64encode(f'{key}:{secret}'.encode()).decode()})['access_token']
    for url in ('https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices',
                'https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices?states=TAS'):
        H = {'Authorization': 'Bearer ' + tok, 'apikey': key, 'transactionid': str(uuid.uuid4()),
             'requesttimestamp': datetime.datetime.utcnow().strftime('%d/%m/%Y %I:%M:%S %p'), 'Content-Type': 'application/json; charset=utf-8'}
        j = get(url, H)
        st = {s['code']: s for s in j.get('stations', [])}
        per = {}
        for p in j.get('prices', []):
            g, dv = grade(p.get('fueltype', '')), dollars(p.get('price'))
            if not g or not dv: continue
            e = per.setdefault(p['stationcode'], [{}, 0]); e[0][g] = dv; e[1] = max(e[1], epoch(p.get('lastupdated')) or 0)
        for code, (prices, ts) in per.items():
            s = st.get(code)
            if s:
                loc = s.get('location') or {}
                add(loc.get('latitude'), loc.get('longitude'), s.get('name'), s.get('brand'), prices, ts, (s.get('state') or 'NSW').upper())
    ATTR.append('NSW, ACT & TAS prices: FuelCheck, NSW Government, CC BY 4.0')

def run(name, fn, *a):
    n0 = len(S)
    try: fn(*a); LOG.append(f'{name}: {len(S) - n0} stations')
    except Exception as e: LOG.append(f'{name} FAILED: {e}\n' + traceback.format_exc()[-600:])

run('WA', wa)
if os.environ.get('NSW_FUEL_KEY') and os.environ.get('NSW_FUEL_SECRET'): run('NSW/ACT/TAS', nsw, os.environ['NSW_FUEL_KEY'], os.environ['NSW_FUEL_SECRET'])
else: LOG.append('NSW/ACT/TAS: no key set')
if os.environ.get('QLD_FUEL_TOKEN'): run('QLD', fpd, 'https://fppdirectapi-prod.fuelpricesqld.com.au', os.environ['QLD_FUEL_TOKEN'], 1, 'QLD', 'QLD prices: Queensland Government Fuel Price Reporting')
else: LOG.append('QLD: no token set')
if os.environ.get('SA_FUEL_TOKEN'): run('SA', fpd, 'https://fppdirectapi-prod.safuelpricinginformation.com.au', os.environ['SA_FUEL_TOKEN'], 4, 'SA', 'SA prices: SA Government Fuel Pricing Information Scheme')
else: LOG.append('SA: no token set')

print('\n'.join(LOG))
open(f'{OUT}/log.txt', 'w').write('\n'.join(LOG) + '\n')
if not S: raise SystemExit('No fuel prices fetched — keeping the previous file')
json.dump({'v': int(time.time()), 'n': len(S), 'states': STATES, 'attr': ATTR, 's': S}, open(f'{OUT}/fuel.json', 'w'), separators=(',', ':'), ensure_ascii=False)
print('Wrote', len(S), 'stations', STATES)
