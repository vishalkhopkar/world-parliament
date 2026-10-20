"""pytest fixtures: every test taking the `mapd` argument runs once per folder maps/<id>/ that has a map.json,
so adding a map automatically adds its checks. Run from game/:  python -I -m pytest ../maps -q"""
import pytest

from maplib import MapData, map_ids


def pytest_generate_tests(metafunc):
    if 'mapd' in metafunc.fixturenames:
        ids = map_ids()
        metafunc.parametrize('mapd', [MapData(i) for i in ids], ids=ids)


@pytest.fixture(scope='session')
def maps_dir():
    from maplib import MAPS_DIR
    return MAPS_DIR
