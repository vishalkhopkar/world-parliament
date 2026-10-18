# World Parliament – 500 seats

The world split into 500 parliament seats of roughly equal population (~16.6 m each).

- `output/world_parliament_500_T_K_v2.csv` – master seat definitions. `coverage_T` lists, recursively, the ADM0/ADM1/ADM2 units in each seat. This CSV is the source of truth.
- `site/` – static interactive map (zoom, hover, click panel). Serve with `cd site && python -m http.server 8000`.
- `build/` – pipeline: `01_parse_coverage.py` → `02_resolve_names.py` → `03_build_geometry.py` → `04_simplify.sh` → `05_build_site_data.py`. Progress notes in `build/PROGRESS.md`.
- `data/aliases/` – name aliases mapping CSV names to boundary-data names.
- `.claude/skills/name-change/` – skill to rename a seat everywhere.

## Rebuilding the geometry
Needs data not stored here:
- geoBoundaries CGAZ ADM0/ADM1/ADM2 shapefiles in `GEO/geoBoundariesCGAZ_ADM{0,1,2}/`
- Natural Earth 10m `admin_0_map_units` in `data/ne0/`
- Python (shapely, pyshp, numpy) and Node (`npm i mapshaper` in `build/`)

Renaming a seat does not need a rebuild: edit `short_name_B` in the CSV (or use the `name-change` skill) and refresh the page.
