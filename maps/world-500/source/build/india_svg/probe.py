import os as _os; _HERE=_os.path.dirname(_os.path.abspath(__file__)); BUILD=_os.path.join(_HERE,'..'); SRC=_os.path.join(BUILD,'..')  # maps/<id>/source
import re, sys, json
sys.path.insert(0,BUILD)
from svgelements import SVG, Path, Shape
import numpy as np
svg = SVG.parse(_os.path.join(SRC,'reference','India_district_map_(de-facto).svg'))
items=[]
for e in svg.elements():
    if isinstance(e, Shape) and hasattr(e,'id'):
        try:
            p=Path(e); p.reify()
            bb=p.bbox()
        except Exception: continue
        if bb is None: continue
        st=e.values.get('stroke-dasharray') or ''
        style=e.values.get('style','') or ''
        items.append((e.id, bb, st, style))
print(len(items))
for i,bb,st,style in items:
    if i and (i in ('Ladakh','Ladakh-1','Jammu_and_Kashmir') or 'dasharray:1' in style or st not in ('','none')):
        print(i, [round(v,1) for v in bb], st, ('dash '+re.findall(r'dasharray:([^;]+)',style)[0]) if 'dasharray:1' in style else '')
