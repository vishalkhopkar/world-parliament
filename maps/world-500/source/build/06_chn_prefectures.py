"""DataV GeoJSON (province files) -> data/chn_prefec.geojson with pinyin keys. Prefecture-level units, replaces CGAZ's county-level China ADM2."""
import json, os, re, glob
from pypinyin import lazy_pinyin
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
prov = {f['properties']['adcode']: f['properties']['name'] for f in json.load(open(os.path.join(ROOT, 'data/chn_datav/100000_full.json'), encoding='utf-8'))['features'] if f['properties']['name']}
def py(s): return ''.join(lazy_pinyin(s))
SUF = ['特别行政区','维吾尔自治区','壮族自治区','回族自治区','自治区','省','市','自治州','地区','盟','自治县','县','区','林区','特区']
def strip_zh(n):
    for s in SUF:
        if n.endswith(s) and len(n) > len(s): return n[:-len(s)]
    return n
feats = []
for code, pn in prov.items():
    if code in (710000,): continue
    fp = os.path.join(ROOT, 'data/chn_datav/%d_full.json' % code)
    if not os.path.exists(fp): continue
    d = json.load(open(fp, encoding='utf-8'))
    for f in d['features']:
        p = f['properties']
        if not p.get('name'): continue
        feats.append({'type': 'Feature', 'properties': {'zh': p['name'], 'adcode': p['adcode'], 'prov': code, 'prov_zh': pn,
                      'py': py(strip_zh(p['name'])), 'py_full': py(p['name'])}, 'geometry': f['geometry']})
json.dump({'type': 'FeatureCollection', 'features': feats}, open(os.path.join(ROOT, 'data/chn_prefec.geojson'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(feats), 'units;', len(prov), 'provinces')
