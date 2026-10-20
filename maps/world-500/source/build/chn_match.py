"""Match CSV China names to DataV prefecture units. Shared by resolver and tests."""
import json, os, re, unicodedata
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def norm(s): return re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower())
STOP = ['autonomousprefecture','autonomouscounty','autonomousregion','municipality','prefecture','province','city','league','region','district','county','autonomous','uyghur']
def base(s):
    n = norm(s)
    for w in STOP: n = n.replace(w, '')
    return n
PROV_ALIAS = {'innermongolia': 'neimenggu', 'tibet': 'xizang', 'tibetautonomous': 'xizang', 'ningxiahui': 'ningxia'}
MANUAL = {'luohe':'tahe','urumqi':'wulumuqi','karamay':'kelamayi','bortalamongol':'boertala','ilikazakh':'yili','altay':'aletai','turpan':'tulufan',
 'bayingolinmongol':'bayinguoleng','kizilsukyrgyz':'kezileisukeerkezi','baiyang':'tacheng','xinxing':'hami','yanbiankorean':'yanbianchaoxianzu','kashgar':'kashi','hotan':'hetian','aral':'alaer','tumxuk':'tumushuke','hohhot':'huhehaote',
 'ordos':'eerduosi','bayannur':'bayannaoer','ulanqab':'wulanchabu','alxa':'alashan','hinggan':'xingan','yanbian':'yanbian','ganzitibetan':'ganzi',
 'abatibetanandqiang':'abazangzuqiangzu','gannantibetan':'gannan'}
def load():
    fc = [f for f in json.load(open(os.path.join(ROOT, 'data', 'chn_prefec.geojson'), encoding='utf-8'))['features'] if f['properties']['prov'] not in (810000, 820000)]
    provs = {}
    for f in fc: provs.setdefault(f['properties']['prov'], []).append(f)
    prov_key = {}
    for f in fc:
        p = f['properties']
        if p['prov'] not in prov_key:
            from pypinyin import lazy_pinyin
            z = p['prov_zh']
            for s in ('特别行政区','维吾尔自治区','壮族自治区','回族自治区','自治区','省','市'):
                if z.endswith(s): z = z[:-len(s)]; break
            prov_key[p['prov']] = ''.join(lazy_pinyin(z))
    return fc, provs, prov_key
def find_prov(name, prov_key):
    if base(name) == 'shaanxi': return 610000
    k = PROV_ALIAS.get(base(name), base(name))
    for code, pk in prov_key.items():
        if pk == k: return code
    for code, pk in prov_key.items():
        if pk.startswith(k) or k.startswith(pk): return code
    return None
def find_unit(name, units, manual=None):
    """units: features of one province. returns list of features"""
    k = base(name)
    k = MANUAL.get(k, k)
    exact = [f for f in units if f['properties']['py'] == k]
    if exact: return exact
    pre = [f for f in units if len(k) >= 4 and (f['properties']['py'].startswith(k) or k.startswith(f['properties']['py']))]
    if len(pre) == 1: return pre
    import difflib
    cm = difflib.get_close_matches(k, [f['properties']['py'] for f in units], n=1, cutoff=0.8)
    if cm: return [f for f in units if f['properties']['py'] == cm[0]][:1]
    return []
