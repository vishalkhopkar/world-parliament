"""Find internal/dangling lines in the final TopoJSON: an arc that a seat uses on BOTH sides
(i and ~i inside the same seat) is a zero-width spike or a seam inside the seat.
usage: python -I build/check_internal_lines.py [site/data/world.topo.json ...]  (default: both LODs)
Prints per-seat count and total length (projected units, 1 unit ~ 32 km); exit 1 if any found."""
import json, sys, os, math, collections
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def rings(arcs, out):
    # arcs: nested lists of ints; a ring is a flat list of ints
    if arcs and isinstance(arcs[0], int): out.append(arcs)
    else:
        for a in arcs: rings(a, out)

def check(path, min_len=0.0):
    t = json.load(open(path, encoding='utf-8'))
    sc, tr = t['transform']['scale'], t['transform']['translate']
    dec = []
    for arc in t['arcs']:
        x = y = 0; pts = []
        for dx, dy in arc:
            x += dx; y += dy; pts.append((x * sc[0] + tr[0], y * sc[1] + tr[1]))
        dec.append(pts)
    def length(i):
        p = dec[i if i >= 0 else ~i]
        return sum(math.dist(p[k], p[k + 1]) for k in range(len(p) - 1))
    res = {}
    for g in t['objects']['seats']['geometries']:
        sid = g.get('id', g.get('properties', {}).get('seat'))
        rs = []; rings(g['arcs'], rs)
        cnt = collections.Counter(a for r in rs for a in r)
        bad = [a for a in cnt if a >= 0 and ~a in cnt] + [a for a in cnt if cnt[a] > 1 and a >= 0 and ~a not in cnt]
        bad = [a for a in set(bad) if length(a) >= min_len]
        if bad:
            res[int(sid)] = [(round(length(a), 3), dec[a if a >= 0 else ~a][0], dec[a if a >= 0 else ~a][-1]) for a in bad]
    return res

if __name__ == '__main__':
    files = sys.argv[1:] or [os.path.join(ROOT, 'site', 'data', 'world.topo.json'), os.path.join(ROOT, 'site', 'data', 'detail.topo.json')]
    bad_any = False
    for f in files:
        r = check(f)
        print(os.path.basename(f), 'seats with internal lines:', len(r), 'lines:', sum(len(v) for v in r.values()))
        for sid, v in sorted(r.items()):
            print('  seat', sid, 'n=%d' % len(v), 'total_len=%.2f' % sum(x[0] for x in v), 'longest=%.2f' % max(x[0] for x in v), 'at', tuple(round(c, 1) for c in max(v)[1]))
        bad_any |= bool(r)
    sys.exit(1 if bad_any else 0)
