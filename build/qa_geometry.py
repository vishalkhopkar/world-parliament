"""QA: find hairline gaps (internal lines), thin spikes (dangling lines) and slivers in a seats GeoJSON.
usage: python -I build/qa_geometry.py <seats.geojson> [out.json] [--seats 1,2,3]
Works on build/seats.geojson (raw projected) or a GeoJSON converted from a TopoJSON LOD
(mapshaper site/data/detail.topo.json -o x.geojson format=geojson). Units: projected, 1 unit ~ 32 km.
Kinds:  gap   = narrow cleft/hole between parts of a seat that closing would fill (not other seats' land)
        spike = protrusion thinner than 2*SPIKE_W (a dangling line) - ignoring whole tiny islands
        sliver= tiny polygon part (< SLIVER_A) lying within 0.3 units of a bigger part of the same seat"""
import json, os, sys, time
from multiprocessing import Pool
import shapely
from shapely.geometry import shape
from shapely.ops import unary_union
from shapely.strtree import STRtree

GAP_D = 0.08       # same distance as 03b (closing is idempotent, so a cleaned seat should add ~0)
GAP_W = 0.2        # a gap component is "thin" when mean width (2A/P) below this
GAP_L = 0.1        # ... and half-perimeter (~length) at least this
SPIKE_W = 0.04
SPIKE_L = 0.15
SLIVER_A = 0.02
_IDS = []; _GL = []; _TREE = None


def _valid(g):
    return g if g.is_valid else shapely.make_valid(g)


def _init(path):
    global _IDS, _GL, _TREE
    fc = json.load(open(path, encoding='utf-8'))
    _IDS = [f['properties']['seat'] for f in fc['features']]
    _GL = [_valid(shape(f['geometry'])) for f in fc['features']]
    _TREE = STRtree(_GL)


def parts(g):
    if g.is_empty: return []
    out = []
    for p in (g.geoms if hasattr(g, 'geoms') else [g]):
        if p.geom_type == 'Polygon': out.append(p)
        elif hasattr(p, 'geoms'): out += parts(p)
    return out


def qa(sid):
    k = _IDS.index(sid); g = _GL[k].simplify(0.003, preserve_topology=True); res = []
    try:
        near_others = lambda geom: [_GL[j] for j in _TREE.query(geom) if _IDS[j] != sid]
        def landfrac(p):
            # share of a thin ring around part p that is land of the SAME or OTHER seats (not open sea)
            ring = p.buffer(0.06, quad_segs=2).difference(p)
            if ring.is_empty or ring.area == 0: return 0
            land = [x for x in near_others(ring)] + [g.difference(p)]
            return ring.intersection(unary_union(land)).area / ring.area
        # gaps
        closed = g.buffer(GAP_D, quad_segs=2).buffer(-GAP_D, quad_segs=2)
        gap = closed.difference(g)
        if not gap.is_empty:
            o = near_others(gap)
            if o: gap = gap.difference(unary_union(o))
            for p in parts(gap):
                w = 2 * p.area / max(p.length, 1e-9)
                if p.area > 2e-4 and w < GAP_W and p.length / 2 >= GAP_L:
                    res.append(dict(seat=sid, kind='gap', area=round(p.area, 4), width=round(w, 4), length=round(p.length / 2, 3), x=round(p.centroid.x, 3), y=round(p.centroid.y, 3)))
        # spikes: parts of g that vanish under opening, minus whole small polygons
        opened = g.buffer(-SPIKE_W, quad_segs=2).buffer(SPIKE_W, quad_segs=2)
        thin = g.difference(opened.buffer(0.002))
        for p in parts(thin):
            if p.area < 1e-5: continue
            L = max(p.bounds[2] - p.bounds[0], p.bounds[3] - p.bounds[1])
            if L < SPIKE_L: continue
            # skip a polygon that is entirely thin AND an isolated island (kept intentionally)
            if landfrac(p) < 0.5: continue
            res.append(dict(seat=sid, kind='spike', area=round(p.area, 4), width=round(2 * p.area / max(p.length, 1e-9), 4), length=round(L, 3), x=round(p.centroid.x, 3), y=round(p.centroid.y, 3)))
        # slivers: tiny parts hugging a bigger part of the same seat
        ps = parts(g)
        if len(ps) > 1:
            big = [p for p in ps if p.area >= SLIVER_A]
            for p in ps:
                if p.area < SLIVER_A and any(p.distance(b) < 0.3 for b in big) and landfrac(p) >= 0.5:
                    res.append(dict(seat=sid, kind='sliver', area=round(p.area, 5), width=0, length=round(max(p.bounds[2] - p.bounds[0], p.bounds[3] - p.bounds[1]), 3), x=round(p.centroid.x, 3), y=round(p.centroid.y, 3)))
    except Exception as e:
        res.append(dict(seat=sid, kind='error', msg=str(e)))
    return res


def main():
    a = sys.argv[1:]
    src = a[0]; out = a[1] if len(a) > 1 and not a[1].startswith('--') else None
    only = None
    if '--seats' in a: only = [int(x) for x in a[a.index('--seats') + 1].split(',')]
    t0 = time.time()
    ids = [f['properties']['seat'] for f in json.load(open(src, encoding='utf-8'))['features']]
    todo = only or ids
    with Pool(min(8, os.cpu_count() or 2), initializer=_init, initargs=(src,)) as pool:
        allres = [r for rs in pool.imap_unordered(qa, todo, chunksize=1) for r in rs]
    allres.sort(key=lambda r: (r['seat'], r['kind']))
    if out: json.dump(allres, open(out, 'w'), indent=1)
    seats = sorted({r['seat'] for r in allres})
    print(f'{len(allres)} findings in {len(seats)} seats ({time.time()-t0:.0f}s)')
    from collections import Counter
    print(Counter(r['kind'] for r in allres))
    for r in allres[:80]: print(r)


if __name__ == '__main__':
    main()
