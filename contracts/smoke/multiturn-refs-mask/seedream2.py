"""#83 follow-up: multi-region rendering comparison, transparent background, layer-decomposition probe.
Usage: SMOKE_MODEL=... .venv/bin/python seedream2.py multi <overlay|marked|bbox> <run> | transparent <run> | layers <variant>
"""
from call import *
import os, sys
from PIL import Image, ImageDraw
M=os.environ.get("SMOKE_MODEL","doubao-seedream-5-0-pro-260628")
TAG="pro" if "-pro-" in M else "lite"
FIXED={"watermark":False,"output_format":"png"} if TAG=="pro" else {"watermark":False,"output_format":"png","sequential_image_generation":"disabled"}
ROW="2400x800" if TAG=="pro" else "3456x1152"
RW,RH=1536,512
def box(i): return (40+i*300-30,106,280+i*300+30,406)
A,B=box(1),box(3)  # 区域1 紫 → 第 2 个方块改红；区域2 黄 → 第 4 个方块改绿
PURPLE,YELLOW=(128,0,255),(255,220,0)
def gen(name, body_extra, prompt, images, size):
    b={"model":M,"prompt":prompt,"size":size,"response_format":"url",**FIXED,**body_extra}
    if images: b["image"]=[durl(p) for p in images]
    return run(f"t_{TAG}_{name}", b, path="/v1/images/generations")
def bb(x): x1,y1,x2,y2=x; return f"<bbox>{round(x1/RW*999)} {round(y1/RH*999)} {round(x2/RW*999)} {round(y2/RH*999)}</bbox>"
EDIT="紫色区域内的方块改成红色，黄色区域内的方块改成绿色，其余方块和背景保持完全不变。"
case=sys.argv[1]
if case=="multi":
    how,k=sys.argv[2],sys.argv[3]
    if how=="overlay":
        p="in/row_overlay_multi.png"; im=Image.open("in/row.png").convert("RGBA"); l=Image.new("RGBA",im.size,(0,0,0,0)); d=ImageDraw.Draw(l)
        d.rectangle(A,fill=PURPLE+(128,)); d.rectangle(B,fill=YELLOW+(128,)); Image.alpha_composite(im,l).convert("RGB").save(p)
        gen(f"multi_overlay_{k}",{},"本次提供 2 张参考图，按顺序为图1、图2。"+EDIT+"图2 是图1 的标注版，紫色、黄色半透明高亮标出的是要修改的区域。只修改图1 中高亮区域内的内容，高亮区域之外的所有内容保持完全不变，输出图里不要出现任何高亮颜色。",["in/row.png",p],ROW)
    elif how=="marked":
        p="in/row_marked_multi.png"; im=Image.open("in/row.png").convert("RGB"); d=ImageDraw.Draw(im); w=max(2,round(min(RW,RH)*0.005))
        d.rectangle(A,outline=PURPLE,width=w); d.rectangle(B,outline=YELLOW,width=w); im.save(p)
        gen(f"multi_marked_{k}",{},"本次提供 1 张参考图。紫色框内的方块改成红色，黄色框内的方块改成绿色，其余方块和背景保持完全不变。只修改图1 彩色框内的区域，其余保持不变，输出图里不要出现框线。",[p],ROW)
    elif how=="bbox":
        gen(f"multi_bbox_{k}",{},f"本次提供 1 张参考图。图1 {bb(A)} 区域内的方块改成红色，图1 {bb(B)} 区域内的方块改成绿色，其余方块和背景保持完全不变。",["in/row.png"],ROW)
elif case=="transparent":
    k=sys.argv[2]; p="in/alpha_circle.png"
    im=Image.new("RGBA",(1024,1024),(0,0,0,0)); ImageDraw.Draw(im).ellipse((262,262,762,762),fill=(220,30,30,255)); im.save(p)
    extra={"background":"transparent"} if k!="ctl" else {}
    gen(f"transparent_{k}",extra,"本次提供 1 张参考图。把图1 的红色圆形改成蓝色圆形，保持背景透明。",[p],"2048x2048")
elif case=="layers":
    v=sys.argv[2]
    extra={"a":{"layer_decomposition":True},"b":{"layer_decomposition":"enabled"},"c":{"layer_decomposition":{"enabled":True}}}[v]
    gen(f"layers_{v}",extra,"本次提供 1 张参考图。把图1 拆分为图层。",["in/scene.png"],"2048x2048")
