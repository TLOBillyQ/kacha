"""#83 Seedream smoke: top-level `image` array on /v1/images/generations (probe.py confirmed input.messages is dropped).
Usage: SMOKE_MODEL=doubao-seedream-5-0-pro-260628 .venv/bin/python seedream.py <case> [args]
cases: refs <tu|image|tuzh> <n> | region <marked|overlay|bbox|ctl> <run> | limit <count> | burst <concurrency>
"""
from call import *
import os, sys
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw
M=os.environ.get("SMOKE_MODEL","doubao-seedream-5-0-pro-260628")
TAG="pro" if "-pro-" in M else "lite"
FIXED={"watermark":False,"output_format":"png"} if TAG=="pro" else {"watermark":False,"output_format":"png","sequential_image_generation":"disabled"}
SQ="2048x2048"  # 两者总像素范围内
ROW="2400x800" if TAG=="pro" else "3456x1152"  # 3:1，各自总像素下限之上
def gen(name, prompt, images, size):
    b={"model":M,"prompt":prompt,"size":size,"response_format":"url",**FIXED}
    if images: b["image"]=[durl(p) for p in images]
    return run(f"s_{TAG}_{name}", b, path="/v1/images/generations")

REFS=["in/r1_red_circle.png","in/r2_blue_square.png","in/r3_green_triangle.png"]
W={"tu":("本次提供 3 张参考图，按顺序为图1、图2、图3。","图{n}"),
   "image":("This request provides 3 reference images, in order: Image 1, Image 2, Image 3.","Image {n}"),
   "tuzh":("本次提供 3 张参考图，按顺序为图一、图二、图三。","图{z}")}
ZH={1:"一",2:"二",3:"三"}

# 行内 5 个相同蓝方块，目标第 4 个（与 batch3 hard 同一题）
BOX=(40+3*300-30,106,280+3*300+30,406); RW,RH=1536,512
def marked():
    p="in/row_marked.png"; im=Image.open("in/row.png").convert("RGB")
    w=max(2,round(min(RW,RH)*0.005)); ImageDraw.Draw(im).rectangle(BOX, outline=(255,0,0), width=w); im.save(p); return p
def overlay():
    p="in/row_overlay_spec.png"; im=Image.open("in/row.png").convert("RGBA"); l=Image.new("RGBA",im.size,(0,0,0,0))
    ImageDraw.Draw(l).rectangle(BOX, fill=(128,0,255,128)); Image.alpha_composite(im,l).convert("RGB").save(p); return p
def bbox():
    x1,y1,x2,y2=BOX; return f"<bbox>{round(x1/RW*999)} {round(y1/RH*999)} {round(x2/RW*999)} {round(y2/RH*999)}</bbox>"
TASK="把目标方块改成黄色，其余方块和背景保持完全不变。"

case=sys.argv[1]
if case=="refs":
    kind,n=sys.argv[2],int(sys.argv[3]); pre,ref=W[kind]; r=ref.format(n=n,z=ZH[n])
    pr=(f"{pre}只画出{r}里的那个物体，保留它原来的形状和颜色，把它放在深蓝色夜空背景中央。不要出现其他参考图里的物体。" if kind!="image" else
        f"{pre}Draw only the object from {r}, keeping its original shape and color, centered on a dark navy night-sky background. Do not include objects from the other reference images.")
    gen(f"refs_{kind}_{n}", pr, REFS, SQ)
elif case=="region":
    how,k=sys.argv[2],sys.argv[3]
    if how=="marked": gen(f"region_marked_{k}", f"本次提供 1 张参考图。{TASK}只修改图1红框内的区域，其余保持不变，输出图里不要出现红框。", [marked()], ROW)
    elif how=="overlay": gen(f"region_overlay_{k}", "本次提供 2 张参考图，按顺序为图1、图2。图2 是图1 的标注版，紫色半透明高亮标出的区域是要修改的范围。只把图1 中高亮区域内的那个物体改成黄色，其余物体和背景保持完全不变，输出图里不要出现紫色高亮。", ["in/row.png",overlay()], ROW)
    elif how=="bbox": gen(f"region_bbox_{k}", f"本次提供 1 张参考图。{TASK}图1 {bbox()} 区域内按上述要求修改，其余保持不变。", ["in/row.png"], ROW)
    elif how=="ctl": gen(f"region_ctl_{k}", f"本次提供 1 张参考图。只把其中一个方块改成黄色，其余方块和背景保持完全不变。", ["in/row.png"], ROW)
elif case=="limit":
    n=int(sys.argv[2]); os.makedirs("in/small",exist_ok=True); ps=[]
    for i in range(n):
        p=f"in/small/{i}.png"; Image.new("RGB",(256,256),(i*17%256,80,160)).save(p); ps.append(p)
    gen(f"limit_{n}", f"本次提供 {n} 张参考图。把所有参考图的颜色做成一张色卡拼贴。", ps, SQ)
elif case=="burst":
    c=int(sys.argv[2])
    with ThreadPoolExecutor(c) as ex:
        list(ex.map(lambda i: gen(f"burst{c}_{i}", "白色背景上一个红色圆形。", [], SQ), range(c)))
