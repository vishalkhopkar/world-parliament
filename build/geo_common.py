import shapefile, re, unicodedata, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def fix(s):
    if s is None: return ''
    try: return s.encode('latin-1').decode('utf-8')
    except Exception: return s
def norm(s):
    s = unicodedata.normalize('NFKD', fix(s)).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r'\b(district|city|province|prefecture|county|region|state|municipality|governorate|department|division)\b', '', s)
    return re.sub(r'[^a-z0-9]', '', s)
def reader(l):
    return shapefile.Reader(os.path.join(ROOT, 'GEO', f'geoBoundariesCGAZ_ADM{l}', f'geoBoundariesCGAZ_ADM{l}'), encoding='latin-1')
def attrs(l):
    r = reader(l)
    out = []
    for i, rec in enumerate(r.iterRecords()):
        d = rec.as_dict()
        out.append({'i': i, 'name': fix(d['shapeName']), 'id': d.get('shapeID', ''), 'iso': d['shapeGroup']})
    return out
