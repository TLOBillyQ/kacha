"""Dominant saturated colour + rough shape guess per output image."""
import sys, glob, colorsys
from PIL import Image
def score(p):
    im=Image.open(p).convert("RGB").resize((256,256))
    cnt={"red":0,"blue":0,"green":0,"yellow":0,"purple":0}
    for r,g,b in im.getdata():
        h,s,v=colorsys.rgb_to_hsv(r/255,g/255,b/255)
        if s<0.35 or v<0.25: continue
        d=h*360
        if d<20 or d>=340: cnt["red"]+=1
        elif 40<=d<70: cnt["yellow"]+=1
        elif 90<=d<160: cnt["green"]+=1
        elif 200<=d<250: cnt["blue"]+=1
        elif 260<=d<310: cnt["purple"]+=1
    tot=sum(cnt.values()) or 1
    return {k:round(v/tot,2) for k,v in cnt.items() if v/tot>0.02}
for p in sorted(glob.glob(sys.argv[1] if len(sys.argv)>1 else "out/*/img*.png")):
    print(p, score(p))
