from call import *
import os
import sys
M=os.environ.get("SMOKE_MODEL", "qwen-image-3.0-pro")
which=sys.argv[1]
OV="本次提供 2 张参考图，按顺序为图1、图2。图2 是图1 的标注版，紫色半透明高亮标出的区域是要修改的范围。只把图1 中高亮区域内的物体改成黄色，高亮区域之外的所有内容保持完全不变，输出图里不要出现紫色高亮。"
if which=="ov1": run("q3_overlay_run1", edit(M, ["in/scene.png","in/scene_overlay.png"], OV, params={"size":"1024*1024"}))
elif which=="ov2": run("q3_overlay_run2", edit(M, ["in/scene.png","in/scene_overlay.png"], OV, params={"size":"1024*1024"}))
elif which=="ctl": run("q3_text_only_control", edit(M, ["in/scene.png"], "只把右边的物体改成黄色，其他内容保持完全不变。", params={"size":"1024*1024"}))
elif which=="maskfield":
    # native mask probe: extra input.mask + parameters.mask_image_url; observe accept/reject/ignore
    run("q3_native_mask_field", edit(M, ["in/scene.png"], "把 mask 白色区域内的物体改成黄色，其他内容保持不变。",
        params={"size":"1024*1024","mask_image_url":durl("in/scene_mask.png")}, extra_input={"mask":durl("in/scene_mask.png")}))
elif which=="hard":
    run("q3_overlay_hard_row", edit(M, ["in/row.png","in/row_overlay.png"], "本次提供 2 张参考图，按顺序为图1、图2。图2 是图1 的标注版，紫色半透明高亮标出的区域是要修改的范围。只把图1 中高亮区域内的那个物体改成黄色，其余物体和背景保持完全不变，输出图里不要出现紫色高亮。", params={"size":"1536*512"}))
elif which=="hardctl":
    run("q3_hard_row_no_overlay", edit(M, ["in/row.png"], "只把高亮区域内的那个物体改成黄色，其余物体和背景保持完全不变。", params={"size":"1536*512"}))
