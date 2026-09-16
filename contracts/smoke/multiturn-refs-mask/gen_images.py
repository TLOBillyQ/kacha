from PIL import Image, ImageDraw
import os
os.makedirs("in", exist_ok=True)
S = 1024
def blank(): return Image.new("RGB", (S, S), "white")
def circle(im, c, box): ImageDraw.Draw(im).ellipse(box, fill=c)
def square(im, c, box): ImageDraw.Draw(im).rectangle(box, fill=c)
def tri(im, c, box):
    x0,y0,x1,y1 = box; ImageDraw.Draw(im).polygon([((x0+x1)//2,y0),(x0,y1),(x1,y1)], fill=c)
mid = (212,212,812,812)
r1=blank(); circle(r1,(220,30,30),mid); r1.save("in/r1_red_circle.png")
r2=blank(); square(r2,(30,60,220),mid); r2.save("in/r2_blue_square.png")
r3=blank(); tri(r3,(30,170,60),mid); r3.save("in/r3_green_triangle.png")
# scene for mask test: red circle left, blue square right
sc=blank(); circle(sc,(220,30,30),(80,312,480,712)); square(sc,(30,60,220),(544,312,944,712)); sc.save("in/scene.png")
ov=sc.convert("RGBA"); layer=Image.new("RGBA",(S,S),(0,0,0,0)); ImageDraw.Draw(layer).rectangle((512,250,1000,780), fill=(160,32,240,110))
Image.alpha_composite(ov,layer).convert("RGB").save("in/scene_overlay.png")
mk=Image.new("RGB",(S,S),"black"); ImageDraw.Draw(mk).rectangle((512,250,1000,780), fill="white"); mk.save("in/scene_mask.png")
print("ok")
# hard overlay case: 5 identical blue squares in a row, highlight the 4th
h=Image.new("RGB",(1536,512),"white"); d=ImageDraw.Draw(h)
for i in range(5): d.rectangle((40+i*300,136,280+i*300,376), fill=(30,60,220))
h.save("in/row.png")
ho=h.convert("RGBA"); l=Image.new("RGBA",h.size,(0,0,0,0)); ImageDraw.Draw(l).rectangle((40+3*300-30,106,280+3*300+30,406), fill=(160,32,240,110))
Image.alpha_composite(ho,l).convert("RGB").save("in/row_overlay.png")
