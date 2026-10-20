"""-> <map>/site/data/seats.json (panel data + colour index per seat)"""
import json, os, sys, collections
import shapefile
from shapely.geometry import shape
from shapely.strtree import STRtree
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # maps/<id>/source
SITE_DATA = os.path.join(os.path.dirname(ROOT), 'site', 'data')     # maps/<id>/site/data
parsed = {s['seat']: s for s in json.load(open(os.path.join(ROOT, 'build', 'seats_parsed.json'), encoding='utf-8'))}
resolved = {r['seat']: r for r in json.load(open(os.path.join(ROOT, 'build', 'resolved.json'), encoding='utf-8'))}
sh = shapefile.Reader(os.path.join(ROOT, 'data', 'ne0', 'ne_10m_admin_0_map_units'), encoding='utf-8')
a3to2 = {}
for r in sh.iterRecords():
    d = r.as_dict()
    for k in ('ADM0_A3', 'ISO_A3_EH', 'ISO_A3'):
        v2 = d.get('ISO_A2_EH') if d.get('ISO_A2_EH') not in (None, '-99') else d.get('ISO_A2')
        if d.get(k) and v2 and v2 != '-99': a3to2.setdefault(d[k], v2.lower())
a3to2.update({'XKX': 'xk', '129': 'ps', '118': 'ps', 'FRA': 'fr', 'NOR': 'no', 'MMR': 'mm', '117': 'fk', 'SWZ': 'sz', 'TWN': 'tw', 'PSE': 'ps', 'GUF': 'gf'})
NAME2 = {'Bonaire, Sint Eustatius and Saba': 'bq', 'Saint Helena, Ascension and Tristan da Cunha': 'sh', 'Palestine': 'ps', 'Kosovo': 'xk'}
TAGS = {n: "claimed territory of Ladakh (India's official boundary)" for n in ('Aksai Chin', 'Shaksgam Valley')}
out = []
for sid, s in sorted(parsed.items()):
    r = resolved[sid]; a3 = {c['name']: c['a3'] for c in r['countries']}
    cs = []
    for c in s['countries']:
        iso2 = NAME2.get(c['name']) or a3to2.get(a3.get(c['name'], ''), '')
        e = {'name': c['name'], 'iso2': iso2, 'whole': c['whole'], 'adm1': c['adm1']}
        if c['name'] in TAGS: e['iso2'] = 'in'; e['tag'] = TAGS[c['name']]
        cs.append(e)
    out.append({'id': sid, 'name': s['name'], 'constituency': s['constituency'], 'continent': s['continent'], 'pop': s['pop'],
                'desc': s['description'], 'countries': cs, 'approx': [a['name'] for a in r['approx']]})
# graph colouring (DSATUR) on adjacency of seat geometries
gj = json.load(open(os.path.join(ROOT, 'build', 'world_simple.geojson'), encoding='utf-8'))
ids = [f['properties']['seat'] for f in gj['features']]
gs = [shape(f['geometry']).buffer(0.4).simplify(0.1) for f in gj['features']]
tree = STRtree(gs); adj = collections.defaultdict(set)
for a, g in enumerate(gs):
    for b in tree.query(g):
        if b != a and g.intersects(gs[b]): adj[ids[a]].add(ids[b])
color = {}; NCOL = 8
order = sorted(ids, key=lambda i: -len(adj[i]))
while len(color) < len(ids):
    nxt = max((i for i in ids if i not in color), key=lambda i: (len({color[n] for n in adj[i] if n in color}), len(adj[i])))
    used = {color[n] for n in adj[nxt] if n in color}
    color[nxt] = next((c for c in range(NCOL) if c not in used), min(range(NCOL), key=lambda c: sum(1 for n in adj[nxt] if color.get(n) == c)))
for s in out: s['color'] = color.get(s['id'], 0)
# site/data/seats.json (maps/<id>/site/data) is the source of truth for seat NAMES: keep any name already stored there.
_sj = os.path.join(SITE_DATA, 'seats.json')
if os.path.exists(_sj):
    _prev = json.load(open(_sj, encoding='utf-8'))
    _old = {s['id']: s['name'] for s in _prev}
    _dev = {s['id']: s.get('name_dev', '') for s in _prev}      # Devanagari name shown under the English one in the panel
    for s in out: s['name'] = _old.get(s['id'], s['name']); s['name_dev'] = _dev.get(s['id'], '')
    # keep key order stable (name_dev right after name) so seats.json diffs stay small
    out = [{k: v for kk in s for k, v in ([(kk, s[kk])] + ([('name_dev', s['name_dev'])] if kk == 'name' else [])) if k != 'name_dev' or kk == 'name'} for s in out]
with open(os.path.join(SITE_DATA, 'seats.json'), 'w', encoding='utf-8') as _f: _f.write(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
bad = [i for i in ids if any(color[n] == color[i] for n in adj[i])]
print('seats', len(out), 'coloured', len(color), 'conflicts', len(bad), 'missing iso2', sorted({c['name'] for s in out for c in s['countries'] if not c['iso2']}))
