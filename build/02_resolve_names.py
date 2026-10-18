"""Resolve parsed coverage names to geometry units. Outputs build/resolved.json + build/unmatched.csv
Units: {"src":"cgaz","lvl":0|1|2,"i":record index}  or {"src":"ne","i":index in NE map_units}
Usage: python 02_resolve_names.py [GROUP ...]   (limit unmatched report to groups)"""
import json, os, sys, glob, csv, difflib, collections, re, unicodedata
import shapefile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo_common import *

def load_aliases():
    al = {'country': {}, 'adm1': {}, 'adm2': {}, 'approx': {}, 'expand': {}}
    for f in sorted(glob.glob(os.path.join(ROOT, 'data', 'aliases', '*.json'))):
        d = json.load(open(f, encoding='utf-8'))
        for k in al:
            for kk, vv in d.get(k, {}).items():
                if isinstance(vv, dict): al[k].setdefault(kk, {}).update(vv)
                else: al[k][kk] = vv
    return al

def main():
    args = sys.argv[1:]
    tag = next((a[6:] for a in args if a.startswith('--tag=')), None)
    isos_f = set(next((a[6:] for a in args if a.startswith('--iso=')), '').split(',')) - {''}
    groups = set(a for a in args if not a.startswith('--'))
    OUT = os.path.join(ROOT, 'build', 'tmp_' + tag) if tag else os.path.join(ROOT, 'build')
    os.makedirs(OUT, exist_ok=True)
    al = load_aliases()
    a0, a1, a2 = attrs(0), attrs(1), attrs(2)
    nr = shapefile.Reader(os.path.join(ROOT, 'data', 'ne0', 'ne_10m_admin_0_map_units'), encoding='utf-8')
    ne = [{'i': i, 'name': r['NAME'], 'iso': r['ADM0_A3']} for i, r in enumerate(nr.iterRecords())]
    idx0 = {norm(x['name']): x for x in a0}
    iso0 = {x['iso']: x for x in a0}
    idx_ne = collections.defaultdict(list)
    for x in ne: idx_ne[norm(x['name'])].append(x)
    idx1 = collections.defaultdict(lambda: collections.defaultdict(list))
    idx2 = collections.defaultdict(lambda: collections.defaultdict(list))
    for x in a1: idx1[x['iso']][norm(x['name'])].append(x)
    for x in a2: idx2[x['iso']][norm(x['name'])].append(x)
    seats = json.load(open(os.path.join(ROOT, 'build', 'seats_parsed.json'), encoding='utf-8'))
    resolved, unmatched = [], []
    fuzzy_log = []
    AFFIX = ('regency','kabupaten','kota','city','county','district','prefecture','autonomous','municipality','metropolis','metropolitan',
             'special','province','governorate','oblast','raion','rayon','krai','republic','region','of','the','and','zizhiqu','zizhizhou','zhou','shi','xian','qu')
    SUF = ('shi','xian','si','gun','gu','ku','ken','fu','to','do','sh','kreis')
    def n2(name):
        t = re.sub(r'[^a-z0-9 ]', ' ', unicodedata.normalize('NFKD', fix(name)).encode('ascii', 'ignore').decode().lower()).split()
        t = [w for w in t if w not in AFFIX]
        out = ''.join(t)
        for suf in SUF:
            if out.endswith(suf) and len(out) - len(suf) >= 3: out = out[:-len(suf)]; break
        return out
    t2cache = {}
    def table2(table, iso):
        key = (id(table), iso)
        if key not in t2cache:
            d = collections.defaultdict(list)
            for k, recs in table[iso].items():
                for r in recs: d[n2(r['name'])].append(r)
            t2cache[key] = d
        return t2cache[key]
    def lookup(table, iso, name, kind, seat=None):
        n = norm(name)
        amap = al[kind].get(iso, {})
        for k, v in amap.items():
            if norm(k) == n: n = norm(v); break
        c = table[iso].get(n)
        if c: return c
        t2 = table2(table, iso); k2 = n2(name)
        if k2 in t2 and len(k2) >= 3:
            fuzzy_log.append((iso, kind, name, t2[k2][0]['name'], 'affix')); return t2[k2]
        if len(k2) >= 5:
            hits = [k for k in t2 if k.startswith(k2) or k2.startswith(k)]
            hits = [k for k in hits if len(k) >= 5]
            if len(hits) == 1:
                fuzzy_log.append((iso, kind, name, t2[hits[0]][0]['name'], 'prefix')); return t2[hits[0]]
            cm = difflib.get_close_matches(k2, list(t2.keys()), n=2, cutoff=0.88)
            if len(cm) == 1 or (len(cm) == 2 and difflib.SequenceMatcher(None, k2, cm[0]).ratio() - difflib.SequenceMatcher(None, k2, cm[1]).ratio() > 0.05):
                fuzzy_log.append((iso, kind, name, t2[cm[0]][0]['name'], 'difflib')); return t2[cm[0]]
        return []
    def suggest(table, iso, name):
        return difflib.get_close_matches(norm(name), list(table[iso].keys()), n=3, cutoff=0.6)
    def rec_unmatched(seat, lvl, iso, name, parent, cand):
        unmatched.append({'group': seat['group'], 'seat': seat['seat'], 'iso': iso, 'level': lvl, 'parent': parent, 'name': name, 'suggestions': ' | '.join(cand)})
    for s in seats:
        out = {'seat': s['seat'], 'units': [], 'approx': [], 'countries': []}
        for c in s['countries']:
            cname = c['name']; n = norm(cname)
            target = None
            for k, v in al['country'].items():
                if norm(k) == n: target = v; break
            if target is None:
                if n in idx0: target = 'cgaz:' + idx0[n]['iso']
                elif n in idx_ne: target = 'ne:' + idx_ne[n][0]['name']
            if target is None:
                rec_unmatched(s, 0, '?', cname, '', difflib.get_close_matches(n, list(idx0.keys()) + list(idx_ne.keys()), 3, 0.6)); continue
            src, key = target.split(':', 1)
            if src == 'cgaz': a3 = key.split('+')[0]
            else:
                p0 = target.split('+')[0]
                cn0 = idx_ne.get(norm(p0.split(':', 1)[1])) if p0.startswith('ne:') else None
                a3 = cn0[0]['iso'] if cn0 else ''
            out['countries'].append({'name': cname, 'a3': a3})
            if src in ('ne', 'pt'):
                for part in target.split('+'):
                    if part.startswith('pt:'):
                        la, lo, rr = [float(v) for v in part[3:].split(',')]
                        out['units'].append({'src': 'pt', 'lat': la, 'lon': lo, 'r': rr, 'label': cname}); continue
                    cand = idx_ne.get(norm(part.split(':', 1)[1]))
                    if not cand: rec_unmatched(s, 0, '?', cname, 'ne alias ' + part, []); continue
                    out['units'].append({'src': 'ne', 'i': cand[0]['i'], 'label': cname})
                if not c['whole'] and c['adm1']: rec_unmatched(s, 1, key, '(NE-sourced country has sub-units)', cname, [])
                continue
            isos = key.split('+')
            if c['whole']:
                for iso in isos:
                    if iso in iso0: out['units'].append({'src': 'cgaz', 'lvl': 0, 'i': iso0[iso]['i'], 'label': cname})
                    else: rec_unmatched(s, 0, iso, cname, '', [])
                continue
            iso = isos[0]
            for a in c['adm1']:
                cand = lookup(idx1, iso, a['name'], 'adm1')
                if not cand:
                    ex = next((v for k, v in al['expand'].get(iso, {}).items() if norm(k) == norm(a['name'])), None)
                    if ex and a['whole']:
                        for d in ex['adm2']:
                            cd = idx2[iso].get(norm(d), [])
                            if cd: out['units'].append({'src': 'cgaz', 'lvl': 2, 'i': [x['i'] for x in cd], 'adm1': [], 'bbox': ex['bbox'], 'label': d})
                            else: rec_unmatched(s, 2, iso, d, a['name'] + ' (expand)', suggest(idx2, iso, d))
                        continue
                    # fallback 1: CGAZ has this unit one level lower (e.g. Italy regions are ADM2)
                    c2 = lookup(idx2, iso, a['name'], 'adm2')
                    if c2 and a['whole']:
                        out['units'].append({'src': 'cgaz', 'lvl': 2, 'i': [x['i'] for x in c2], 'adm1': [], 'label': a['name']}); continue
                    if c2 and not a['whole']:
                        for d in a['adm2']:
                            cd = lookup(idx2, iso, d, 'adm2')
                            if cd: out['units'].append({'src': 'cgaz', 'lvl': 2, 'i': [x['i'] for x in cd], 'adm1': [], 'label': d})
                            else: rec_unmatched(s, 2, iso, d, a['name'], suggest(idx2, iso, d))
                        continue
                    # fallback 2: Natural Earth map unit of that name (e.g. French Guiana)
                    cn = idx_ne.get(norm(a['name']))
                    if cn and a['whole']:
                        out['units'].append({'src': 'ne', 'i': cn[0]['i'], 'label': a['name']}); continue
                    rec_unmatched(s, 1, iso, a['name'], cname, [iso1 for iso1 in suggest(idx1, iso, a['name'])]); continue
                if a['whole']:
                    out['units'] += [{'src': 'cgaz', 'lvl': 1, 'i': x['i'], 'label': a['name']} for x in cand]
                    continue
                a1i = [x['i'] for x in cand]
                for d in a['adm2']:
                    ap = al['approx'].get(iso, {})
                    cd = lookup(idx2, iso, d, 'adm2')
                    if not cd:
                        # approximate: parent district named in aliases.approx
                        for k, v in ap.items():
                            if norm(k) == norm(d):
                                cd = idx2[iso].get(norm(v), []); 
                                if cd: out['approx'].append({'name': d, 'parent': v})
                                break
                    if not cd:
                        rec_unmatched(s, 2, iso, d, a['name'], suggest(idx2, iso, d)); continue
                    u = {'src': 'cgaz', 'lvl': 2, 'i': [x['i'] for x in cd], 'adm1': a1i, 'label': d}
                    out['units'].append(u)
        resolved.append(out)
    with open(os.path.join(OUT, 'fuzzy_report.csv'), 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f); w.writerow(['iso', 'level', 'csv_name', 'matched_to', 'how']); w.writerows(sorted(set(fuzzy_log)))
    print('fuzzy matches (review build/fuzzy_report.csv):', len(set(fuzzy_log)))
    json.dump(resolved, open(os.path.join(OUT, 'resolved.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    um = [u for u in unmatched if (not groups or u['group'] in groups) and (not isos_f or u['iso'] in isos_f)]
    with open(os.path.join(OUT, 'unmatched.csv'), 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=['group', 'seat', 'iso', 'level', 'parent', 'name', 'suggestions']); w.writeheader(); w.writerows(um)
    by = collections.Counter((u['group'], u['level']) for u in um)
    print('unmatched total', len(um), 'by level', collections.Counter(u['level'] for u in um))
    print('by group', collections.Counter(u['group'] for u in um).most_common())
main()
