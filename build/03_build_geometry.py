"""Union resolved units per seat -> build/seats.geojson (Equal Earth projected, y down) + build/geometry_report.txt"""
import json, os, sys, math, collections, time
import numpy as np
import shapely
from shapely.geometry import shape, Point, mapping
from shapely.ops import unary_union
from shapely import transform as shp_transform
from shapely.strtree import STRtree
import shapefile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo_common import ROOT, reader
TOL = 0.0005
SCALE = 200.0
A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
def eq_earth(xy):
    lam = np.radians(xy[:, 0]); phi = np.radians(xy[:, 1])
    th = np.arcsin(np.sqrt(3) / 2 * np.sin(phi)); t2 = th * th; t6 = t2 ** 3
    x = 2 * np.sqrt(3) * lam * np.cos(th) / (3 * (9 * A4 * t6 * t2 + 7 * A3 * t6 + 3 * A2 * t2 + A1))
    y = th * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))
    return np.column_stack([x * SCALE, -y * SCALE])

readers = {}
cache = {}
def get_geom(src, lvl, i):
    key = (src, lvl, i)
    if key in cache: return cache[key]
    if src == 'cgaz':
        if lvl not in readers: readers[lvl] = reader(lvl)
        shp = readers[lvl].shape(i)
    else:
        if 'ne' not in readers: readers['ne'] = shapefile.Reader(os.path.join(ROOT, 'data', 'ne0', 'ne_10m_admin_0_map_units'), encoding='utf-8')
        shp = readers['ne'].shape(i)
    g = shape(shp.__geo_interface__)
    if not g.is_valid: g = shapely.make_valid(g)
    g = g.simplify(TOL, preserve_topology=True)
    cache[key] = g
    return g

def main():
    resolved = json.load(open(os.path.join(ROOT, 'build', 'resolved.json'), encoding='utf-8'))
    seats_meta = {s['seat']: s for s in json.load(open(os.path.join(ROOT, 'build', 'seats_parsed.json'), encoding='utf-8'))}
    rep = []; feats = []; owner = collections.defaultdict(set); t0 = time.time()
    stats = collections.Counter()
    for r in resolved:
        geoms = []
        for u in r['units']:
            if u['src'] == 'pt':
                geoms.append(Point(u['lon'], u['lat']).buffer(u['r'], 8)); stats['pt'] += 1; continue
            if u['src'] == 'ne':
                geoms.append(get_geom('ne', 0, u['i'])); owner[('ne', 0, u['i'])].add(r['seat']); stats['ne'] += 1; continue
            lvl = u['lvl']; ids = u['i'] if isinstance(u['i'], list) else [u['i']]
            if lvl == 2 and len(ids) > 1:
                parents = [get_geom('cgaz', 1, j) for j in u.get('adm1', [])]
                pu = unary_union(parents) if parents else None
                if u.get('bbox'):
                    x0, y0, x1, y1 = u['bbox']
                    def inb(j):
                        pt = get_geom('cgaz', 2, j).representative_point(); return x0 <= pt.x <= x1 and y0 <= pt.y <= y1
                    pick = [j for j in ids if inb(j)]
                else:
                    pick = [j for j in ids if pu is not None and pu.contains(get_geom('cgaz', 2, j).representative_point())]
                if not pick:
                    pick = [j for j in ids if pu is not None and pu.intersects(get_geom('cgaz', 2, j))][:1]
                if not pick: pick = ids[:1]; rep.append(f'seat {r["seat"]}: ambiguous ADM2 {u["label"]} - picked first of {len(ids)}')
                ids = pick; stats['adm2_disamb'] += 1
            for j in ids:
                geoms.append(get_geom('cgaz', lvl, j)); owner[('cgaz', lvl, j)].add(r['seat']); stats[f'lvl{lvl}'] += 1
        if not geoms:
            rep.append(f'seat {r["seat"]}: EMPTY geometry'); continue
        g = unary_union(geoms)
        g = shp_transform(g, eq_earth, include_z=False)
        g = g.simplify(0.05, preserve_topology=True) if False else g
        feats.append({'type': 'Feature', 'properties': {'seat': r['seat']}, 'geometry': mapping(g)})
        if r['approx']: rep.append(f'seat {r["seat"]}: approx units ' + ', '.join(f'{a["name"]}->{a["parent"]}' for a in r['approx']))
    # unit-level duplicate ownership
    dup = {k: v for k, v in owner.items() if len(v) > 1}
    for k, v in sorted(dup.items()): rep.append(f'DUPLICATE unit {k} in seats {sorted(v)}')
    json.dump({'type': 'FeatureCollection', 'features': feats}, open(os.path.join(ROOT, 'build', 'seats.geojson'), 'w'), separators=(',', ':'))
    # geometric overlaps between seats
    gs = [shape(f['geometry']) for f in feats]; ids = [f['properties']['seat'] for f in feats]
    tree = STRtree(gs); nov = 0
    for a, g in enumerate(gs):
        for b in tree.query(g):
            if b <= a: continue
            try: area = g.intersection(gs[b]).area
            except Exception: area = shapely.make_valid(g).intersection(shapely.make_valid(gs[b])).area
            if area > 1.0:  # scaled units^2 (~ 1 unit = 1/200 of an EqualEarth unit)
                nov += 1; rep.append(f'OVERLAP seats {ids[a]} & {ids[b]} area={area:.1f}')
    rep.append(f'stats {dict(stats)}; seats written {len(feats)}; overlaps {nov}; time {time.time()-t0:.0f}s')
    open(os.path.join(ROOT, 'build', 'geometry_report.txt'), 'w', encoding='utf-8').write('\n'.join(rep))
    print('\n'.join(rep[-12:]))
main()
