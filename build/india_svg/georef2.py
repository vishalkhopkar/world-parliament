import sys, re, numpy as np
sys.path.insert(0,'D:/Projects/world-parliament/build')
from svgelements import SVG, Path, Shape, Move
from shapely.geometry import shape, Polygon
from shapely.ops import unary_union
from geo_common import *
from scipy.spatial import cKDTree
svg = SVG.parse('D:/Projects/world-parliament/India_district_map_(de-facto).svg')
def lines(p, n=6):
    out=[]; cur=[]
    for seg in p:
        if isinstance(seg, Move):
            if len(cur)>2: out.append(cur)
            cur=[(seg.end.x, seg.end.y)]
        elif seg.end is not None:
            try:
                for t in range(1,n+1): q=seg.point(t/n); cur.append((q.x,q.y))
            except Exception: cur.append((seg.end.x,seg.end.y))
    if len(cur)>2: out.append(cur)
    return out
NAMES={'Rajasthan':'R?jasth?n','Uttar_Pradesh':'Uttar Pradesh','Bihar':'Bih?r','Madhya_Pradesh':'Madhya Pradesh','Punjab':'Punjab','Haryana':'Hary?na',
 'Himachal_Pradesh':'Him?chal Pradesh','Uttaranchal':'Uttar?khand','West_Bengal':'West Bengal','Assam':'Assam','Maharashtra':'Mah?r?shtra','Orissa':'Odisha','Karnataka':'Karn?taka','Tamil_Nadu':'Tamil N?du','Kerala':'Kerala','Chhattisgarh':'Chhatt?sgarh','Jharkhand':'Jh?rkhand'}
svgpoly={}
for e in svg.elements():
    if not isinstance(e,Shape) or not e.id: continue
    base=e.id.split('.')[0]
    if base in NAMES and base not in svgpoly:
        p=Path(e); p.reify()
        rings=[Polygon(l) for l in lines(p) if len(l)>3]
        rings=[r.buffer(0) for r in rings]
        if rings: svgpoly[base]=max(rings,key=lambda r:r.area)
a1=attrs(1); r1=reader(1)
cgpoly={}
for k,v in NAMES.items():
    gs=[shape(r1.shape(x['i']).__geo_interface__) for x in a1 if x['iso']=='IND' and x['name']==v]
    if gs: cgpoly[k]=unary_union(gs)
keys=[k for k in svgpoly if k in cgpoly]
S=np.array([[svgpoly[k].centroid.x,svgpoly[k].centroid.y] for k in keys])
T=np.array([[cgpoly[k].centroid.x,cgpoly[k].centroid.y] for k in keys])
M=np.c_[S,np.ones(len(S))]
A,_,_,_=np.linalg.lstsq(M,T,rcond=None); A=A.T
res=np.c_[S,np.ones(len(S))]@A.T-T
for k,r in zip(keys,res): print(k,np.round(r,2))
print(A)
np.save('affine_global.npy',A)
