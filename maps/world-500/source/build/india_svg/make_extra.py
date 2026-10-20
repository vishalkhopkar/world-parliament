import os as _os; _HERE=_os.path.dirname(_os.path.abspath(__file__)); BUILD=_os.path.join(_HERE,'..'); SRC=_os.path.join(BUILD,'..')  # maps/<id>/source
import sys, pickle, json, numpy as np
sys.path.insert(0,BUILD)
from shapely.geometry import shape, Polygon, mapping, Point, LineString
from shapely.ops import unary_union
from geo_common import *
F=np.load('affine.npy'); lw=pickle.load(open('lw.pkl','rb')); faces=pickle.load(open('faces2.pkl','rb'))
def tf(a): a=np.array(a); return np.c_[a,np.ones(len(a))]@F.T
# SVG faces: 1 triangle, 2 east Demchok piece, 3 claimed Ladakh/Aksai, 4 purple de-facto Ladakh
byb={tuple(round(v) for v in f.bounds):f for f in faces}
def face(b):
    return byb[b]
tri=face((458,92,506,119)); east=face((567,212,586,249)); brown=face((436,100,574,256)); purple=face((390,139,493,229))
def P(f): return Polygon(tf(list(f.exterior.coords)))
A_svg=unary_union([P(brown),P(tri),P(east)]).buffer(0)
# Shaksgam: Xinjiang ∩ region south of northern dotted line
l19=np.array(lw['path19496'][0]); l205=np.array(lw['path20543'][0])
j=np.argmin(np.hypot(*(l19-np.array([420.8,51.5])).T))
line=np.vstack([l19[:j+1], l205, [[506.3,99.6]]])
ring=np.vstack([line,[[506.3,150],[353.6,150]]])
Pn=Polygon(tf(ring)).buffer(0)
a1=attrs(1); r1=reader(1)
xj=unary_union([shape(r1.shape(x['i']).__geo_interface__) for x in a1 if x['iso']=='CHN' and x['name'].startswith('Xinjiang')])
S=xj.intersection(Pn)
print('Shaksgam area deg2',S.area,'bounds',S.bounds)
# CGAZ units already in other parts of the seat
def cg(iso,name): return unary_union([shape(r1.shape(x['i']).__geo_interface__) for x in a1 if x['iso']==iso and x['name']==name])
lad=cg('IND','Lad?kh'); gb=cg('PAK','Gilgit-Baltistan'); jk=cg('IND','Jammu and Kashm?r')
A=A_svg.difference(lad.buffer(0.02)).difference(jk.buffer(0.02)).difference(gb)
A=A.buffer(0.01).buffer(-0.01)
feats=[{'type':'Feature','properties':{'name':'Aksai Chin'},'geometry':mapping(A)},{'type':'Feature','properties':{'name':'Shaksgam Valley'},'geometry':mapping(S)}]
json.dump({'type':'FeatureCollection','features':feats},open(_os.path.join(SRC,'data','ladakh_claim_extra.geojson'),'w'))
print('A area',A.area,A.bounds)
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
fig,ax=plt.subplots(figsize=(13,11))
for g,c in ((lad,'#bbd'),(gb,'#fcb'),(jk,'#cfc'),(A,'#f66'),(S,'#6c6')):
    for p in (g.geoms if g.geom_type=='MultiPolygon' else [g]):
        x,y=p.exterior.xy; ax.fill(x,y,color=c,alpha=.7,lw=.3,ec='k')
ax.set_xlim(72,82); ax.set_ylim(31,38.5); ax.set_aspect('equal'); ax.grid(True); plt.savefig('extra.png',dpi=75)
