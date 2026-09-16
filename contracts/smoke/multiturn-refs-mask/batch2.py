from call import *
import os
import sys
M=os.environ.get("SMOKE_MODEL", "qwen-image-3.0-pro")
REFS=["in/r1_red_circle.png","in/r2_blue_square.png","in/r3_green_triangle.png"]
W={
 "tu":   ("本次提供 3 张参考图，按顺序为图1、图2、图3。", "图{n}"),
 "image":("This request provides 3 reference images, in order: Image 1, Image 2, Image 3.", "Image {n}"),
 "picture":("This request provides 3 reference images, in order: Picture 1, Picture 2, Picture 3.", "Picture {n}"),
 "tuzh": ("本次提供 3 张参考图，按顺序为图一、图二、图三。", "图{z}"),
}
ZH={1:"一",2:"二",3:"三"}
def prompt(kind,n):
    pre,ref=W[kind]; r=ref.format(n=n,z=ZH[n])
    if kind in("tu","tuzh"):
        return f"{pre}只画出{r}里的那个物体，保留它原来的形状和颜色，把它放在深蓝色夜空背景中央。不要出现其他参考图里的物体。"
    return f"{pre}Draw only the object from {r}, keeping its original shape and color, centered on a dark navy night-sky background. Do not include objects from the other reference images."
kind,n=sys.argv[1],int(sys.argv[2])
run(f"q2_{kind}_{n}", edit(M, REFS, prompt(kind,n), params={"size":"1024*1024","watermark":False}))
