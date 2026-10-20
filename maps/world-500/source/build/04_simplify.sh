#!/bin/sh
# seats.geojson (planar Equal Earth) -> two TopoJSON LODs for the site
cd "$(dirname "$0")"
M=node_modules/mapshaper/bin/mapshaper
node --max-old-space-size=8192 $M seats.geojson -simplify visvalingam 4% keep-shapes -o ../../site/data/world.topo.json format=topojson quantization=20000 id-field=seat
node --max-old-space-size=8192 $M seats.geojson -simplify visvalingam 40% keep-shapes -o ../../site/data/detail.topo.json format=topojson quantization=100000 id-field=seat
ls -la ../../site/data
