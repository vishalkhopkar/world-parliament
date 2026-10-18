import pickle
from shapely.geometry import LineString, Point
from shapely.ops import unary_union, polygonize, snap
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt, random
lw=pickle.load(open('lw.pkl','rb'))
use=['path20088','path19496','path20543','path21792','path22021','path20090','Ladakh','Ladakh-1','Jammu_and_Kashmir',
     '_x31_0m-admin-0-breakaway-disputed-areas-with-scale-ranks.46']
ls=[LineString(l) for k in use for l in lw[k]]
ls.append(LineString([(314.6,30.2),(353.6,23.8)]))
ls.append(LineString([(493.1,100.1),(506.3,99.6)]))
# junction path20543 start onto path19496
p19=LineString(lw['path19496'][0]); sp=Point(420.8,51.5); near=p19.interpolate(p19.project(sp)); print('gap to 19496',near.distance(sp))
ls.append(LineString([(420.8,51.5),(near.x,near.y)]))
u=unary_union(ls)
faces=[f for f in polygonize(u) if f.area>5]
pickle.dump(faces,open('faces2.pkl','wb'))
fig,ax=plt.subplots(figsize=(15,12)); random.seed(5)
for k,f in enumerate(faces):
    x,y=f.exterior.xy; ax.fill(x,y,alpha=.45,color=(random.random(),random.random(),random.random()))
    c=f.representative_point(); ax.text(c.x,c.y,str(k),fontsize=10)
ax.set_aspect('equal'); ax.invert_yaxis(); plt.savefig('faces2.png',dpi=75)
for k,f in enumerate(faces): print(k, round(f.area), [round(v) for v in f.bounds])
