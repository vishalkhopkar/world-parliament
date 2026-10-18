import json, os, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SEATS_JSON = os.path.join(ROOT, 'site', 'data', 'seats.json')

def main():
    args = [a for a in sys.argv[1:] if a != '--dry-run']
    dry = '--dry-run' in sys.argv
    if len(args) != 2: sys.exit('usage: rename_seat.py "<seat number or current name>" "<new name>" [--dry-run]')
    key, new = args[0].strip(), args[1].strip()
    if not new: sys.exit('new name is empty')
    data = json.load(open(SEATS_JSON, encoding='utf-8'))
    if key.isdigit(): hits = [s for s in data if str(s['id']) == key]
    else: hits = [s for s in data if s['name'].strip().lower() == key.lower()]
    if len(hits) != 1: sys.exit(f'expected exactly 1 seat for {key!r}, found {len(hits)}' + (': ' + ', '.join(f"{s['id']}={s['name']}" for s in hits) if hits else ''))
    seat = hits[0]; old = seat['name']; sid = str(seat['id'])
    if old == new: sys.exit('new name equals current name; nothing to do')
    others = [s['id'] for s in data if s['name'].strip().lower() == new.lower() and s['id'] != seat['id']]
    if others: print(f'WARNING: name {new!r} is already used by seat(s) {others}')
    seat['name'] = new
    if not dry: json.dump(data, open(SEATS_JSON, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    changed = [os.path.relpath(SEATS_JSON, ROOT)]
    print(('[dry-run] ' if dry else '') + f'Seat {sid}: {old!r} -> {new!r}')
    for c in changed: print('  updated', c)
main()
