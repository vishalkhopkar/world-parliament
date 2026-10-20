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


CHN_NEIGH = ['IND','BTN','NPL','PAK','MMR','LAO','VNM','MNG','RUS','KAZ','KGZ','TJK','AFG','PRK','KOR']
_chn = {}
def _chn_load():
    if _chn: return
    fc = json.load(open(os.path.join(ROOT, 'data', 'chn_prefec.geojson'), encoding='utf-8'))['features']
    _chn['f'] = [f for f in fc if f['properties']['prov'] not in (810000, 820000)]
    from geo_common import attrs, reader
    a0 = {x['iso']: x['i'] for x in attrs(0)}
    cut = [get_geom('cgaz', 0, a0[i]) for i in CHN_NEIGH if i in a0]
    ex = os.path.join(ROOT, 'data', 'ladakh_claim_extra.geojson')
    if os.path.exists(ex): cut += [shape(f['geometry']) for f in json.load(open(ex, encoding='utf-8'))['features']]
    cut += [get_geom('cgaz', 1, x['i']) for x in attrs(1) if x['iso'] in CHN_NEIGH]
    r1 = reader(1)
    cut += [get_geom('cgaz', 1, x['i']) for x in attrs(1) if x['iso'] == 'PAK' and x['name'] in ('Gilgit-Baltistan', 'Azad Kashmir')]
    _chn['cut'] = unary_union(cut).buffer(0.01)
def chn_geom(u):
    _chn_load()
    if 'prov' in u: sel = [f for f in _chn['f'] if f['properties']['prov'] == u['prov']]
    else: sel = [f for f in _chn['f'] if f['properties']['adcode'] in u['adcodes']]
    parts = []
    for f in sel:
        sg = shape(f['geometry'])
        if not sg.is_valid: sg = shapely.make_valid(sg)
        parts.append(sg.buffer(0).simplify(TOL, preserve_topology=True).buffer(0))
    try: g = unary_union(parts)
    except Exception: g = unary_union([p.buffer(0.0003) for p in parts]).buffer(-0.0003)
    if not g.is_valid: g = shapely.make_valid(g)
    try: g = g.difference(_chn['cut'])
    except Exception: g = shapely.make_valid(g).difference(shapely.make_valid(_chn['cut']))
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
            if u['src'] == 'chn':
                geoms.append(chn_geom(u)); owner[('chn', u.get('prov') or tuple(u['adcodes']))].add(r['seat']); stats['chn'] += 1; continue
            if u['src'] == 'geo':
                gj = json.load(open(os.path.join(ROOT, u['file']), encoding='utf-8'))
                gg = [shape(f['geometry']) for f in gj['features'] if f['properties']['name'] == u['name']]
                geoms.append(unary_union(gg).simplify(TOL, preserve_topology=True)); stats['geo'] += 1; continue
            if u['src'] == 'clip':
                from shapely.geometry import box
                geoms.append(get_geom('cgaz', u['lvl'], u['i']).intersection(box(*u['bbox']))); stats['clip'] += 1; continue
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
        try: g = unary_union(geoms)
        except Exception: g = unary_union([shapely.make_valid(x).buffer(0.0003) for x in geoms]).buffer(-0.0003)
        g = shp_transform(g, eq_earth, include_z=False)
        g = g.simplify(0.05, preserve_topology=True) if False else g
        feats.append({'type': 'Feature', 'properties': {'seat': r['seat']}, 'geometry': mapping(g)})
        if r['approx']: rep.append(f'seat {r["seat"]}: approx units ' + ', '.join(f'{a["name"]}->{a["parent"]}' for a in r['approx']))
    # remove thin internal slivers (gaps between merged units) so seats have no internal lines;
    # keep genuine enclaves that belong to other seats
    from shapely.geometry import Polygon, MultiPolygon
    HOLE_MAX = 3.0   # projected units^2 (~0.2 deg^2)
    all_g = [(lambda x: x if x.is_valid else shapely.make_valid(x))(shape(f['geometry'])) for f in feats]
    tree0 = STRtree(all_g); removed = kept = 0
    for k, f in enumerate(feats):
        g = all_g[k]
        polys = [x for x in (list(g.geoms) if g.geom_type in ('MultiPolygon', 'GeometryCollection') else [g]) if x.geom_type in ('Polygon', 'MultiPolygon')]
        polys = [q for x in polys for q in (list(x.geoms) if x.geom_type == 'MultiPolygon' else [x])]
        new_polys = []
        for pg in polys:
            if pg.geom_type != 'Polygon': new_polys.append(pg); continue
            keep = []
            for ring in pg.interiors:
                hole = Polygon(ring)
                if hole.area >= HOLE_MAX: keep.append(ring); continue
                other = 0.0
                for j in tree0.query(hole):
                    if j != k:
                        try: other += hole.intersection(all_g[j]).area
                        except Exception: other += hole.area  # be safe: treat as enclave
                if other > 0.3 * hole.area: keep.append(ring); kept += 1
                else: removed += 1
            new_polys.append(Polygon(pg.exterior, keep))
        ng = new_polys[0] if len(new_polys) == 1 else MultiPolygon(new_polys)
        f['geometry'] = mapping(ng)
    rep.append(f'internal slivers removed {removed}, enclaves kept {kept}')
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
