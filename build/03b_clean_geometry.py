"""Step 3b: close hairline gaps / slits inside every seat so the map shows no internal or dangling lines.
Reads build/seats.geojson (written by 03), writes it back (raw copy kept as build/seats_raw.geojson).
For each seat: morphological closing (buffer +D, buffer -D); the added area is clipped so it never
enters another seat. Genuine enclaves/holes (other seats inside) are untouched because the added
area has other seats subtracted. Run from project root:  python -I build/03b_clean_geometry.py [--d 0.08] [--seats 88,447]
Units are projected units (1 unit ~ 32 km)."""
import json, os, sys, time, shutil
from multiprocessing import Pool
import shapely
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'build', 'seats.geojson')
RAW = os.path.join(ROOT, 'build', 'seats_raw.geojson')
D = 0.08
OVERRIDE = {}          # seat -> D, for seats that need a wider closing
_G = {}; _IDS = []; _TREE = None; _GL = []


def _valid(g):
    return g if g.is_valid else shapely.make_valid(g)


def _init(path):
    global _G, _IDS, _TREE, _GL
    fc = json.load(open(path, encoding='utf-8'))
    _G = {f['properties']['seat']: _valid(shape(f['geometry'])) for f in fc['features']}
    _IDS = sorted(_G); _GL = [_G[i] for i in _IDS]; _TREE = STRtree(_GL)


def clean(sid, d=None):
    d = d or OVERRIDE.get(sid, D)
    g = _G[sid]
    try:
        closed = g.buffer(d, quad_segs=4).buffer(-d, quad_segs=4)
        add = closed.difference(g)
        if not add.is_empty:
            near = [_GL[j] for j in _TREE.query(add) if _IDS[j] != sid]
            if near: add = add.difference(unary_union(near))
        new = _valid(unary_union([g, add])) if not add.is_empty else g
    except Exception as e:
        return sid, None, f'ERR {e}'
    keep = [p for p in (new.geoms if hasattr(new, 'geoms') else [new]) if p.geom_type in ('Polygon', 'MultiPolygon')]
    new = unary_union(keep)
    return sid, new, f'added {new.area - g.area:+.4f}'


def _job(a):
    return clean(*a)


def main():
    global D
    args = sys.argv[1:]
    only = None
    if '--d' in args: D = float(args[args.index('--d') + 1])
    if '--seats' in args: only = {int(x) for x in args[args.index('--seats') + 1].split(',')}
    out = SRC
    if '--out' in args: out = args[args.index('--out') + 1]
    if not os.path.exists(RAW) or '--refresh-raw' in args: shutil.copy(SRC, RAW)
    src = RAW                           # always clean from the raw copy so re-runs are idempotent
    t0 = time.time()
    fc = json.load(open(src, encoding='utf-8'))
    ids = [f['properties']['seat'] for f in fc['features']]
    todo = [i for i in ids if only is None or i in only]
    with Pool(min(8, os.cpu_count() or 2), initializer=_init, initargs=(src,)) as pool:
        res = {sid: (g, msg) for sid, g, msg in pool.imap_unordered(_job, [(i, None) for i in todo], chunksize=1)}
    changed = 0
    for f in fc['features']:
        sid = f['properties']['seat']
        if sid in res and res[sid][0] is not None:
            g, msg = res[sid]
            if msg != 'added +0.0000' and not msg.startswith('added -0.0000'): changed += 1
            f['geometry'] = mapping(g)
        elif sid in res: print('seat', sid, res[sid][1])
    json.dump(fc, open(out, 'w', encoding='utf-8'), separators=(',', ':'))
    big = sorted(((float(m.split()[1]), s) for s, (g, m) in res.items() if g is not None and m.startswith('added')), reverse=True)[:12]
    print(f'closed {len(todo)} seats (D={D}) changed {changed} in {time.time()-t0:.0f}s -> {out}')
    print('largest additions (area units^2, seat):', big)


if __name__ == '__main__':
    main()
