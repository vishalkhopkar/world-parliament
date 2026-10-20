import os as _os; _HERE=_os.path.dirname(_os.path.abspath(__file__)); BUILD=_os.path.join(_HERE,'..'); SRC=_os.path.join(BUILD,'..')  # maps/<id>/source
import pickle, sys, json
sys.path.insert(0,BUILD)
import numpy as np
from shapely.geometry import shape, Polygon, MultiPolygon
from shapely.ops import unary_union
from geo_common import *
lw=pickle.load(open('lw.pkl','rb'))
faces=pickle.load(open('faces2.pkl','rb'))
a1=attrs(1); r1=reader(1)
def cg(iso,name):
    return [shape(r1.shape(x['i']).__geo_interface__) for x in a1 if x['iso']==iso and x['name']==name]
lad=unary_union(cg('IND','Lad?kh')); hp=unary_union(cg('IND','Him?chal Pradesh'))
print('CGAZ Ladakh bounds',lad.bounds,'HP',hp.bounds)
# SVG: Ladakh-1 and HP rings
svg_lad=np.array(lw['Ladakh-1'][0]); hp_key=[k for k in lw if k.startswith('Himachal')][0]; svg_hp=np.array(lw[hp_key][0])
def sample(g,n=400):
    ring=g.exterior if g.geom_type=='Polygon' else max(g.geoms,key=lambda p:p.area).exterior
    return np.array([ring.interpolate(i/n,normalized=True).coords[0] for i in range(n)])
tgt=np.vstack([sample(lad),sample(hp)])
src=np.vstack([svg_lad,svg_hp])
# initial affine from bbox correspondence of Ladakh-1 and CGAZ Ladakh
def bb(a): return a.min(0),a.max(0)
(s0,s1),(t0,t1)=bb(svg_lad),(np.array(lad.bounds[:2]),np.array(lad.bounds[2:]))
sc=(t1-t0)/(s1-s0); print('init scale',sc)
A=np.array([[sc[0],0,0],[0,-abs(sc[1]),0]],float)
# svg y down -> lat up: lon=a*x+b, lat=c*y+d
A[0,2]=t0[0]-sc[0]*s0[0]; A[1,1]=-abs(sc[1]); A[1,2]=t1[1]+abs(sc[1])*s0[1]
from scipy.spatial import cKDTree
tree=cKDTree(tgt)
def apply(A,p): return np.c_[p,np.ones(len(p))]@A.T
for it in range(30):
    q=apply(A,src); d,i=tree.query(q)
    M=np.c_[src,np.ones(len(src))]
    A,res,_,_=np.linalg.lstsq(M,tgt[i],rcond=None); A=A.T
    if it%10==9: print(it,'rms deg',np.sqrt((d**2).mean()), 'median',np.median(d))
print(A)
np.save('affine.npy',A)
