import csv, json, os, re, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
MASTER = os.path.join(ROOT, 'output', 'world_parliament_500_T_K_v2.csv')
SEATS_JSON = os.path.join(ROOT, 'site', 'data', 'seats.json')
ISSUES = os.path.join(ROOT, 'output', 'ISSUES_TO_DISCUSS.md')

def read_csv(p):
    rd = csv.DictReader(open(p, encoding='utf-8-sig', newline=''))
    return rd.fieldnames, list(rd)

def write_csv(p, fields, rows):
    w = csv.DictWriter(open(p, 'w', encoding='utf-8-sig', newline=''), fieldnames=fields)
    w.writeheader(); w.writerows(rows)

def main():
    args = [a for a in sys.argv[1:] if a != '--dry-run']
    dry = '--dry-run' in sys.argv
    if len(args) != 2: sys.exit('usage: rename_seat.py "<seat number or current name>" "<new name>" [--dry-run]')
    key, new = args[0].strip(), args[1].strip()
    if not new: sys.exit('new name is empty')
    fields, rows = read_csv(MASTER)
    if key.isdigit(): hits = [r for r in rows if r['seat'] == key]
    else: hits = [r for r in rows if r['short_name_B'].strip().lower() == key.lower()]
    if len(hits) != 1: sys.exit(f'expected exactly 1 seat for {key!r}, found {len(hits)}' + (': ' + ', '.join(f"{r['seat']}={r['short_name_B']}" for r in hits) if hits else ''))
    seat = hits[0]; old = seat['short_name_B']; sid = seat['seat']; group = seat['group']
    if old == new: sys.exit('new name equals current name; nothing to do')
    others = [r['seat'] for r in rows if r['short_name_B'].strip().lower() == new.lower() and r['seat'] != sid]
    if others: print(f'WARNING: name {new!r} is already used by seat(s) {others}')
    changed = []
    seat['short_name_B'] = new
    if not dry: write_csv(MASTER, fields, rows)
    changed.append(os.path.relpath(MASTER, ROOT))
    gp = os.path.join(ROOT, 'output', 'groups', group + '.csv')
    if group and os.path.exists(gp):
        gf, gr = read_csv(gp); n = 0
        for r in gr:
            if r['seat'] == sid: r['short_name_B'] = new; n += 1
        if n:
            if not dry: write_csv(gp, gf, gr)
            changed.append(os.path.relpath(gp, ROOT))
    if os.path.exists(SEATS_JSON):
        data = json.load(open(SEATS_JSON, encoding='utf-8')); n = 0
        for s in data:
            if str(s['id']) == sid: s['name'] = new; n += 1
        if n:
            if not dry: json.dump(data, open(SEATS_JSON, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
            changed.append(os.path.relpath(SEATS_JSON, ROOT))
    if os.path.exists(ISSUES):
        txt = open(ISSUES, encoding='utf-8').read()
        pat = re.compile(r'(Seat %s\s*[—-]\s*)%s' % (re.escape(sid), re.escape(old)))
        t2, n = pat.subn(lambda m: m.group(1) + new, txt)
        if n:
            if not dry: open(ISSUES, 'w', encoding='utf-8', newline='').write(t2)
            changed.append(os.path.relpath(ISSUES, ROOT))
    print(('[dry-run] ' if dry else '') + f'Seat {sid}: {old!r} -> {new!r}')
    for c in changed: print('  updated', c)
main()
