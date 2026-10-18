import sys, pickle, numpy as np
sys.path.insert(0,'D:/Projects/world-parliament/build')
from shapely.geometry import shape
from shapely.ops import unary_union
from geo_common import *
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
F=np.load('affine.npy'); lw=pickle.load(open('lw.pkl','rb')); faces=pickle.load(open('faces2.pkl','rb'))
def tf(a): a=np.array(a); return np.c_[a,np.ones(len(a))]@F.T
a1=attrs(1); r1=reader(1)
fig,ax=plt.subplots(figsize=(13,11))
for x in a1:
    if x['iso'] in ('IND','PAK','CHN') and x['name'] in ('Lad?kh','Him?chal Pradesh','Jammu and Kashm?r','Gilgit-Baltistan','Azad Kashmir','Xinjiang Uyghur Autonomous Region'):
        g=shape(r1.shape(x['i']).__geo_interface__)
        for p in (g.geoms if g.geom_type=='MultiPolygon' else [g]): 
            xs,ys=p.exterior.xy; ax.plot(xs,ys,'b-',lw=1)
for k,v in lw.items():
    for l in v:
        t=tf(l); ax.plot(t[:,0],t[:,1],'r--' if 'path' in k or 'disputed' in k else 'g-',lw=.8)
ax.set_xlim(72,82); ax.set_ylim(31,39); ax.set_aspect('equal'); ax.grid(True)
plt.savefig('overlay.png',dpi=80)
