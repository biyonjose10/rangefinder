"""
Does Rangefinder rank fires on FOREST, or on land that was already cleared?

Samples ESA WorldCover 10m (2021) around each ranked target. WorldCover predates
the fires by five years, which is exactly the baseline we want: if a target was
already cropland or grassland in 2021, a fire there in 2026 is agricultural
burning, not deforestation.
"""
import json, urllib.request, math, collections
import rasterio
from rasterio.windows import from_bounds

BASE = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map"
CLASSES = {10:"Tree cover",20:"Shrubland",30:"Grassland",40:"Cropland",50:"Built-up",
           60:"Bare/sparse",70:"Snow/ice",80:"Water",90:"Herb. wetland",95:"Mangrove",100:"Moss"}

def tile_for(lat, lon):
    # tiles are 3x3 degrees, named by SW corner
    la = math.floor(lat/3)*3
    lo = math.floor(lon/3)*3
    ns = f"{'S' if la<0 else 'N'}{abs(la):02d}"
    ew = f"{'W' if lo<0 else 'E'}{abs(lo):03d}"
    return f"ESA_WorldCover_10m_2021_v200_{ns}{ew}_Map.tif"

targets = json.load(urllib.request.urlopen(
    "https://rangefinder-cyan.vercel.app/api/targets", timeout=90))["targets"]

HALF = 0.01  # ~1.1 km box around the cluster centroid
print(f"{'rank':>4} {'id':>5} {'score':>6} {'n':>4}  {'dominant land cover (2021)':<26} {'%tree':>6}  pa")
print("-"*82)

summary = []
for i, t in enumerate(targets[:10], 1):
    lat, lon = t["lat"], t["lon"]
    url = f"/vsicurl/{BASE}/{tile_for(lat,lon)}"
    try:
        with rasterio.open(url) as src:
            w = from_bounds(lon-HALF, lat-HALF, lon+HALF, lat+HALF, src.transform)
            arr = src.read(1, window=w)
        vals = collections.Counter(arr.flatten().tolist())
        total = sum(vals.values())
        top, topn = vals.most_common(1)[0]
        tree = 100*vals.get(10,0)/total if total else 0
        summary.append((i, t["id"], tree, CLASSES.get(top,top)))
        print(f"{i:>4} {t['id']:>5} {t['score']:>6.1f} {t['count']:>4}  "
              f"{CLASSES.get(top,str(top)):<26} {tree:>5.1f}%  {t['protectedArea'] or '-'}")
    except Exception as e:
        print(f"{i:>4} {t['id']:>5}  ERROR {type(e).__name__}: {str(e)[:60]}")

if summary:
    forested = [s for s in summary if s[2] >= 50]
    print("-"*82)
    print(f"targets >=50% tree cover in 2021: {len(forested)} of {len(summary)}")
    print(f"mean tree cover across top {len(summary)}: {sum(s[2] for s in summary)/len(summary):.1f}%")
