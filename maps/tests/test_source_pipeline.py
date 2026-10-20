"""Tests of the editing toolkit in maps/<id>/source/build.

- Step 01 (coverage_T parser) needs only the committed CSV: always runs (in a temp copy, nothing in the repo is touched).
- Steps 02 / 05 / 07 need the large git-ignored boundary data (source/GEO, source/data/ne0) or build intermediates
  (build/world_simple.geojson): they are SKIPPED automatically when that data is absent (e.g. in CI) and run locally.
- Step 03 takes 5-10 minutes: opt-in with HP_RUN_SLOW_GEO=1 (and needs the data).
"""
import csv
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from maplib import read_json


def run_py(script, cwd, *args, timeout=1800):
    """Run a pipeline script in isolated mode (python -I) and return the CompletedProcess."""
    return subprocess.run([sys.executable, '-I', str(script), *args], cwd=cwd, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', timeout=timeout)


def need(path, what):
    if not Path(path).exists():
        pytest.skip(f'{what} not present ({path}); needs the large git-ignored data')


def need_modules(*mods):
    for m in mods:
        pytest.importorskip(m)


def has_geo(mapd):
    src = mapd.dir / 'source'
    return all((src / p).exists() for p in ['GEO/geoBoundariesCGAZ_ADM0', 'GEO/geoBoundariesCGAZ_ADM1', 'GEO/geoBoundariesCGAZ_ADM2', 'data/ne0'])


@pytest.fixture
def build_script(mapd):
    def get(name):
        p = mapd.build_dir / name
        if not p.is_file():
            pytest.skip(f'{name} not present for map {mapd.id}')
        return p
    return get


@pytest.fixture
def scratch_map(mapd, tmp_path):
    """A temp copy of maps/<id> with only the committed small files needed by the scripts (site/data, source/build scripts,
    source/output). Scripts derive every path from their own location, so they write inside the copy, not the repo."""
    root = tmp_path / 'maps' / mapd.id
    (root / 'site' / 'data').mkdir(parents=True)
    (root / 'source' / 'build').mkdir(parents=True)
    shutil.copytree(mapd.dir / 'source' / 'output', root / 'source' / 'output', ignore=shutil.ignore_patterns('groups', 'legacy'))
    for f in (mapd.dir / 'site' / 'data').glob('*.json'):
        shutil.copy(f, root / 'site' / 'data' / f.name)
    for f in mapd.build_dir.glob('*.py'):
        shutil.copy(f, root / 'source' / 'build' / f.name)
    return root


# ---------------------------------------------------------------- 01 parse coverage
class TestParseCoverage:
    def test_parses_with_zero_anomalies(self, mapd, scratch_map, build_script):
        build_script('01_parse_coverage.py')
        r = run_py(scratch_map / 'source' / 'build' / '01_parse_coverage.py', scratch_map)
        assert r.returncode == 0, r.stderr
        assert f'{mapd.n} seats' in r.stdout
        assert 'anomalies: 0' in r.stdout, r.stdout

    def test_output_has_one_entry_per_seat_with_territory(self, mapd, scratch_map, build_script):
        build_script('01_parse_coverage.py')
        r = run_py(scratch_map / 'source' / 'build' / '01_parse_coverage.py', scratch_map)
        assert r.returncode == 0, r.stderr
        parsed = read_json(scratch_map / 'source' / 'build' / 'seats_parsed.json')
        assert [p['seat'] for p in parsed] == list(range(1, mapd.n + 1))
        for p in parsed:
            assert p['countries'], f"seat {p['seat']} parsed to nothing"
            for c in p['countries']:
                assert c['name']
                assert c['whole'] or c['adm1'], f"seat {p['seat']}: {c['name']} neither whole nor listing ADM1"

    def test_committed_seats_parsed_is_up_to_date(self, mapd, scratch_map, build_script):
        """build/seats_parsed.json (committed intermediate) must equal a fresh parse of the master CSV."""
        build_script('01_parse_coverage.py')
        committed = mapd.build_dir / 'seats_parsed.json'
        need(committed, 'build/seats_parsed.json')
        r = run_py(scratch_map / 'source' / 'build' / '01_parse_coverage.py', scratch_map)
        assert r.returncode == 0, r.stderr
        fresh = read_json(scratch_map / 'source' / 'build' / 'seats_parsed.json')
        assert fresh == read_json(committed), 'seats_parsed.json is stale: run 01_parse_coverage.py'

    def test_parser_handles_each_coverage_form(self, mapd, tmp_path, build_script):
        """The grammar from AGENT_BRIEF.md: [entire ADM0], [entire ADM1], ADM2-only lists, commas inside names."""
        script = build_script('01_parse_coverage.py')
        root = tmp_path / 'm'
        (root / 'build').mkdir(parents=True)
        (root / 'output').mkdir()
        shutil.copy(script, root / 'build' / script.name)
        cols = ['seat', 'short_name_B', 'constituency_C', 'continent_D', 'original_coverage_E', 'pop_K', 'coverage_T', 'group']
        rows = [
            [1, 'A', 'A', 'Asia', 'x', 1000, 'India (Sikkim [entire ADM1], West Bengal (Darjeeling, Kalimpong ADM2 only)); Bhutan [entire ADM0]', 'G'],
            [2, 'B', 'B', 'Asia', 'x', 2000, 'Bonaire, Sint Eustatius and Saba [entire ADM0]', 'G'],
            [3, 'C', 'C', 'Asia', 'x', 3000, 'Nepal [entire ADM0]', 'G'],
        ]
        with open(root / 'output' / 'world_parliament_500_T_K_v2.csv', 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.writer(f)
            w.writerow(cols)
            w.writerows(rows)
        r = run_py(root / 'build' / script.name, root)
        assert r.returncode == 0, r.stderr
        assert 'anomalies: 0' in r.stdout
        parsed = read_json(root / 'build' / 'seats_parsed.json')
        s1 = parsed[0]['countries']
        assert [c['name'] for c in s1] == ['India', 'Bhutan']
        assert s1[1]['whole'] is True and s1[0]['whole'] is False
        sikkim, wb = s1[0]['adm1']
        assert sikkim == {'name': 'Sikkim', 'whole': True, 'adm2': []}
        assert wb == {'name': 'West Bengal', 'whole': False, 'adm2': ['Darjeeling', 'Kalimpong']}
        assert parsed[1]['countries'][0]['name'] == 'Bonaire, Sint Eustatius and Saba'
        assert parsed[2]['pop'] == 3000

    def test_parser_reports_anomalies_for_malformed_coverage(self, mapd, tmp_path, build_script):
        script = build_script('01_parse_coverage.py')
        root = tmp_path / 'm'
        (root / 'build').mkdir(parents=True)
        (root / 'output').mkdir()
        shutil.copy(script, root / 'build' / script.name)
        cols = ['seat', 'short_name_B', 'constituency_C', 'continent_D', 'original_coverage_E', 'pop_K', 'coverage_T', 'group']
        with open(root / 'output' / 'world_parliament_500_T_K_v2.csv', 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.writer(f)
            w.writerow(cols)
            w.writerow([1, 'A', 'A', 'Asia', 'x', 1000, 'Narnia', 'G'])
        r = run_py(root / 'build' / script.name, root)
        assert r.returncode == 0
        assert 'anomalies: 0' not in r.stdout and 'country-unparsed' in r.stdout


# ---------------------------------------------------------------- committed pipeline outputs
class TestCommittedIntermediates:
    def test_no_unmatched_units(self, mapd):
        """Goal of step 02: unmatched = 0 (header-only unmatched.csv)."""
        p = mapd.build_dir / 'unmatched.csv'
        need(p, 'build/unmatched.csv')
        with open(p, encoding='utf-8-sig', newline='') as f:
            assert list(csv.DictReader(f)) == []

    def test_resolved_covers_every_seat(self, mapd):
        p = mapd.build_dir / 'resolved.json'
        need(p, 'build/resolved.json')
        resolved = read_json(p)
        assert sorted(r['seat'] for r in resolved) == list(range(1, mapd.n + 1))
        for r in resolved:
            assert r['units'], f"seat {r['seat']} resolved to no geometry units"

    def test_aliases_are_valid_json_with_known_keys(self, mapd):
        d = mapd.dir / 'source' / 'data' / 'aliases'
        need(d, 'data/aliases')
        files = sorted(d.glob('*.json'))
        assert files
        for f in files:
            data = read_json(f)
            assert isinstance(data, dict)
            assert set(data) <= {'country', 'adm1', 'adm2', 'adm2_scoped', 'approx', 'expand'}, f'{f.name}: unknown keys {set(data)}'
            assert all(isinstance(v, dict) for v in data.values()), f.name


# ---------------------------------------------------------------- geometry-dependent steps (skipped without the big data)
@pytest.mark.geo
class TestWithGeoData:
    def test_02_resolve_names_matches_everything(self, mapd, build_script):
        """Runs the real step 02 into a scratch tag (build/tmp_pytest, git-ignored) and requires unmatched == 0."""
        script = build_script('02_resolve_names.py')
        if not has_geo(mapd):
            pytest.skip('GEO/ and data/ne0 not present')
        need_modules('shapefile')
        tag = 'pytest'
        out = mapd.build_dir / ('tmp_' + tag)
        try:
            r = run_py(script, mapd.dir / 'source', f'--tag={tag}', timeout=3000)
            assert r.returncode == 0, r.stderr[-2000:]
            assert 'unmatched total 0' in r.stdout, r.stdout[-1500:]
        finally:
            shutil.rmtree(out, ignore_errors=True)

    def test_07_game_map_is_reproducible(self, mapd, scratch_map, build_script):
        """07_game_map.py is deterministic: regenerating game.json from world_simple.geojson must give the committed file."""
        script = build_script('07_game_map.py')
        simple = mapd.build_dir / 'world_simple.geojson'
        need(simple, 'build/world_simple.geojson')
        need_modules('numpy', 'shapely')
        shutil.copy(simple, scratch_map / 'source' / 'build' / 'world_simple.geojson')
        r = run_py(scratch_map / 'source' / 'build' / script.name, scratch_map / 'source', timeout=1800)
        assert r.returncode == 0, (r.stdout + r.stderr)[-2000:]
        fresh = read_json(scratch_map / 'site' / 'data' / 'game.json')
        assert fresh == mapd.game, 'game.json is not what 07_game_map.py produces from the current geometry (stale?)'

    def test_05_build_site_data_preserves_names(self, mapd, scratch_map, build_script):
        """05_build_site_data.py must keep every seat's hand-edited name / name_dev (it preserves them by seat id)."""
        script = build_script('05_build_site_data.py')
        simple = mapd.build_dir / 'world_simple.geojson'
        need(simple, 'build/world_simple.geojson')
        need(mapd.dir / 'source' / 'data' / 'ne0', 'data/ne0')
        need_modules('shapefile', 'shapely')
        b = scratch_map / 'source' / 'build'
        shutil.copy(simple, b / 'world_simple.geojson')
        for f in ['seats_parsed.json', 'resolved.json']:
            need(mapd.build_dir / f, 'build/' + f)
            shutil.copy(mapd.build_dir / f, b / f)
        shutil.copytree(mapd.dir / 'source' / 'data' / 'ne0', scratch_map / 'source' / 'data' / 'ne0')
        r = run_py(b / script.name, scratch_map / 'source', timeout=1800)
        assert r.returncode == 0, (r.stdout + r.stderr)[-2000:]
        fresh = read_json(scratch_map / 'site' / 'data' / 'seats.json')
        committed = {s['id']: s for s in mapd.seats}
        assert len(fresh) == mapd.n
        for s in fresh:
            assert s['name'] == committed[s['id']]['name']
            assert s.get('name_dev') == committed[s['id']].get('name_dev')


@pytest.mark.geo
@pytest.mark.slow
def test_03_build_geometry_runs(mapd, build_script):
    """The 5-10 minute geometry build: opt-in only (HP_RUN_SLOW_GEO=1). Writes build/seats.geojson (git-ignored), so it
    refuses to run if that file exists and was not produced by an earlier opt-in run."""
    if os.environ.get('HP_RUN_SLOW_GEO') != '1':
        pytest.skip('set HP_RUN_SLOW_GEO=1 to run the 5-10 minute geometry build')
    script = build_script('03_build_geometry.py')
    if not has_geo(mapd):
        pytest.skip('GEO/ and data/ne0 not present')
    out = mapd.build_dir / 'seats.geojson'
    backup = None
    if out.exists():
        backup = out.with_suffix('.geojson.pytest-backup')
        shutil.copy(out, backup)
    try:
        r = run_py(script, mapd.dir / 'source', timeout=3600)
        assert r.returncode == 0, (r.stdout + r.stderr)[-2000:]
        gj = json.loads(out.read_text(encoding='utf-8'))
        assert len(gj['features']) == mapd.n
    finally:
        if backup is not None:
            shutil.move(str(backup), str(out))
