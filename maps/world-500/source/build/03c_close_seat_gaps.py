"""Step 3c: close narrow land gaps BETWEEN seats (border mismatches between source datasets, ~1-3 km wide) so
neighbouring seats meet cleanly instead of leaving a thin sea-coloured strip.
Reads build/seats.geojson (output of 03b), keeps a copy as build/seats_pre03c.geojson (re-runs start from it), writes seats.geojson.
Gap = closing(union of all seats, D) minus the union, restricted to pieces touching >= 2 seats; each piece is shared between the
neighbouring seats (each takes what lies within D of it). Wider water (straits > 2*D) and gaps touching one seat only are untouched.
usage: python -I build/03c_close_seat_gaps.py [--d 0.04] [--out file]   (units: projected, 1 unit ~ 32 km)"""
import json, os, sys, shutil, time
import shapely
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'build', 'seats.geojson')
SIMP = 0.002
PRE = os.path.join(ROOT, 'build', 'seats_pre03c.geojson')


def valid(g): return g if g.is_valid else shapely.make_valid(g)


def main():
    a = sys.argv[1:]
    D = float(a[a.index('--d') + 1]) if '--d' in a else 0.04
    out = a[a.index('--out') + 1] if '--out' in a else SRC
    if not os.path.exists(PRE) or '--refresh' in a: shutil.copy(SRC, PRE)
    t0 = time.time()
    fc = json.load(open(PRE, encoding='utf-8'))
    ids = [f['properties']['seat'] for f in fc['features']]
    G = [valid(shape(f['geometry'])).simplify(SIMP, preserve_topology=True) for f in fc['features']]  # ~60 m: full-res closing of the world union is too slow
    tree = STRtree(G)
    U = unary_union(G); print('union', round(time.time() - t0), 's', flush=True)
    C = U.buffer(D, quad_segs=2).buffer(-D, quad_segs=2)
    gap = C.difference(U); print('closing', round(time.time() - t0), 's', flush=True)
    pieces = [p for p in (gap.geoms if hasattr(gap, 'geoms') else [gap]) if p.geom_type == 'Polygon' and p.area > 1e-6]
    take = {i: [] for i in range(len(G))}; used = n_multi = 0
    for p in pieces:
        pb = p.buffer(0.005)
        nb = [j for j in tree.query(pb) if G[j].intersects(pb)]
        if len(nb) < 2: continue          # sea inlet / coastal notch of a single seat: leave alone
        n_multi += 1; rem = p
        nb.sort(key=lambda j: G[j].distance(p))
        for j in nb:
            if rem.is_empty: break
            try: piece = rem.intersection(G[j].buffer(D * 0.55, quad_segs=2))
            except Exception: piece = valid(rem).intersection(valid(G[j].buffer(D * 0.55, quad_segs=2)))
            if piece.is_empty: continue
            take[j].append(piece)
            try: rem = rem.difference(piece)
            except Exception: rem = valid(rem).difference(valid(piece))
        if not rem.is_empty and rem.area > 1e-7:
            j = min(nb, key=lambda j: G[j].distance(rem)); take[j].append(rem)
    changed = 0; added = 0.0
    for k, f in enumerate(fc['features']):
        if take[k]:
            new = valid(unary_union([G[k]] + take[k]))
            keep = [x for x in (new.geoms if hasattr(new, 'geoms') else [new]) if x.geom_type == 'Polygon']
            new = unary_union(keep)
            added += new.area - G[k].area; changed += 1
            f['geometry'] = mapping(new)
    json.dump(fc, open(out, 'w', encoding='utf-8'), separators=(',', ':'))
    print(f'D={D}: {n_multi} inter-seat gap pieces closed, {changed} seats changed, +{added:.2f} units^2, {time.time() - t0:.0f}s -> {out}')


if __name__ == '__main__':
    main()
