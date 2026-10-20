"""Helpers shared by the maps tests: loading the COMMITTED data of one maps/<id>/ folder, graph utilities."""
import json
from pathlib import Path

MAPS_DIR = Path(__file__).resolve().parent.parent


def map_ids():
    return sorted(p.name for p in MAPS_DIR.iterdir() if p.is_dir() and (p / 'map.json').is_file())


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


class MapData:
    def __init__(self, map_id):
        self.id = map_id
        self.dir = MAPS_DIR / map_id
        self._cache = {}

    def _memo(self, key, fn):
        if key not in self._cache:
            self._cache[key] = fn()
        return self._cache[key]

    @property
    def manifest(self):
        return self._memo('manifest', lambda: read_json(self.dir / 'map.json'))

    @property
    def seats(self):
        return self._memo('seats', lambda: read_json(self.dir / 'site' / 'data' / 'seats.json'))

    @property
    def game_path(self):
        return self.dir / self.manifest['gamePackage']

    @property
    def game(self):
        return self._memo('game', lambda: read_json(self.game_path))

    def topo(self, kind):
        rel = self.game['topo'].get(kind)
        assert rel, f'game.json topo.{kind} missing'
        return self._memo('topo_' + kind, lambda: read_json(self.game_path.parent / rel))

    @property
    def n(self):
        return self.manifest['seatCount']

    @property
    def master_csv(self):
        """The master seat CSV in source/output (world-500: world_parliament_500_T_K_v2.csv) or None."""
        found = sorted((self.dir / 'source' / 'output').glob('*_T_K*.csv'))
        return found[0] if found else None

    @property
    def build_dir(self):
        return self.dir / 'source' / 'build'

    def graph(self):
        return self._memo('graph', lambda: {s['id']: set(s['neighbours']) for s in self.game['seats']})


def components(nodes, graph):
    """Connected components of the subgraph of `graph` ({id: set(neighbour ids)}) induced by `nodes`."""
    nodes = set(nodes)
    seen, comps = set(), []
    for start in sorted(nodes):
        if start in seen:
            continue
        comp, stack = set(), [start]
        while stack:
            u = stack.pop()
            if u in comp:
                continue
            comp.add(u)
            stack.extend(v for v in graph.get(u, ()) if v in nodes and v not in comp)
        seen |= comp
        comps.append(comp)
    return comps
