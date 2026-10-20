import os as _os; _HERE=_os.path.dirname(_os.path.abspath(__file__)); BUILD=_os.path.join(_HERE,'..'); SRC=_os.path.join(BUILD,'..')  # maps/<id>/source
import sys, pickle
from svgelements import SVG, Path, Shape, Move
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union, polygonize
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
svg = SVG.parse(_os.path.join(SRC,'reference','India_district_map_(de-facto).svg'))
KEEP = {'Jammu_and_Kashmir','Ladakh','Ladakh-1','Himachal_Pradesh.10m-admin-1-states-provinces-shp.2628_1_'}
DASH_IDS = {'path3870','path20543','path19496','path20090','path20088','path22021','path21792',
 '_x31_0m-admin-0-breakaway-disputed-areas-with-scale-ranks.44','_x31_0m-admin-0-breakaway-disputed-areas-with-scale-ranks.46','_x31_0m-admin-0-breakaway-disputed-areas-with-scale-ranks.48','_x31_0m-admin-0-breakaway-disputed-areas-with-scale-ranks.30'}
def lines(p, n=8):
    out=[]; cur=[]
    for seg in p:
        if isinstance(seg, Move):
            if len(cur)>1: out.append(cur)
            cur=[(seg.end.x, seg.end.y)]
        elif seg.end is not None:
            try:
                for t in range(1,n+1):
                    q=seg.point(t/n); cur.append((q.x,q.y))
            except Exception: cur.append((seg.end.x,seg.end.y))
    if len(cur)>1: out.append(cur)
    return out
lw={}
for e in svg.elements():
    if not isinstance(e, Shape): continue
    i=e.id or ''
    if i in KEEP or i in DASH_IDS:
        p=Path(e); p.reify(); lw.setdefault(i,[]).extend(lines(p))
pickle.dump(lw,open('lw.pkl','wb'))
ls=[LineString(l) for v in lw.values() for l in v]
u=unary_union(ls)
faces=[f for f in polygonize(u) if f.area>1.0]
print(len(faces))
pickle.dump(faces,open('faces.pkl','wb'))
fig,ax=plt.subplots(figsize=(15,12))
import random; random.seed(2)
for k,f in enumerate(faces):
    x,y=f.exterior.xy; ax.fill(x,y,alpha=.5,color=(random.random(),random.random(),random.random()))
    c=f.representative_point(); ax.text(c.x,c.y,str(k),fontsize=9)
ax.set_aspect('equal'); ax.invert_yaxis()
plt.savefig('faces.png',dpi=80)
for k,f in enumerate(faces): print(k, round(f.area,1), [round(v) for v in f.bounds])
