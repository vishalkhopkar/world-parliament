"""Game map package: <map>/site/data/game.json (+ build/game_map_report.txt).

Inputs : build/world_simple.geojson (projected seat polygons), <map>/site/data/seats.json (names, continents)
Outputs: seat centroids (projected + lon/lat via inverse Equal Earth), neighbour graph (land adjacency + ferry links so
         the graph is connected), phase groupings for k = 1..5 (balanced, contiguous, compact; ordered east -> west).
Deterministic. Exits non-zero if validation fails.
"""
import json, os, sys, math, time, collections
import numpy as np
from shapely.geometry import shape
from shapely.ops import nearest_points
from shapely.strtree import STRtree

sys.stdout.reconfigure(encoding='utf-8')
T0 = time.time()
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # maps/<id>/source
MAP_DIR = os.path.dirname(ROOT)                                      # maps/<id>
MAP_ID = os.path.basename(MAP_DIR)                                   # e.g. world-500
SITE_DATA = os.path.join(MAP_DIR, 'site', 'data')
OUT_DIR = SITE_DATA
os.makedirs(OUT_DIR, exist_ok=True)
REPORT = []
def rep(s=''):
    REPORT.append(s)

# ------------------------------------------------------------------ Equal Earth (same constants as 03_build_geometry.py)
SCALE = 200.0
A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
SQ3 = math.sqrt(3)
def eq_fwd(lon, lat):
    lam = np.radians(np.asarray(lon, float)); phi = np.radians(np.asarray(lat, float))
    th = np.arcsin(SQ3 / 2 * np.sin(phi)); t2 = th * th; t6 = t2 ** 3
    x = 2 * SQ3 * lam * np.cos(th) / (3 * (9 * A4 * t6 * t2 + 7 * A3 * t6 + 3 * A2 * t2 + A1))
    y = th * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))
    return x * SCALE, -y * SCALE
def eq_inv(px, py):
    X = np.asarray(px, float) / SCALE; Y = -np.asarray(py, float) / SCALE
    th = Y / A1                                   # starting guess
    for _ in range(50):
        t2 = th * th; t6 = t2 ** 3
        f = th * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)) - Y
        fp = A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)
        d = f / fp; th = th - d
        if np.max(np.abs(d)) < 1e-15: break
    t2 = th * th; t6 = t2 ** 3
    phi = np.arcsin(np.clip(2 / SQ3 * np.sin(th), -1, 1))
    lam = 3 * X * (9 * A4 * t6 * t2 + 7 * A3 * t6 + 3 * A2 * t2 + A1) / (2 * SQ3 * np.cos(th))
    return np.degrees(lam), np.degrees(phi)
def haversine(lon1, lat1, lon2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(a))
def unitvec(lon, lat):
    lo, la = np.radians(lon), np.radians(lat)
    return np.column_stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])

# round-trip check on a grid
glon, glat = np.meshgrid(np.linspace(-179.9, 179.9, 121), np.linspace(-89.9, 89.9, 61))
gx, gy = eq_fwd(glon.ravel(), glat.ravel()); rl, rp = eq_inv(gx, gy)
rt_err = float(max(np.max(np.abs(rl - glon.ravel())), np.max(np.abs(rp - glat.ravel()))))

# ------------------------------------------------------------------ load
seats_meta = {s['id']: s for s in json.load(open(os.path.join(SITE_DATA, 'seats.json'), encoding='utf-8'))}
gj = json.load(open(os.path.join(ROOT, 'build', 'world_simple.geojson'), encoding='utf-8'))
ids = [f['properties']['seat'] for f in gj['features']]
order = sorted(range(len(ids)), key=lambda i: ids[i])
ids = [ids[i] for i in order]
geoms = [shape(gj['features'][i]['geometry']) for i in order]
geoms = [g if g.is_valid else g.buffer(0) for g in geoms]
N = len(ids); idx = {s: i for i, s in enumerate(ids)}

# ------------------------------------------------------------------ centroids
cx = np.array([g.centroid.x for g in geoms]); cy = np.array([g.centroid.y for g in geoms])
clon, clat = eq_inv(cx, cy)
outside = [ids[i] for i in range(N) if not geoms[i].contains(geoms[i].centroid)]

# ------------------------------------------------------------------ adjacency (same logic as 05_build_site_data.py)
bg = [g.buffer(0.4).simplify(0.1) for g in geoms]
tree = STRtree(bg); adj = [set() for _ in range(N)]
for a, g in enumerate(bg):
    for b in tree.query(g):
        if b != a and g.intersects(bg[b]): adj[a].add(int(b)); adj[b].add(a)
land_edges = sum(len(s) for s in adj) // 2

def components(adjl, nodes=None):
    nodes = list(range(N)) if nodes is None else list(nodes); ns = set(nodes); seen = set(); comps = []
    for s in nodes:
        if s in seen: continue
        c = [s]; seen.add(s); st = [s]
        while st:
            u = st.pop()
            for v in adjl[u]:
                if v in ns and v not in seen: seen.add(v); c.append(v); st.append(v)
        comps.append(c)
    return comps

# ------------------------------------------------------------------ ferry links (Boruvka over components, min polygon distance)
land_comps = components(adj)
ferries = []   # (i, j, km)
def comp_labels():
    lab = [0] * N
    for ci, c in enumerate(components(adj)):
        for s in c: lab[s] = ci
    return lab
rounds = 0
while True:
    comps = components(adj)
    if len(comps) == 1: break
    rounds += 1
    lab = [0] * N
    for ci, c in enumerate(comps):
        for s in c: lab[s] = ci
    best = {}   # comp -> (dist, i, j)
    for ci, c in enumerate(comps):
        others = [s for s in range(N) if lab[s] != ci]
        t = STRtree([geoms[s] for s in others])
        for s in c:
            j = int(t.nearest(geoms[s]))
            d = geoms[s].distance(geoms[others[j]])
            if ci not in best or d < best[ci][0]: best[ci] = (d, s, others[j])
    # union-find to avoid cycles within the round
    parent = list(range(len(comps)))
    def find(x):
        while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for ci, (d, s, o) in sorted(best.items(), key=lambda kv: kv[1][0]):
        a, b = find(ci), find(lab[o])
        if a == b: continue
        parent[a] = b
        p, q = nearest_points(geoms[s], geoms[o])
        lo, la = eq_inv([p.x, q.x], [p.y, q.y])
        km = haversine(lo[0], la[0], lo[1], la[1])
        adj[s].add(o); adj[o].add(s); ferries.append((s, o, km))
assert len(components(adj)) == 1
# Explicit extra ferry links (seat id, seat id, description), added on top of the minimum-distance links above.
# 463 Quebec-Greenland (contains Greenland + Iceland) <-> 403 Celtic Isles (Ireland, Scotland, Wales, N. Ireland): the North Atlantic
# chain Greenland-Iceland-Faroe-Scotland. Without it the Americas hang off the rest of the world only by the Bering link
# (Pacific Northwest <-> Siberia East), which forces snake-shaped phase groups.
EXTRA_FERRY = [(463, 403, 'North Atlantic (Greenland/Iceland - Scotland)')]
extra_added = []
for a_id, b_id, why in EXTRA_FERRY:
    a, b = idx[a_id], idx[b_id]
    if b in adj[a]: continue
    p, q = nearest_points(geoms[a], geoms[b])
    lo, la = eq_inv([p.x, q.x], [p.y, q.y])
    km = haversine(lo[0], la[0], lo[1], la[1])
    adj[a].add(b); adj[b].add(a); ferries.append((a, b, km)); extra_added.append((a, b, km, why))

# ------------------------------------------------------------------ phase groups
V = unitvec(clon, clat)
def kmeans(k, seed, restarts=30, iters=100):
    rng = np.random.RandomState(seed); best = None
    for _ in range(restarts):
        cen = [V[rng.randint(N)]]
        for _ in range(k - 1):
            d2 = np.min(((V[:, None, :] - np.array(cen)[None]) ** 2).sum(2), axis=1)
            cen.append(V[rng.choice(N, p=d2 / d2.sum())])
        cen = np.array(cen)
        for _ in range(iters):
            lab = np.argmax(V @ cen.T, axis=1)
            new = np.array([V[lab == c].mean(0) if np.any(lab == c) else cen[c] for c in range(k)])
            new /= np.linalg.norm(new, axis=1)[:, None]
            if np.allclose(new, cen): break
            cen = new
        lab = np.argmax(V @ cen.T, axis=1)
        inertia = float(np.sum(1 - np.max(V @ cen.T, axis=1)))
        if best is None or inertia < best[0]: best = (inertia, lab.copy())
    return best[1]

def group_centroids(lab, k):
    cen = np.zeros((k, 3))
    for c in range(k):
        m = V[lab == c].mean(0) if np.any(lab == c) else np.zeros(3)
        n = np.linalg.norm(m); cen[c] = m / n if n > 0 else m
    return cen

def connected_without(lab, g, removed):
    mem = [s for s in range(N) if lab[s] == g and s != removed]
    return len(mem) > 0 and len(components(adj, mem)) == 1

def partition(k):
    if k == 1: return np.zeros(N, int)
    lab = kmeans(k, seed=20260 + k)
    # contiguity repair: re-home non-main fragments to the neighbouring group they touch most
    for _ in range(200):
        changed = False
        for g in range(k):
            comps = components(adj, [s for s in range(N) if lab[s] == g])
            if len(comps) <= 1: continue
            comps.sort(key=len, reverse=True)
            for frag in comps[1:]:
                cnt = collections.Counter(lab[v] for s in frag for v in adj[s] if lab[v] != g)
                lab[frag] = cnt.most_common(1)[0][0]; changed = True
        if not changed: break
    # balancing: move a boundary seat (plus any fragment that would be cut off from its group, which travels with it)
    # from a larger group to a smaller adjacent group; every move strictly reduces the sum of squared group sizes.
    def move_set(lab, g, s):
        rest = [v for v in range(N) if lab[v] == g and v != s]
        if not rest: return None
        comps = sorted(components(adj, rest), key=len, reverse=True)
        return [s] + [v for c in comps[1:] for v in c]
    for _ in range(5000):
        size = np.bincount(lab, minlength=k); cen = group_centroids(lab, k); cands = []
        for s in range(N):
            g = lab[s]
            for h in {lab[v] for v in adj[s]} - {g}:
                diff = size[g] - size[h]
                if diff < 2: continue
                cost = float(np.arccos(np.clip(V[s] @ cen[h], -1, 1)) - np.arccos(np.clip(V[s] @ cen[g], -1, 1)))
                cands.append(((cost, -diff), s, h))
        cands.sort(); done = False
        for key, s, h in cands:
            ms = move_set(lab, lab[s], s)
            if ms is None or len(ms) >= size[lab[s]] - size[h]: continue
            lab[ms] = h; done = True; break
        if not done: break
    # compactness polish: swap-free single moves that reduce distance-to-centroid without unbalancing (sizes stay within +-1 of ideal band)
    lo_b, hi_b = math.floor(N / k), math.ceil(N / k)
    for _ in range(20):
        moved = False
        cen = group_centroids(lab, k); size = np.bincount(lab, minlength=k)
        for s in range(N):
            g = lab[s]
            if size[g] - 1 < lo_b: continue
            for h in sorted({lab[v] for v in adj[s]} - {g}):
                if size[h] + 1 > hi_b: continue
                if np.arccos(np.clip(V[s] @ cen[h], -1, 1)) + 0.02 < np.arccos(np.clip(V[s] @ cen[g], -1, 1)) and connected_without(lab, g, s):
                    lab[s] = h; size[g] -= 1; size[h] += 1; moved = True; break
        if not moved: break
    return lab

def lon_mean(members):
    m = V[members].mean(0)
    return math.degrees(math.atan2(m[1], m[0])), math.degrees(math.atan2(m[2], math.hypot(m[0], m[1])))

phase_groups = {}; group_info = {}
for k in range(1, 6):
    lab = partition(k)
    groups = [[s for s in range(N) if lab[s] == g] for g in range(k)]
    # phase 1 = most easterly: order by circular mean longitude, descending (+180 east first -> west)
    groups.sort(key=lambda m: -lon_mean(m)[0])
    phase_groups[str(k)] = [[ids[s] for s in m] for m in groups]
    group_info[k] = groups

# ------------------------------------------------------------------ build output
seats_out = []
for i, sid in enumerate(ids):
    seats_out.append({'id': sid, 'name': seats_meta[sid]['name'], 'lon': round(float(clon[i]), 4), 'lat': round(float(clat[i]), 4),
                      'x': round(float(cx[i]), 3), 'y': round(float(cy[i]), 3), 'neighbours': sorted(ids[j] for j in adj[i])})
pkg = {'mapId': MAP_ID, 'version': 1, 'seatCount': N, 'seats': seats_out, 'phaseGroups': phase_groups,
       'topo': {'coarse': 'world.topo.json', 'detail': 'detail.topo.json'}}
out_path = os.path.join(OUT_DIR, 'game.json')
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(pkg, f, ensure_ascii=False, separators=(',', ':'))

# ------------------------------------------------------------------ validation
errs = []
def check(c, msg):
    if not c: errs.append(msg)
check(len(seats_out) == 500 and N == 500, 'seat count != 500')
check([s['id'] for s in seats_out] == list(range(1, 501)), 'ids not 1..500')
check(all(s['name'] == seats_meta[s['id']]['name'] for s in seats_out), 'names differ from seats.json')
nb = {s['id']: set(s['neighbours']) for s in seats_out}
check(all(a not in nb[a] for a in nb), 'self-loop')
check(all(a in nb[b] for a in nb for b in nb[a]), 'asymmetric neighbours')
idadj = [[idx[v] for v in nb[s]] for s in ids]
check(len(components(idadj)) == 1, 'graph not connected')
for k in range(1, 6):
    gs = phase_groups[str(k)]
    check(len(gs) == k, f'k={k}: wrong number of groups')
    flat = [s for g in gs for s in g]
    check(sorted(flat) == list(range(1, 501)), f'k={k}: seats not partitioned exactly once')
    for g in gs:
        check(abs(len(g) - 500 / k) <= 0.10 * 500 / k, f'k={k}: group size {len(g)} outside +-10%')
        check(len(components(idadj, [idx[s] for s in g])) == 1, f'k={k}: group not contiguous')

# ------------------------------------------------------------------ report
rep('HUNG PARLIAMENT game map report  (build/07_game_map.py)')
rep(f'seats: {N}   land-adjacency edges: {land_edges}   ferry links added: {len(ferries)}   total edges: {sum(len(s) for s in adj)//2}')
rep(f'land-graph components before ferry links: {len(land_comps)}  (Boruvka rounds: {rounds})')
rep(f'inverse Equal Earth round-trip max error over 121x61 grid: {rt_err:.3e} deg  ({"OK" if rt_err < 1e-6 else "FAIL"})')
check(rt_err < 1e-6, 'round-trip error >= 1e-6')
rep(f'seats whose area centroid lies outside their polygon ({len(outside)}): ' + ', '.join(f'{s} {seats_meta[s]["name"]}' for s in outside))
rep(); rep('FERRY LINKS (seat A <-> seat B, approx km between closest boundary points)')
for s, o, km in sorted(ferries, key=lambda t: t[2]):
    rep(f'  {ids[s]:>3} {seats_meta[ids[s]]["name"]}  <->  {ids[o]:>3} {seats_meta[ids[o]]["name"]}   {km:7.0f} km')
rep('Explicit EXTRA_FERRY links: ' + '; '.join(f'{ids[a]}<->{ids[b]} {km:.0f} km ({w})' for a, b, km, w in extra_added))
rep(); rep('PHASE GROUPS  (ordered east -> west by circular mean longitude: phase 1 = most easterly, since polling across the world')
rep('naturally starts in the east and follows the time zones westward)')
for k in range(1, 6):
    rep(f'\nk = {k}   target {500/k:.1f} per group   sizes {[len(g) for g in group_info[k]]}')
    for pi, m in enumerate(group_info[k], 1):
        cc = collections.Counter(seats_meta[ids[s]]['continent'] for s in m).most_common(3)
        lo, la = lon_mean(m); cen = unitvec([lo], [la])[0]
        near = sorted(m, key=lambda s: -(V[s] @ cen))[:3]
        contig = len(components(adj, m)) == 1
        rep(f'  phase {pi}: {len(m)} seats, contiguous={contig}, mean lon/lat {lo:.1f}/{la:.1f}; ' +
            ', '.join(f'{c} {n}' for c, n in cc) + '; e.g. ' + ', '.join(seats_meta[ids[s]]['name'] for s in near))
rep(); rep('VALIDATION: ' + ('PASSED' if not errs else 'FAILED'))
for e in errs: rep('  - ' + e)
rep(f'runtime {time.time()-T0:.1f}s')
with open(os.path.join(ROOT, 'build', 'game_map_report.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(REPORT) + '\n')
print('\n'.join(REPORT[:6]))
print('validation', 'PASSED' if not errs else 'FAILED: ' + '; '.join(errs))
sys.exit(1 if errs else 0)
