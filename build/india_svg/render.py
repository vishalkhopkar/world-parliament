import sys
from svgelements import SVG, Path, Shape
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
svg = SVG.parse('D:/Projects/world-parliament/India_district_map_(de-facto).svg')
want = {'Jammu_and_Kashmir':'tab:blue','Ladakh':'tab:green','Ladakh-1':'tab:orange','Himachal_Pradesh.10m-admin-1-states-provinces-shp.2628_1_':'tab:gray'}
fig, ax = plt.subplots(figsize=(14,12))
def pts(p, n=6):
    out=[]; cur=[]
    for seg in p:
        from svgelements import Move, Close
        if isinstance(seg, Move):
            if len(cur)>1: out.append(cur)
            cur=[(seg.end.x, seg.end.y)]
        elif seg.end is not None:
            try:
                for t in range(1,n+1): q=seg.point(t/n); cur.append((q.x,q.y))
            except Exception: cur.append((seg.end.x,seg.end.y))
    if len(cur)>1: out.append(cur)
    return out
for e in svg.elements():
    if not isinstance(e, Shape): continue
    i=e.id or ''
    try: p=Path(e); p.reify(); bb=p.bbox()
    except Exception: continue
    if bb is None: continue
    if not (bb[2]>300 and bb[0]<600 and bb[3]<280 and bb[1]>20): continue
    if i in want or 'disputed' in i or i.startswith('path2') or i.startswith('path3870'):
        dashed = 'dasharray:1' in (e.values.get('style') or '') or (e.values.get('stroke-dasharray') not in (None,'none'))
        for line in pts(p):
            xs,ys=zip(*line)
            c=want.get(i,'red' if dashed else 'black')
            ax.plot(xs,ys,color=c,lw=0.8 if i not in want else 1.2, ls='--' if dashed else '-')
ax.set_aspect('equal'); ax.invert_yaxis(); ax.grid(True, alpha=.3)
plt.savefig('D:/Projects/world-parliament/build/india_svg/ladakh.png', dpi=90)
