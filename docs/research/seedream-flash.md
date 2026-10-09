# Seedream 5.0 Flash 接入与能力依据

2026-10-09：沿用 Lite / Pro 的团队网关接入。完整模型 ID 为 `doubao-seedream-5-0-flash-260915`，独立加入经济档；模型发现与上架清单仍按完整 ID 求交集。

## 官方参数

本次直接重新读取火山引擎文档中心公开接口：

`GET https://www.volcengine.com/api/doc/getDocDetail?LibraryCode=ark&DocumentCode=image-generation-api`

对应[图片生成 API](https://docs.volcengine.com/docs/ark/image-generation-api)，`Result.MDContent` 原始 UTF-8 的 SHA-256：

`e350ac947953b00d7bc42f8e29ca3242687f848b6ff2838a81011827d2ad4b0b`

- 普通生成支持文生图与图片编辑，最多 10 张参考图；单次普通生成产生一张图片。
- 生成尺寸为 1K / 1.5K / 2K，或精确 `WxH`；像素范围 921,600–4,624,220，宽高比 1/16–16。24 项预设像素逐项采用 Flash 官方表，不能复制 Lite 的 2K / 3K / 4K。
- 输入格式 jpeg/png/webp/bmp/tiff/gif/heic/heif，单图不超过 30MB，像素 196–36,000,000，宽高两边均大于 14。Flash 的本地字节上限按保守的十进制 30,000,000 配置。
- 发送 `response_format:"url"`、`output_format:"png"`、`watermark:false`。不发送 Flash 不支持的 `sequential_image_generation`，也不增加未公开的 `n`、`negative_prompt` 或原生 mask 字段。负向提示词继续由发送计划拼入发送文本。
- `background:"transparent"` 只用于单张带 alpha 的参考图，输出必须 PNG。
- 官方支持图上标记、坐标编辑和图层拆分，但本次没有验证这些网关行为，标为 `untested`；图层拆分也不在本次普通单结果接入范围内。

## 当前团队网关实测

夹具：[2026-10-09-team-gateway-flash](../../contracts/fixtures/2026-10-09-team-gateway-flash/manifest.json)。

使用 Kacha 已保存的系统凭据，经 `http://lzxsvn:3001` 发出三次合成图生成，不自动重发。鉴权不落盘，正式夹具不含提示词、输入图片字节、有效结果 URL 或密钥。响应头 `X-New-Api-Version` 为 `v0.0.0`，不据此推断具体部署版本。

| 实测 | 请求与响应 | 图片核对 |
| --- | --- | --- |
| 文生图 | `POST /v1/images/generations`，1024x1024，HTTP 200，`input_images=0`、`generated_images=1`，`data[].url` | 下载为 1024x1024 RGB PNG |
| 高亮叠加编辑 | 顶层有序 `image` data-URL 数组，共 2 张，2400x800；HTTP 200，`input_images=2`、`generated_images=1` | 5 个蓝色方块中仅第 4 个变黄；其他方块仍蓝色，无紫色高亮残留 |
| 透明背景 | 单张 RGBA 参考图、`background:"transparent"`，1536x1536；HTTP 200，`input_images=1`、`generated_images=1` | 下载为 RGBA PNG，alpha 范围 0–255，透明通道真实存在 |

以上支持启用 Seedream 请求形态、普通参考图编辑、英文参考图措辞、高亮叠加区域指示和透明背景。文件格式、单图输入限额及参考图上限的数值依据官方文档；本轮没有逐一发起边界探测，自动化测试验证客户端在提交前执行这些约束，不将其写成网关边界实测。

没有核实后台实际供应商/接入点映射、Lite 的渠道退役安排、限流阈值或生成质量。这些不影响本次按用户指示沿用现有团队网关的 Flash 接入。
