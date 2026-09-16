from call import *
import os
import sys
M=os.environ.get("SMOKE_MODEL", "qwen-image-3.0-pro")
which=sys.argv[1]
if which=="t1":
    run("q1_t1_single", edit(M, ["in/r1_red_circle.png"], "把背景改成黄色，红色圆形保持不变。"))
elif which=="t2a":
    # multi-turn history: last user message has NO image; relies on assistant turn image
    b1=open("out/q1_t1_single/img0.png","rb")
    msgs=[{"role":"user","content":[{"image":durl("in/r1_red_circle.png")},{"text":"把背景改成黄色，红色圆形保持不变。"}]},
          {"role":"assistant","content":[{"image":durl("out/q1_t1_single/img0.png")}]},
          {"role":"user","content":[{"text":"再把圆形改成正方形，颜色和背景保持不变。"}]}]
    run("q1_t2a_history_noimg", edit(M, [], "再把圆形改成正方形，颜色和背景保持不变。", messages=msgs))
elif which=="t2b":
    msgs=[{"role":"user","content":[{"image":durl("in/r1_red_circle.png")},{"text":"把背景改成黄色，红色圆形保持不变。"}]},
          {"role":"assistant","content":[{"image":durl("out/q1_t1_single/img0.png")}]},
          {"role":"user","content":[{"image":durl("out/q1_t1_single/img0.png")},{"text":"再把圆形改成正方形，颜色和背景保持不变。"}]}]
    run("q1_t2b_history_withimg", edit(M, [], "再把圆形改成正方形，颜色和背景保持不变。", messages=msgs))
elif which=="t2c":
    run("q1_t2c_stateless", edit(M, ["out/q1_t1_single/img0.png"], "把圆形改成正方形，颜色和背景保持不变。"))
elif which=="t2d":
    # two user messages, no assistant: does gateway/upstream reject multi-message at all?
    msgs=[{"role":"user","content":[{"image":durl("in/r1_red_circle.png")},{"text":"把背景改成黄色。"}]},
          {"role":"user","content":[{"text":"把圆形改成正方形。"}]}]
    run("q1_t2d_two_user_msgs", edit(M, [], "把圆形改成正方形。", messages=msgs))
