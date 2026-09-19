# 冒烟：多轮消息、参考图序号措辞、高亮叠加

#71 使用的脚本，换模型（如 seedream 系列）时原样重跑。

```bash
cd contracts/smoke/multiturn-refs-mask
python3 -m venv .venv && .venv/bin/pip install pillow
export KACHA_GATEWAY_API_KEY='临时密钥'   # 或写入 .scratch/gateway.key（chmod 600）
export SMOKE_MODEL='seedream-xxx'          # 默认 qwen-image-3.0-pro
.venv/bin/python gen_images.py             # 合成测试图 → in/
.venv/bin/python probe.py gen_img          # seedream 先探请求形态：gen_t2i | gen_img | edits_msgs | edits_image；lite 用 SMOKE_SIZE=2K
.venv/bin/python batch1.py t1              # 结果回灌第 1 轮（t2a/t2c 依赖其输出）
.venv/bin/python batch1.py t2d; .venv/bin/python batch1.py t2a; .venv/bin/python batch1.py t2c
for k in tu image picture tuzh; do for n in 2 3; do .venv/bin/python batch2.py $k $n; done; done
for w in maskfield ov1 ov2 ctl hard hardctl; do .venv/bin/python batch3.py $w; done
.venv/bin/python score.py                  # 主色占比；最终仍需人眼看 out/*/img0.png
# Seedream（#83）：probe.py 已确认 input.messages 被丢弃，改用 seedream.py（顶层 image 数组）
for k in tu image tuzh; do for n in 2 3; do .venv/bin/python seedream.py refs $k $n; done; done
for w in marked overlay bbox; do for r in 1 2; do .venv/bin/python seedream.py region $w $r; done; done; .venv/bin/python seedream.py region ctl 1
.venv/bin/python seedream.py limit 10; .venv/bin/python seedream.py limit 11   # lite 用 14 / 15
.venv/bin/python seedream.py burst 10
```

串行跑：网关并发 6～10 时 429 且无 Retry-After。每次调用把原始响应与出图存 `out/<name>/`，脱敏交互存 `fixtures/<name>.json`；整理进 `contracts/fixtures/<日期>/` 前须再把 `mask` 等非标准字段的 data-URL 替换为 `[REDACTED_IMAGE]`（见 2026-09-16 夹具）。`in/`、`out/`、`fixtures/`、`.venv/` 不入库。
