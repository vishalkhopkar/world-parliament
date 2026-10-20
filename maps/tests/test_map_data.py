"""Checks on the COMMITTED data of every maps/<id>/ folder (no large third-party data needed, runs in CI)."""
import csv
import statistics

import pytest

from maplib import components, map_ids

MANIFEST_KEYS = ['id', 'name', 'description', 'seatCount', 'thumbnail', 'site', 'gamePackage']
POP_MIN, POP_MAX = 12_500_000, 20_800_000      # accepted seat band (CLAUDE.md)
PHASE_KEYS = ['1', '2', '3', '4', '5']


def test_at_least_one_map_exists():
    assert map_ids(), 'no maps/<id>/map.json found'


# ---------------------------------------------------------------- map.json
class TestManifest:
    def test_has_all_fields(self, mapd):
        for k in MANIFEST_KEYS:
            assert k in mapd.manifest and mapd.manifest[k] not in (None, ''), f'map.json: missing {k}'

    def test_id_equals_folder_name(self, mapd):
        assert mapd.manifest['id'] == mapd.id

    def test_types(self, mapd):
        m = mapd.manifest
        assert isinstance(m['seatCount'], int) and not isinstance(m['seatCount'], bool) and m['seatCount'] >= 1
        for k in ['name', 'description', 'thumbnail', 'site', 'gamePackage']:
            assert isinstance(m[k], str) and m[k].strip()

    @pytest.mark.parametrize('key', ['thumbnail', 'site', 'gamePackage'])
    def test_referenced_files_exist(self, mapd, key):
        assert (mapd.dir / mapd.manifest[key]).is_file(), f'{key}: {mapd.manifest[key]} not found'

    def test_thumbnail_is_a_real_image(self, mapd):
        data = (mapd.dir / mapd.manifest['thumbnail']).read_bytes()
        assert data[:3] == b'\xff\xd8\xff' or data[:8] == b'\x89PNG\r\n\x1a\n' or data[:4] == b'RIFF'
        assert len(data) > 1000

    def test_paths_stay_inside_the_map_folder(self, mapd):
        for k in ['thumbnail', 'site', 'gamePackage']:
            p = (mapd.dir / mapd.manifest[k]).resolve()
            assert mapd.dir.resolve() in p.parents

    def test_site_has_the_static_study_site(self, mapd):
        site = mapd.dir / 'site'
        for f in ['index.html', 'app.js', 'style.css', 'data/seats.json', 'data/game.json']:
            assert (site / f).is_file(), f'site/{f} missing'

    def test_site_does_not_depend_on_the_source_toolkit(self, mapd):
        html = (mapd.dir / 'site' / 'index.html').read_text(encoding='utf-8')
        assert '../source' not in html


# ---------------------------------------------------------------- seats.json
class TestSeatsJson:
    def test_count(self, mapd):
        assert len(mapd.seats) == mapd.n

    def test_ids_are_1_to_n_unique(self, mapd):
        ids = [s['id'] for s in mapd.seats]
        assert all(isinstance(i, int) for i in ids)
        assert sorted(ids) == list(range(1, mapd.n + 1))

    def test_names_non_empty_and_unique(self, mapd):
        names = [s['name'] for s in mapd.seats]
        assert all(isinstance(n, str) and n and n.strip() == n for n in names)
        dup = sorted({n for n in names if names.count(n) > 1})
        assert not dup, f'duplicate seat names: {dup}'

    def test_optional_devanagari_name_is_text_when_present(self, mapd):
        for s in mapd.seats:
            if 'name_dev' in s:
                assert isinstance(s['name_dev'], str) and s['name_dev'].strip(), f"seat {s['id']}"

    def test_population_is_positive_int(self, mapd):
        for s in mapd.seats:
            assert isinstance(s['pop'], int) and s['pop'] > 0, f"seat {s['id']}"

    def test_every_seat_lists_its_territory(self, mapd):
        for s in mapd.seats:
            assert s['countries'], f"seat {s['id']} has no countries"
            for c in s['countries']:
                assert c['name']

    def test_average_population_is_plausible(self, mapd):
        avg = sum(s['pop'] for s in mapd.seats) / mapd.n
        assert 5_000_000 < avg < 50_000_000, f'average seat population {avg:,.0f}'


# ---------------------------------------------------------------- game.json
class TestGamePackage:
    def test_seats_sorted_by_id(self, mapd):
        ids = [s['id'] for s in mapd.game['seats']]
        assert ids == sorted(ids)

    def test_map_id_and_counts(self, mapd):
        g = mapd.game
        assert g['mapId'] == mapd.id
        assert g['seatCount'] == mapd.n == len(g['seats'])
        assert isinstance(g['version'], int) and g['version'] >= 1

    def test_seat_ids_match_seats_json(self, mapd):
        assert [s['id'] for s in mapd.game['seats']] == sorted(s['id'] for s in mapd.seats)

    def test_names_match_seats_json(self, mapd):
        names = {s['id']: s['name'] for s in mapd.seats}
        bad = [(s['id'], s['name'], names[s['id']]) for s in mapd.game['seats'] if s['name'] != names[s['id']]]
        assert not bad, f'game.json names differ from seats.json (re-run 07_game_map.py): {bad[:5]}'

    def test_coordinates_are_valid(self, mapd):
        for s in mapd.game['seats']:
            assert -180 <= s['lon'] <= 180 and -90 <= s['lat'] <= 90, f"seat {s['id']}"
            assert isinstance(s['x'], (int, float)) and isinstance(s['y'], (int, float))

    def test_neighbours_reference_existing_distinct_seats(self, mapd):
        ids = {s['id'] for s in mapd.game['seats']}
        for s in mapd.game['seats']:
            assert s['id'] not in s['neighbours'], f"seat {s['id']} lists itself"
            assert len(set(s['neighbours'])) == len(s['neighbours']), f"seat {s['id']} duplicate neighbours"
            assert set(s['neighbours']) <= ids

    def test_neighbours_are_symmetric(self, mapd):
        g = mapd.graph()
        bad = [(a, b) for a, ns in g.items() for b in ns if a not in g[b]]
        assert not bad, f'asymmetric neighbour links: {bad[:10]}'

    def test_neighbour_graph_is_connected(self, mapd):
        g = mapd.graph()
        comps = components(g.keys(), g)
        assert len(comps) == 1, f'{len(comps)} components, sizes {sorted(len(c) for c in comps)}'

    def test_every_seat_has_a_neighbour(self, mapd):
        assert mapd.n == 1 or all(s['neighbours'] for s in mapd.game['seats'])

    def test_phase_groups_keys(self, mapd):
        assert list(mapd.game['phaseGroups'].keys()) == PHASE_KEYS

    @pytest.mark.parametrize('k', [1, 2, 3, 4, 5])
    def test_phase_groups_partition_all_seats(self, mapd, k):
        groups = mapd.game['phaseGroups'][str(k)]
        assert len(groups) == k
        flat = [i for grp in groups for i in grp]
        assert len(flat) == len(set(flat)), 'a seat appears twice'
        assert sorted(flat) == list(range(1, mapd.n + 1))
        assert all(grp for grp in groups), 'empty phase'

    @pytest.mark.parametrize('k', [1, 2, 3, 4, 5])
    def test_phase_group_sizes_within_10_percent(self, mapd, k):
        groups = mapd.game['phaseGroups'][str(k)]
        ideal = mapd.n / k
        for i, grp in enumerate(groups):
            assert abs(len(grp) - ideal) <= 0.10 * ideal + 1e-9, f'phase {i + 1}: {len(grp)} seats vs ideal {ideal:.1f}'

    @pytest.mark.parametrize('k', [1, 2, 3, 4, 5])
    def test_phase_groups_are_contiguous(self, mapd, k):
        g = mapd.graph()
        for i, grp in enumerate(mapd.game['phaseGroups'][str(k)]):
            comps = components(grp, g)
            assert len(comps) == 1, f'k={k} phase {i + 1} splits into {len(comps)} pieces'

    def test_topo_files_exist(self, mapd):
        base = mapd.game_path.parent
        assert (base / mapd.game['topo']['coarse']).is_file()
        if mapd.game['topo'].get('detail'):
            assert (base / mapd.game['topo']['detail']).is_file()


# ---------------------------------------------------------------- topojson
@pytest.fixture(params=['coarse', 'detail'])
def topo(request, mapd):
    if request.param == 'detail' and not mapd.game['topo'].get('detail'):
        pytest.skip('map has no detail topo')
    return mapd.topo(request.param)


class TestTopo:
    def test_geometry_ids_are_1_to_n(self, mapd, topo):
        assert topo['type'] == 'Topology'
        objs = list(topo['objects'].values())
        assert len(objs) == 1
        geoms = objs[0]['geometries']
        ids = [g.get('id') for g in geoms]
        assert sorted(ids) == list(range(1, mapd.n + 1)), 'geometry ids must be exactly the seat numbers'

    def test_every_seat_has_polygon_geometry_with_valid_arcs(self, mapd, topo):
        n_arcs = len(topo['arcs'])
        for g in list(topo['objects'].values())[0]['geometries']:
            assert g['type'] in ('Polygon', 'MultiPolygon'), f"seat {g.get('id')}: {g['type']}"
            assert g['arcs'], f"seat {g.get('id')} has no arcs"

            def walk(a):
                for x in a:
                    if isinstance(x, list):
                        walk(x)
                    else:
                        assert -n_arcs <= x < n_arcs, f"seat {g.get('id')}: arc index {x} out of range"
            walk(g['arcs'])

    def test_properties_seat_matches_id(self, mapd, topo):
        for g in list(topo['objects'].values())[0]['geometries']:
            props = g.get('properties') or {}
            if 'seat' in props:
                assert props['seat'] == g['id']


# ---------------------------------------------------------------- master CSV (source/output)
@pytest.fixture
def rows(mapd):
    path = mapd.master_csv
    if path is None:
        pytest.skip('map has no master CSV')
    with open(path, encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


class TestMasterCsv:
    def test_row_count_and_ids(self, mapd, rows):
        assert len(rows) == mapd.n
        assert [int(r['seat']) for r in rows] == list(range(1, mapd.n + 1))

    def test_required_columns(self, rows):
        for col in ['seat', 'coverage_T', 'pop_K', 'pop_millions', 'pop_flag', 'original_coverage_E', 'group']:
            assert col in rows[0], f'missing column {col}'

    def test_coverage_present(self, rows):
        for r in rows:
            assert r['coverage_T'].strip(), f"seat {r['seat']} has no coverage_T"

    def test_population_columns_agree(self, rows):
        for r in rows:
            assert abs(float(r['pop_millions']) - int(r['pop_K']) / 1e6) < 0.006, f"seat {r['seat']}"

    def test_population_in_band_or_flagged(self, rows):
        """12.5-20.8 m, otherwise pop_flag must start with LOW (below) / HIGH (above) - CLAUDE.md rule."""
        for r in rows:
            pop, flag = int(r['pop_K']), r['pop_flag'].strip().upper()
            if pop < POP_MIN:
                assert flag.startswith('LOW'), f"seat {r['seat']}: {pop:,} is below {POP_MIN:,} but flag is {flag!r}"
            elif pop > POP_MAX:
                assert flag.startswith('HIGH'), f"seat {r['seat']}: {pop:,} is above {POP_MAX:,} but flag is {flag!r}"

    def test_flag_direction_is_sane(self, rows):
        """A LOW flag never sits on a seat above the band and a HIGH flag never on one below it.
        (In-band seats may keep an informational flag, e.g. the Canada seats flagged LOW at 13.6-14.5 m.)"""
        for r in rows:
            pop, flag = int(r['pop_K']), r['pop_flag'].strip().upper()
            if flag.startswith('LOW'):
                assert pop <= POP_MAX, f"seat {r['seat']} flagged LOW with {pop:,}"
            if flag.startswith('HIGH'):
                assert pop >= POP_MIN, f"seat {r['seat']} flagged HIGH with {pop:,}"

    def test_most_seats_are_in_band(self, rows):
        inside = sum(POP_MIN <= int(r['pop_K']) <= POP_MAX for r in rows)
        assert inside / len(rows) >= 0.9

    def test_mean_population_is_near_the_target(self, mapd, rows):
        mean = statistics.mean(int(r['pop_K']) for r in rows)
        target = 16_600_000 if mapd.id == 'world-500' else mean
        assert 0.9 * target < mean < 1.1 * target

    def test_seats_json_population_matches_csv(self, mapd, rows):
        pops = {s['id']: s['pop'] for s in mapd.seats}
        bad = [(r['seat'], r['pop_K'], pops[int(r['seat'])]) for r in rows if int(r['pop_K']) != pops[int(r['seat'])]]
        assert not bad, f'seats.json pop differs from the master CSV (re-run 05_build_site_data.py): {bad[:5]}'


# ---------------------------------------------------------------- the helpers the checks rely on
def test_components_helper():
    g = {1: {2}, 2: {1, 3}, 3: {2}, 4: set(), 5: {6}, 6: {5}}
    assert sorted(map(sorted, components(g, g))) == [[1, 2, 3], [4], [5, 6]]
    assert sorted(map(sorted, components([1, 3], g))) == [[1], [3]]      # induced subgraph: 2 is not in the set
    assert components([], g) == []
