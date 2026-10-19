"""NOMAD places database builder.
Pulls every useful place for travellers in Australia from OpenStreetMap (Overpass)
and Foursquare Open Source Places, merges + de-duplicates, and writes small map tiles
to data/ that the app loads instantly (and offline). Runs weekly via GitHub Actions."""
import json, math, os, re, time, datetime, urllib.request, urllib.parse
import xml.etree.ElementTree as ET

OUT = 'data'; TILE = 0.5
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
GROUPS = {
 'sleep': ['["tourism"="camp_site"]','["tourism"="caravan_site"]','["highway"="rest_area"]','["amenity"="parking"]["caravan"="yes"]','["amenity"="parking"]["motorhome"="yes"]'],
 'toilet': ['["amenity"="toilets"]'],
 'water': ['["amenity"="drinking_water"]','["amenity"="water_point"]','["man_made"="water_tap"]'],
 'wash': ['["amenity"="shower"]','["amenity"="sanitary_dump_station"]','["amenity"="laundry"]','["shop"="laundry"]','["shop"="dry_cleaning"]'],
 'leisure': ['["leisure"="fitness_station"]','["leisure"="pitch"]["sport"="fitness"]','["amenity"="bbq"]','["tourism"="picnic_site"]'],
 'power': ['["amenity"="charging_station"]','["amenity"="device_charging_station"]','["amenity"="library"]'],
 'food': ['["amenity"~"^(fast_food|cafe)$"]["name"]','["amenity"="restaurant"]["name"]','["shop"="supermarket"]'],
 'fuel': ['["amenity"="fuel"]'],
 'wifi': ['["internet_access"~"^(wlan|yes|wifi|public)$"]'],
 'fish': ['["leisure"="fishing"]','["sport"="fishing"]','["man_made"="pier"]','["leisure"="slipway"]','["natural"="beach"]["name"]','["shop"="fishing"]'],
}
KEEP = re.compile(r'^(internet_access|internet_access:fee|internet_access:ssid|name|tourism|highway|amenity|man_made|leisure|sport|shop|natural|craft|fee|charge|opening_hours|toilets|shower|showers|drinking_water|water_point|sanitary_dump_station|power_supply|electricity|openfire|fireplace|waste_disposal|bbq|dog|maxstay|max_stay|wheelchair|changing_table|hot_water|unisex|description|website|contact:website|phone|contact:phone|operator|brand|addr:housenumber|addr:street|addr:suburb|addr:city|camping|overnight|access|caravan|motorhome|self_service|capacity|socket:[^:]+)$')

def post(url, q, tries=3):
    for t in range(tries):
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': 'NOMAD-data-builder/1.0'})
            with urllib.request.urlopen(req, timeout=900) as r: return json.loads(r.read())
        except Exception as e:
            print('  retry', url, e); time.sleep(20 * (t + 1))
    return None

def fetch(tags):
    q = '[out:json][timeout:900][maxsize:1073741824];area["ISO3166-1"="AU"][admin_level=2]->.au;(' + ''.join(f'nwr{t}(area.au);' for t in tags) + ');out center tags;'
    for ep in OVERPASS:
        data = post(ep, q)
        if data and data.get('elements'): return data['elements']
    return []

def matches(t, filt):
    for k, op, v in re.findall(r'\["([^"]+)"(?:(=|~)"([^"]*)")?\]', filt):
        x = t.get(k)
        if x is None or (op == '=' and x != v) or (op == '~' and not re.search(v, x)): return False
    return True

def old_entries(tags):
    out = []
    try:
        for fn in os.listdir(f'{OUT}/t'):
            for e in json.load(open(f'{OUT}/t/{fn}'))['e']:
                if e[0][0] in 'nwr' and any(matches(e[3], f) for f in tags): out.append(e)
    except Exception: pass
    return out

def osm():
    out, counts = [], {}
    try: prevg = json.load(open(f'{OUT}/meta.json')).get('groups', {})
    except Exception: prevg = {}
    for g, tags in GROUPS.items():
        els = fetch(tags)
        if not els:  # whole-group query failed: try each tag on its own
            print(f'OSM {g}: group query empty, splitting'); time.sleep(30)
            for t in tags: els += fetch([t])
        print(f'OSM {g}: {len(els)}')
        if len(els) < 0.6 * prevg.get(g, 0) or (not els):
            keep = old_entries(tags)
            print(f'OSM {g}: looks incomplete, keeping {len(keep)} previous entries')
            if len(keep) > len(els):
                counts[g] = len(keep); out += keep; continue
        counts[g] = len(els)
        for e in els:
            lat = e.get('lat', (e.get('center') or {}).get('lat')); lon = e.get('lon', (e.get('center') or {}).get('lon'))
            t = e.get('tags') or {}
            if lat is None or t.get('access') in ('private', 'no', 'customers'): continue
            out.append([e['type'][0] + str(e['id']), round(lat, 5), round(lon, 5), {k: v[:200] for k, v in t.items() if KEEP.match(k)}])
    return out, counts

OV_MAP = [  # Overture Maps places (Meta, Microsoft, Foursquare + more; CDLA/ODbL)
 (r'laundr|dry_clean', {'shop': 'laundry'}),
 (r'ev_charging|charging_station', {'amenity': 'charging_station'}),
 (r'^library', {'amenity': 'library'}),
 (r'toilet|restroom', {'amenity': 'toilets'}),
 (r'supermarket|grocery', {'shop': 'supermarket'}),
 (r'fast_food', {'amenity': 'fast_food'}),
 (r'^cafe|coffee', {'amenity': 'cafe'}),
 (r'rv_park|caravan', {'tourism': 'caravan_site', 'fee': 'yes'}),
 (r'fishing|bait', {'shop': 'fishing'}),
 (r'boat_ramp|boat_launch', {'leisure': 'slipway'}),
]
def osm_pbf(path='au.osm.pbf'):
    """Fast path: whole-of-Australia extract from Geofabrik + osmium (minutes, no rate limits)."""
    import subprocess
    if not os.path.exists(path): print('No PBF extract, using Overpass'); return None
    exprs = set()
    for tags in GROUPS.values():
        for f in tags:
            k, op, v = re.findall(r'\["([^"]+)"(?:(=|~)"([^"]*)")?\]', f)[0]
            if op == '=': exprs.add(f'nwr/{k}={v}')
            elif op == '~':
                m = re.match(r'^\^\((.*)\)\$$', v)
                exprs.add(f'nwr/{k}=' + ','.join(m.group(1).split('|')) if m else f'nwr/{k}')
            else: exprs.add(f'nwr/{k}')
    t0 = time.time()
    subprocess.run(['osmium', 'tags-filter', path, *sorted(exprs), '-o', 'f.osm.pbf', '--overwrite'], check=True)
    subprocess.run(['osmium', 'export', 'f.osm.pbf', '-f', 'geojsonseq', '-u', 'type_id', '-o', 'f.geojsonseq', '--overwrite'], check=True)
    print(f'osmium filter+export {time.time()-t0:.0f}s')
    def centre(g):
        t, c = g['type'], g['coordinates']
        if t == 'Point': return c[1], c[0]
        if t == 'LineString': p = c[len(c)//2]; return p[1], p[0]
        if t == 'MultiLineString': p = c[0][len(c[0])//2]; return p[1], p[0]
        ring = c[0] if t == 'Polygon' else c[0][0]
        return sum(p[1] for p in ring)/len(ring), sum(p[0] for p in ring)/len(ring)
    out, counts, seen = [], {g: 0 for g in GROUPS}, set()
    for line in open('f.geojsonseq', encoding='utf-8'):
        line = line.strip().lstrip('\x1e')
        if not line: continue
        try: ft = json.loads(line)
        except Exception: continue
        t = {k: str(v) for k, v in (ft.get('properties') or {}).items() if not k.startswith('@')}
        if not t or t.get('access') in ('private', 'no', 'customers'): continue
        grp = next((g for g, tags in GROUPS.items() if any(matches(t, f) for f in tags)), None)
        if not grp: continue
        fid = str(ft.get('id') or (ft.get('properties') or {}).get('@id') or '')
        if not fid or fid in seen: continue
        seen.add(fid)
        try: lat, lon = centre(ft['geometry'])
        except Exception: continue
        if not (-44.5 < lat < -9 and 112 < lon < 154.5): continue
        counts[grp] += 1
        out.append([fid[0] + fid[1:].lstrip('0'), round(lat, 5), round(lon, 5), {k: v[:200] for k, v in t.items() if KEEP.match(k)}])
    for g, n in counts.items(): print(f'OSM {g}: {n}')
    return out, counts

def overture():
    try:
        import duckdb
        xml = urllib.request.urlopen('https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/', timeout=60).read()
        ns = {'s': 'http://s3.amazonaws.com/doc/2006-03-01/'}
        rels = sorted(p.find('s:Prefix', ns).text for p in ET.fromstring(xml).findall('s:CommonPrefixes', ns))
        rel = rels[-1]; print('Overture release', rel)
        con = duckdb.connect(); con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
        src = f"read_parquet('s3://overturemaps-us-west-2/{rel}theme=places/type=place/*', hive_partitioning=1)"
        cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()}
        print('Overture columns:', sorted(cols))
        catx = 'categories.primary' if 'categories' in cols else 'taxonomy.primary' if 'taxonomy' in cols else 'basic_category'
        addx = "addresses[1].freeform AS addr, addresses[1].locality AS loc" if 'addresses' in cols else "NULL AS addr, NULL AS loc"
        confx = "AND confidence >= 0.55" if 'confidence' in cols else ""
        rows = con.execute(f"""SELECT id, names.primary AS name, (bbox.ymin+bbox.ymax)/2 AS lat, (bbox.xmin+bbox.xmax)/2 AS lon, {catx} AS cat, {addx}
            FROM {src}
            WHERE bbox.xmin BETWEEN 112 AND 154.5 AND bbox.ymin BETWEEN -44.5 AND -9 {confx}
              AND names.primary IS NOT NULL AND {catx} IS NOT NULL
              AND regexp_matches({catx}, '(laundr|dry_clean|ev_charging|charging_station|^library|toilet|restroom|supermarket|grocery|fast_food|^cafe|coffee|rv_park|caravan|fishing|bait|boat_ramp|boat_launch)')""").fetchall()
        out = []
        for pid, name, lat, lon, cat, addr, loc in rows:
            for rx, tags in OV_MAP:
                if re.search(rx, cat):
                    t = dict(tags); t['name'] = name[:120]
                    if addr: t['addr:street'] = addr[:120]
                    if loc: t['addr:suburb'] = loc[:60]
                    t['src'] = 'ovt'
                    out.append(['f' + str(pid)[:24], round(lat, 5), round(lon, 5), t]); break
        os.makedirs(OUT, exist_ok=True); open(f'{OUT}/build_log.txt','w').write(f'Overture {rel} ({catx}): {len(out)} places\n')
        print('Overture places:', len(out)); return out
    except Exception as e:
        import traceback; print('Overture skipped:', e); os.makedirs(OUT, exist_ok=True); open(f'{OUT}/build_log.txt','w').write('Overture skipped:\n'+traceback.format_exc()); return []

def kind(t):
    if t.get('tourism') in ('camp_site', 'caravan_site') or t.get('highway') == 'rest_area': return 'sleep'
    if t.get('shop') in ('laundry', 'dry_cleaning') or t.get('amenity') == 'laundry' or re.search('laund', t.get('name', ''), re.I): return 'laundry'
    return t.get('amenity') or t.get('shop') or t.get('leisure') or t.get('man_made') or 'x'

def main():
    t0 = time.time()
    o, counts = osm_pbf() or osm()
    print(f'OSM done in {time.time()-t0:.0f}s')
    if counts.get('sleep', 0) < 3000: raise SystemExit(f'Camps pull failed ({counts.get("sleep")}) — keeping old data')
    try: prev = json.load(open(f'{OUT}/meta.json')).get('osm', 0)
    except Exception: prev = 0
    if len(o) < max(20000, prev*0.93): raise SystemExit(f'OSM pull looks incomplete ({len(o)}) — keeping old data')
    f = overture()
    grid = {}
    for e in o:
        grid.setdefault((kind(e[3]), round(e[1], 3), round(e[2], 3)), []).append(e)
    def near(e):
        k = kind(e[3])
        for dl in (-0.001, 0, 0.001):
            for dg in (-0.001, 0, 0.001):
                for x in grid.get((k, round(e[1] + dl, 3), round(e[2] + dg, 3)), []):
                    if abs(x[1] - e[1]) < 0.0009 and abs(x[2] - e[2]) < 0.0009: return True
        return False
    merged = o + [e for e in f if not near(e)]
    print('Total after merge:', len(merged))
    tiles = {}
    for e in merged:
        tiles.setdefault(f'{math.floor(e[1] / TILE)}_{math.floor(e[2] / TILE)}', []).append(e)
    os.makedirs(f'{OUT}/t', exist_ok=True)
    for fn in os.listdir(f'{OUT}/t'): os.remove(f'{OUT}/t/{fn}')
    for k, v in tiles.items():
        with open(f'{OUT}/t/{k}.json', 'w') as fh: json.dump({'e': v}, fh, separators=(',', ':'), ensure_ascii=False)
    v = datetime.datetime.utcnow().strftime('%Y%m%d')
    with open(f'{OUT}/meta.json', 'w') as fh: json.dump({'v': v, 'tile': TILE, 'count': len(merged), 'osm': len(o), 'groups': counts, 'extra': len(merged)-len(o), 'tiles': len(tiles), 'sources': ['OpenStreetMap (ODbL)', 'Overture Maps Foundation (CDLA-Permissive / ODbL)']}, fh)
    fu = [[e[1], e[2], e[3].get('name', '')[:60], (e[3].get('brand') or e[3].get('operator') or '')[:30]] for e in o if e[3].get('amenity') == 'fuel']
    with open(f'{OUT}/fuel_osm.json', 'w') as fh: json.dump(fu, fh, separators=(',', ':'), ensure_ascii=False)
    print('Wrote', len(tiles), 'tiles,', len(fu), 'servos')

if __name__ == '__main__': main()
