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
 'fish': ['["leisure"="fishing"]','["sport"="fishing"]','["man_made"="pier"]','["leisure"="slipway"]','["natural"="beach"]["name"]','["shop"="fishing"]'],
}
KEEP = re.compile(r'^(name|tourism|highway|amenity|man_made|leisure|sport|shop|natural|craft|fee|charge|opening_hours|toilets|shower|showers|drinking_water|water_point|sanitary_dump_station|power_supply|electricity|openfire|fireplace|waste_disposal|bbq|dog|maxstay|max_stay|wheelchair|changing_table|hot_water|unisex|description|website|contact:website|phone|contact:phone|operator|brand|addr:housenumber|addr:street|addr:suburb|addr:city|camping|overnight|access|caravan|motorhome|self_service|capacity|socket:[^:]+)$')

def post(url, q, tries=3):
    for t in range(tries):
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': 'NOMAD-data-builder/1.0'})
            with urllib.request.urlopen(req, timeout=900) as r: return json.loads(r.read())
        except Exception as e:
            print('  retry', url, e); time.sleep(20 * (t + 1))
    return None

def osm():
    out = []
    for g, tags in GROUPS.items():
        q = '[out:json][timeout:900][maxsize:1073741824];area["ISO3166-1"="AU"][admin_level=2]->.au;(' + ''.join(f'nwr{t}(area.au);' for t in tags) + ');out center tags;'
        data = None
        for ep in OVERPASS:
            data = post(ep, q)
            if data and data.get('elements'): break
        els = (data or {}).get('elements', [])
        print(f'OSM {g}: {len(els)}')
        for e in els:
            lat = e.get('lat', (e.get('center') or {}).get('lat')); lon = e.get('lon', (e.get('center') or {}).get('lon'))
            t = e.get('tags') or {}
            if lat is None or t.get('access') in ('private', 'no', 'customers'): continue
            out.append([e['type'][0] + str(e['id']), round(lat, 5), round(lon, 5), {k: v[:200] for k, v in t.items() if KEEP.match(k)}])
    return out

FSQ_MAP = [  # (label regex, tags)
 (r'Laundromat|Laundry Service', {'shop': 'laundry'}),
 (r'Electric Vehicle Charging', {'amenity': 'charging_station'}),
 (r'> Library$|^Library$', {'amenity': 'library'}),
 (r'Public Bathroom|Restroom', {'amenity': 'toilets'}),
 (r'Supermarket|Grocery Store', {'shop': 'supermarket'}),
 (r'Fast Food', {'amenity': 'fast_food'}),
 (r'Caf[eé]|Coffee Shop', {'amenity': 'cafe'}),
 (r'RV Park|Caravan Park', {'tourism': 'caravan_site', 'fee': 'yes'}),
 (r'Fishing Store|Bait Shop', {'shop': 'fishing'}),
 (r'Boat Launch', {'leisure': 'slipway'}),
 (r'> Pier$', {'man_made': 'pier'}),
]
def fsq():
    try:
        import duckdb
        xml = urllib.request.urlopen('https://fsq-os-places-us-east-1.s3.amazonaws.com/?list-type=2&prefix=release/dt%3D&delimiter=/', timeout=60).read()
        ns = {'s': 'http://s3.amazonaws.com/doc/2006-03-01/'}
        rel = sorted(p.find('s:Prefix', ns).text for p in ET.fromstring(xml).findall('s:CommonPrefixes', ns))[-1]
        print('FSQ release', rel)
        con = duckdb.connect(); con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-east-1';")
        rows = con.execute(f"""SELECT fsq_place_id, name, latitude, longitude, address, locality, array_to_string(fsq_category_labels,'|') AS labs
            FROM read_parquet('s3://fsq-os-places-us-east-1/{rel}places/parquet/*.parquet')
            WHERE country='AU' AND date_closed IS NULL AND latitude IS NOT NULL AND name IS NOT NULL
              AND regexp_matches(array_to_string(fsq_category_labels,'|'), '(Laundromat|Laundry Service|Electric Vehicle Charging|Library|Public Bathroom|Restroom|Supermarket|Grocery Store|Fast Food|Caf|Coffee Shop|RV Park|Caravan Park|Fishing Store|Bait Shop|Boat Launch|Pier)')""").fetchall()
        out = []
        for pid, name, lat, lon, addr, loc, labs in rows:
            for rx, tags in FSQ_MAP:
                if any(re.search(rx, l) for l in labs.split('|')):
                    t = dict(tags); t['name'] = name[:120]
                    if addr: t['addr:street'] = addr[:120]
                    if loc: t['addr:suburb'] = loc[:60]
                    t['src'] = 'fsq'
                    out.append(['f' + pid, round(lat, 5), round(lon, 5), t]); break
        print('FSQ places:', len(out)); os.makedirs(OUT, exist_ok=True); open(f'{OUT}/build_log.txt','w').write(f'FSQ release {rel}: {len(rows)} rows, {len(out)} places\n'); return out
    except Exception as e:
        print('FSQ skipped:', e)
        import traceback; os.makedirs(OUT, exist_ok=True); open(f'{OUT}/build_log.txt','w').write('FSQ skipped:\n'+traceback.format_exc())
        return []

def kind(t):
    if t.get('tourism') in ('camp_site', 'caravan_site') or t.get('highway') == 'rest_area': return 'sleep'
    if t.get('shop') in ('laundry', 'dry_cleaning') or t.get('amenity') == 'laundry' or re.search('laund', t.get('name', ''), re.I): return 'laundry'
    return t.get('amenity') or t.get('shop') or t.get('leisure') or t.get('man_made') or 'x'

def main():
    o = osm()
    if len(o) < 20000: raise SystemExit(f'OSM pull looks incomplete ({len(o)}) — keeping old data')
    f = fsq()
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
    with open(f'{OUT}/meta.json', 'w') as fh: json.dump({'v': v, 'tile': TILE, 'count': len(merged), 'tiles': len(tiles), 'sources': ['OpenStreetMap (ODbL)', 'Foursquare Open Source Places (Apache 2.0)']}, fh)
    print('Wrote', len(tiles), 'tiles')

if __name__ == '__main__': main()
