# world-500 / source - the editing toolkit

Everything needed to change the map (fix geometry, adjust seats, move a territory between seats, internal-division populations)
lives here. None of it is needed to *render* the website (`../site/`). Run all commands from the **repository root**; `M` below is
`maps/world-500`. Always run Python as `python -I` (in `-I` mode call `sys.stdout.reconfigure(encoding='utf-8')` before printing non-ASCII).

## Layout
| Path | What |
|---|---|
| `output/world_parliament_500_T_K_v2.csv` | **Master seat definitions** (500 rows; territory, population, notes). `coverage_T` is a recursive string, e.g. `India (Sikkim [entire ADM1], West Bengal (Darjeeling, Kalimpong ADM2 only)); Bhutan [entire ADM0]`. Grammar in `output/AGENT_BRIEF.md`. |
| `output/groups/`, `output/groups.json`, `output/ISSUES_TO_DISCUSS.md`, `output/legacy/` | First/second-pass working files (per-group derivations and audits, open issues, legacy tables). See `output/legacy/README.md`. |
| `build/` | Pipeline scripts `01`..`07`, `geo_common.py`, `chn_match.py`, `check_internal_lines.py`, `qa_geometry.py`, `india_svg/` (Ladakh claim georeferencing), `package.json` (mapshaper), `PROGRESS.md`, and the intermediates later steps read (`resolved.json`, `seats_parsed.json`, `seats.geojson`, `world_simple.geojson`, `seats_raw.geojson`, `seats_pre03c.geojson`; the big `.geojson` ones are git-ignored). |
| `data/aliases/*.json` | Name aliases CSV -> geometry units (keys `country`, `adm1`, `adm2`, `approx`, `expand`). |
| `data/chn_datav/`, `data/chn_prefec.geojson`, `data/chn_prefec/` | China prefecture-level units (Alibaba DataV, GCJ-02) built by `build/06_chn_prefectures.py`. |
| `data/ladakh_claim_extra.geojson` | Aksai Chin / Shaksgam Valley polygons for seat 88. |
| `data/ne0/`, `data/gadm/` | Natural Earth map units (git-ignored, re-downloadable) and the geoBoundaries API metadata. |
| `GEO/` | geoBoundaries CGAZ ADM0/1/2 (git-ignored, several GB, re-downloadable). |
| `reference/` | `world.svg`, `India_district_map_(de-facto).svg` - reference inputs only. |

Outputs go to `../site/data/` (`world.topo.json`, `detail.topo.json`, `seats.json`, `game.json`).

## What needs a rebuild
- **Rename a seat**: no rebuild. Edit `name` in `../site/data/seats.json` or use the `/name-change` skill
  (`python -I .claude/skills/name-change/rename_seat.py [--map world-500] <seat# or exact name> "<new name>"`). `name_dev`
  (Devanagari, shown under the English name) is not touched by the skill - change it by hand.
- **Territory change** (move a district between seats): back up the CSV (`output/*.bakN.csv`, git-ignored), edit the rows
  (`coverage_T`, `original_coverage_E`, `pop_K`/`pop_millions`, `pop_flag`, `changes_vs_old`, `notes`), then run the pipeline.
  Per-district populations are estimates (2011/2021 census scaled to seat totals); keep pops in 12.5-20.8 m, keep seats contiguous.

## Pipeline (all in `build/`)
1. `01_parse_coverage.py` -> `build/seats_parsed.json` (must report 0 anomalies).
2. `02_resolve_names.py` -> `build/resolved.json`, `unmatched.csv`, `fuzzy_report.csv`. Normalise -> aliases -> affix/prefix/difflib fuzzy. Options `--tag=X --iso=AAA,BBB` (scratch run in `build/tmp_X`). **Goal: unmatched = 0.**
3. `03_build_geometry.py` (5-10 min) -> `build/seats.geojson` (Equal Earth, y down, scale 200) + `geometry_report.txt`.
3b. `03b_clean_geometry.py` (~15 min, 8 processes): morphological closing of every seat (raw copy `seats_raw.geojson`). Needed after every 03 run.
3c. `03c_close_seat_gaps.py` (~10 min): closes narrow land gaps between neighbouring seats (pre-03c copy `seats_pre03c.geojson`; use `--refresh` after every 03b run).
4. `04_simplify.sh` -> `../site/data/world.topo.json` (coarse) and `detail.topo.json` via local `build/node_modules` mapshaper (`cd build && npm i`).
5. `node build/node_modules/mapshaper/bin/mapshaper ../site/data/world.topo.json -o world_simple.geojson format=geojson` (run inside `build/`; used by 05 and 07).
6. `05_build_site_data.py` -> `../site/data/seats.json` (preserves existing `name` / `name_dev` by seat id).
7. `07_game_map.py` -> `../site/data/game.json` + `build/game_map_report.txt` (game package; validation must PASS).
   After this, from `game/`: `npm run gen:maps` if anything structural changed.

Standard rebuild (background, ~30 min), wait for `REBUILD_DONE` in `build/rebuild.log`. **Never run two rebuilds at once.**
```
M=maps/world-500
cp $M/site/data/seats.json $M/source/build/seats.names.backup.json
python -I $M/source/build/01_parse_coverage.py && python -I $M/source/build/02_resolve_names.py
nohup sh -c "python -I $M/source/build/03_build_geometry.py > $M/source/build/rebuild.log 2>&1 && rm -f $M/source/build/seats_raw.geojson && python -I $M/source/build/03b_clean_geometry.py >> $M/source/build/rebuild.log 2>&1 && python -I $M/source/build/03c_close_seat_gaps.py --refresh >> $M/source/build/rebuild.log 2>&1 && sh $M/source/build/04_simplify.sh >> $M/source/build/rebuild.log 2>&1 && (cd $M/source/build && node node_modules/mapshaper/bin/mapshaper ../../site/data/world.topo.json -o world_simple.geojson format=geojson >> rebuild.log 2>&1) && python -I $M/source/build/05_build_site_data.py >> $M/source/build/rebuild.log 2>&1 && python -I $M/source/build/07_game_map.py >> $M/source/build/rebuild.log 2>&1 && echo REBUILD_DONE >> $M/source/build/rebuild.log" &
```
After a rebuild: diff names in `seats.json` against the backup (only the owner's own edits may differ), check `build/geometry_report.txt`
(~8 overlaps, none involving touched seats), unmatched 0, then regenerate the thumbnail if the look changed.

## Geometry data sources
- `GEO/geoBoundariesCGAZ_ADM{0,1,2}` (main source; dbf names are latin-1 mojibake, read with `latin-1`, see `build/geo_common.py`). Old ADM2 vintage -> `approx` aliases map new districts to parents.
- `data/ne0/ne_10m_admin_0_map_units`: tiny territories absent from CGAZ; `pt:` point-marker circles for a few islands.
- China: DataV prefecture layer, clipped by neighbours and the Ladakh claim polygons (`build/chn_match.py`).
- Ladakh / J&K claim: `data/ladakh_claim_extra.geojson`, georeferenced from `reference/India_district_map_(de-facto).svg` with `build/india_svg/*.py`.
- Alias value syntaxes: `cgaz:ISO[+ISO]`, `ne:NAME`, `pt:lat,lon,radius`, `clip:ISO:UnitName:minx,miny,maxx,maxy`, `geo:file:name` (file relative to `source/`).
- Antarctica = CGAZ ADM0 `ATA`, in seat 495.

## Third-party data to re-download if missing
`GEO/` (geoBoundaries CGAZ ADM0/1/2 from geoboundaries.org/globalDownloads.html) and `data/ne0/` (Natural Earth 10m `admin_0_map_units`).
Python needs shapely, pyshp, numpy; Node needs `npm i` in `build/` (mapshaper).
