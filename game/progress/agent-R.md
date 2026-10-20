# Agent R - repo restructure (maps/ + game/), 2026-10-20

## Done
- `site/`, `build/`, `data/`, `output/`, `GEO/`, reference SVGs, legacy tables moved to `maps/world-500/{site,source}` (git mv for tracked files).
  New: `maps/README.md`, `maps/world-500/{map.json, thumbnail.jpg, source/README.md, source/output/legacy/README.md}`.
- Pipeline scripts: ROOT stays = `maps/world-500/source` (structure inside kept); 05/07/04_simplify.sh/check_internal_lines.py write to `../site/data`;
  india_svg scripts use paths relative to their file; 07 sets mapId from the folder name, topo paths relative to data/; 05 keeps `name_dev` right after `name`
  and writes a trailing newline so seats.json diffs stay empty.
- `.claude/skills/name-change`: `--map <id>` (default world-500).
- Game: map id `world` -> `world-500` (WORLD_CONFIG, MAP_CONFIGS, DEFAULT_MAP_ID, server default, web, e2e, sim, tests); `configForMap()`;
  `scripts/gen-maps.ts` + `npm run gen:maps` (pretest) -> `shared/src/maps.generated.ts`, `server/src/maps.generated.ts`;
  server core/aws/local use `makeRegistryMapProvider`; new test `server/test/mapRegistry.test.ts`.
- Web: vite plugin `hp-maps` (dev `/maps/**`, build copies `maps/<id>/{map.json,thumbnail.*,site/**}`), `map/mapData.ts` URL helpers (`mapDataUrl`, `gamePackageUrl`, `get/setActiveMapId`), mock.ts/client.ts use them.
- Infra: Web stack no longer deploys separate map data (dist contains /maps), cache behaviour `maps/*`, `MAP_BASE_URL` -> `/maps`. Workflows: game-deploy triggers `game/**`, `maps/**` + registry-up-to-date check; pages deploys `maps/world-500/site`.

## Deleted
output/*.bak*.csv (12), output/world_parliament_500_T_K.csv, output/seats_input.csv, build/*.log, qa_*.json/log, *.before_clean.json, detail_simple.geojson,
seats.json.bak, seats.names.backup.json, india_svg/*.png + crop.html, all __pycache__, root ne_10m_admin_1_states_provinces/ + 3 ne_10m_*.zip (no script reads them), data/ne0/map_units.zip (duplicate of extracted shapefile).

## Notes
- bots e2e: 2 checks FAIL ("seat report refused: INSUFFICIENT_FUNDS" for Bot1) - bot script assumes a larger budget than the designer's W₹25 crore cut; unrelated to the move.
- An old `python -m http.server 8000` (cwd = old root `site/`) still holds the empty root `site/` dir open; stop it and delete `site/`.
