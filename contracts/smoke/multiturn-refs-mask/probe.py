"""Probe which request shape the gateway accepts for a seedream model.
Usage: SMOKE_MODEL=doubao-seedream-5-0-lite-260128 .venv/bin/python probe.py <shape>
shapes: gen_t2i | gen_img | edits_msgs | edits_image
"""
from call import *
import os, sys
M=os.environ.get("SMOKE_MODEL","doubao-seedream-5-0-lite-260128")
SIZE=os.environ.get("SMOKE_SIZE","2K")
which=sys.argv[1]
if which=="gen_t2i":
    run(f"p_{M}_gen_t2i", {"model":M,"prompt":"白色背景上一个红色圆形。","size":SIZE,"watermark":False,"response_format":"url"}, path="/v1/images/generations")
elif which=="gen_img":
    run(f"p_{M}_gen_img", {"model":M,"prompt":"把背景改成黄色，红色圆形保持不变。","image":[durl("in/r1_red_circle.png")],"size":SIZE,"watermark":False,"response_format":"url"}, path="/v1/images/generations")
elif which=="edits_msgs":
    run(f"p_{M}_edits_msgs", edit(M, ["in/r1_red_circle.png"], "把背景改成黄色，红色圆形保持不变。", params={"size":SIZE,"watermark":False}))
elif which=="edits_image":
    run(f"p_{M}_edits_image", {"model":M,"prompt":"把背景改成黄色，红色圆形保持不变。","image":[durl("in/r1_red_circle.png")],"size":SIZE,"watermark":False,"response_format":"url"}, path="/v1/images/edits")
