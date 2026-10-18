# Build progress (resume from here)
Plan: C:\Users\visha\.claude\plans\task-create-a-binary-boole.md

## Pipeline steps (orchestrator)
- [x] 01_parse_coverage.py  -> build/seats_parsed.json (500 seats, 0 anomalies)
- [x] 02_resolve_names.py   -> build/resolved.json, build/unmatched.csv (re-run after alias changes)
- [x] 03_build_geometry.py  -> build/seats.geojson
- [x] 04 simplify (mapshaper/topojson) -> site/data/*.topo.json
- [x] 05_build_site_data.py -> site/data/seats.json
- [x] 06 site/index.html + app.js + style.css
- [ ] 07 QA (overlaps, fuzzy review, browser check)

## Alias work (subagents). Status: todo | in-progress | done | blocked(reason)
Each task owns data/aliases/<task>.json ONLY. Verify with:
  python -I build/02_resolve_names.py --tag=<task> --iso=<ISO,ISO>   (reads build/tmp_<task>/unmatched.csv)
| task      | countries (ISO3)                                  | status |
|-----------|---------------------------------------------------|--------|
| A_south_asia | IND NPL BGD AFG                                | done |
| B_east_asia  | CHN PRK KOR MYS PHL MMR RUS AUS                | done |
| C_europe     | DEU ITA POL ESP FRA GBR NLD ROU                | done (ITA/FRA via resolver fallback; DEU-BW Kreise are APPROX at Regierungsbezirk level) |
| D_americas   | CAN MEX ARG COL PER                            | done (1 unresolved: ARG Entre Rios ADM1 absent in CGAZ; use 17 ADM2 departments) |
| E_mena_misc  | VNM IDN TUR IRQ KAZ SYR UZB YEM SAU EGY IRN COD MDG CMR | done |
