import os as _os; _HERE=_os.path.dirname(_os.path.abspath(__file__)); BUILD=_os.path.join(_HERE,'..'); SRC=_os.path.join(BUILD,'..')  # maps/<id>/source
import sys, pickle, numpy as np
sys.path.insert(0,BUILD)
from shapely.geometry import shape
from shapely.ops import unary_union
from geo_common import *
from scipy.spatial import cKDTree
lw=pickle.load(open('lw.pkl','rb'))
a1=attrs(1); r1=reader(1)
def cg(name): return unary_union([shape(r1.shape(x['i']).__geo_interface__) for x in a1 if x['iso']=='IND' and x['name']==name])
def ring(g,n=500):
    r=g.exterior if g.geom_type=='Polygon' else max(g.geoms,key=lambda p:p.area).exterior
    return np.array([r.interpolate(i/n,normalized=True).coords[0] for i in range(n)])
lad=cg('Lad?kh'); hp=cg('Him?chal Pradesh')
tgt=np.vstack([ring(lad),ring(hp)])
hk=[k for k in lw if k.startswith('Himachal')][0]
src=np.vstack([np.array(lw['Ladakh-1'][0]),np.array(lw[hk][0])])
G=np.load('affine_global.npy')
P=np.c_[src,np.ones(len(src))]@G.T
# initial similarity: scale from G, translation by centroid match
s=0.5*(G[0,0]-G[1,1])
tree=cKDTree(tgt)
def fit_sim(src,dst):
    ms,md=src.mean(0),dst.mean(0); a=src-ms; b=dst-md
    H=a.T@b; U,S,Vt=np.linalg.svd(H); R=(U@Vt).T
    if np.linalg.det(R)<0: Vt[-1]*=-1; R=(U@Vt).T
    sc=S.sum()/ (a**2).sum()
    return sc,R,md-sc*(R@ms)
cur=P.copy()
for it in range(60):
    d,i=tree.query(cur)
    sc,R,t=fit_sim(P,tgt[i]); cur=(sc*(R@P.T)).T+t
    if it%15==14: print(it,'rms',np.sqrt((d**2).mean()),'median',np.median(d),'scale rel',sc)
# compose: lonlat = sc*R*(G@[x,y,1]) + t
Ga=np.vstack([G,[0,0,1]]); Sa=np.eye(3); Sa[:2,:2]=sc*R; Sa[:2,2]=t
F=(Sa@Ga)[:2]
np.save('affine.npy',F); print(F)
q=np.c_[src,np.ones(len(src))]@F.T; d,_=tree.query(q); print('final rms deg',np.sqrt((d**2).mean()),'p90',np.percentile(d,90))
