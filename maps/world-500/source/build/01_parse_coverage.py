"""Parse coverage_T strings -> build/seats_parsed.json.
Structure per seat: {seat, name, continent, pop, group, countries:[{name, whole, adm1:[{name, whole, adm2:[names]}]}]}
"""
import csv, json, re, sys, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV = os.path.join(ROOT, 'output', 'world_parliament_500_T_K_v2.csv')

def split_top(s, seps):
    """split on any char in seps at paren/bracket depth 0, keeping the delimiter-less pieces"""
    out, buf, d = [], '', 0
    for ch in s:
        if ch in '([': d += 1
        elif ch in ')]': d -= 1
        if ch in seps and d == 0:
            out.append(buf.strip()); buf = ''
        else:
            buf += ch
    out.append(buf.strip())
    return [x for x in out if x]

def split_items(s):
    """split on commas at depth 0, but a comma only terminates an item if the item already ends with ] or )
    (names like 'Bonaire, Sint Eustatius and Saba' contain commas)"""
    pieces = split_top(s, ',')
    items, cur = [], ''
    for p in pieces:
        cur = (cur + ', ' + p) if cur else p
        if cur.endswith(']') or cur.endswith(')'):
            items.append(cur); cur = ''
    if cur: items.append(cur)
    return items

def parse_adm2_list(s):
    s = re.sub(r'\s*ADM2 only\s*$', '', s.strip())
    out = []
    for p in split_top(s, ','):
        p = re.sub(r'\s*\[entire ADM2\]\s*$', '', p).strip()
        if p: out.append(p)
    return out

def parse_country(p, anomalies, seat):
    m = re.match(r'^(.*?)\s*\[entire ADM0\]$', p, re.S)
    if m: return {'name': m.group(1).strip(), 'whole': True, 'adm1': []}
    m = re.match(r'^(.*?)\s*\((.*)\)$', p, re.S)
    if not m:
        anomalies.append((seat, 'country-unparsed', p)); return {'name': p, 'whole': True, 'adm1': []}
    c = {'name': m.group(1).strip(), 'whole': False, 'adm1': []}
    # items may carry a plain list of ADM1 'ADM1 only'?? handle generic
    for it in split_items(m.group(2)):
        mm = re.match(r'^(.*?)\s*\[entire ADM1\]$', it, re.S)
        if mm: c['adm1'].append({'name': mm.group(1).strip(), 'whole': True, 'adm2': []}); continue
        mm = re.match(r'^(.*?)\s*\((.*)\)$', it, re.S)
        if mm:
            kids = mm.group(2)
            if re.search(r'ADM3', kids): anomalies.append((seat, 'adm3', it))
            c['adm1'].append({'name': mm.group(1).strip(), 'whole': False, 'adm2': parse_adm2_list(kids)})
            continue
        anomalies.append((seat, 'adm1-unparsed', it))
        c['adm1'].append({'name': it.strip(), 'whole': True, 'adm2': []})
    return c

def main():
    rows = list(csv.DictReader(open(CSV, encoding='utf-8-sig')))
    anomalies, seats = [], []
    for r in rows:
        cs = [parse_country(p, anomalies, r['seat']) for p in split_top(r['coverage_T'], ';')]
        seats.append({'seat': int(r['seat']), 'name': r['short_name_B'], 'constituency': r['constituency_C'],
                      'continent': r['continent_D'], 'pop': int(r['pop_K'] or 0), 'group': r['group'],
                      'description': r['original_coverage_E'], 'countries': cs})
    json.dump(seats, open(os.path.join(ROOT, 'build', 'seats_parsed.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    n1 = sum(len(c['adm1']) for s in seats for c in s['countries'])
    n2 = sum(len(a['adm2']) for s in seats for c in s['countries'] for a in c['adm1'])
    print(len(seats), 'seats;', sum(len(s['countries']) for s in seats), 'country refs;', n1, 'adm1 refs;', n2, 'adm2 refs')
    print('anomalies:', len(anomalies))
    for a in anomalies[:30]: print(a)
main()
