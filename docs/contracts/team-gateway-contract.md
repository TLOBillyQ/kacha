# 团队网关契约

本目录保存通过团队网关真实交互获得的脱敏契约夹具。夹具验证器只接受明确记录的实测结果，不根据 OpenAI、DashScope 或其他厂商文档推断路径和载荷。

## 适配器实现状态

以下为 v1 适配器 `src/ugc_image_tool/team_gateway.py`（已归档于 `archive/v1` 分支）依据本目录夹具实现的行为；v2 客户端 `client/src/core/gateway.ts` 同样以本目录夹具为准：

- **模型发现**：`GET /v1/models`，`Authorization: Bearer` 鉴权；`data[].id` 作为模型 ID 交给本地能力表合并，未知模型保持禁用。
- **文生图**：`POST /v1/images/generations`，仅发送实测字段 `model`、`prompt`、`negative_prompt`、`n`、`size`（`WxH`）、`watermark`。
- **图片编辑**：`POST /v1/images/edits`，JSON 编码（`Content-Type: application/json`）。顶层字段为 `model`、`prompt`（网关 `binding:required`，必填，即使已提供 `input`）、`parameters`、`input`。参考图编码为 data-URL，按顺序作为 `input.messages[0].content` 的多个 `image` 项，提示词作为末尾 `text` 项；提示词发送前由客户端注入数量与顺序前缀（如「本次提供 2 张参考图，按顺序为图1、图2。」），让用户提示词里的「图1/图2」有确定所指；`parameters.size` 必须用「宽*高」星号格式（如 `1024*1024`，透传路径不做 `x`→`*` 转换，与文生图顶层 `size` 的 `WxH` 习惯不同），出图数量放 `parameters.n`，水印放 `parameters.watermark`。能力边界：参考图 1～3 张（2026-08-29 实测 1 与 2 张，2026-08-31 实测 3 张采纳 `input_image_count=3`）、`n` ≤ 5（2026-08-31 实测 3 与 5，`output_image_count` 与 choice 内图数一致）。成功响应以 `metadata.output.choices[].message.content[].image` 为出图真源保存，并检测顶层 `data` 数量不一致。
- **错误映射**：401 → 鉴权失败；429 → 网关限流（可操作提示，不依赖 `Retry-After`）；4xx → 网关拒绝；5xx → 网关服务错误；连接失败 → 网络不可达（任务状态为结果未知）。
- **重试**：模型列表等只读请求由发现层有限重试；生成请求不自动重发，契约未确认幂等键，不使用稳定任务 ID 重试。
- **保持关闭（未实测）**：生成请求的幂等键、运行中取消、任务查询和 `Retry-After`。这些能力在真实交互验证前不向网关发出。
- **负向提示词**：按能力表 `supports_negative_prompt` 分流。qwen 系列走原生字段：文生图顶层 `negative_prompt`，图片编辑 `input.negative_prompt`（2026-08-31 实测网关接受、HTTP 200 正常出图，见 `contracts/fixtures/2026-08-31-team-gateway-edit-boundaries/`；约束强度未经视觉验证），不并入文本。Seedream 系列无原生字段，负向以「避免出现：」/「Avoid: 」拼在提示词之后、区域固定句之前。

## 当前结论

截至 2026-08-31，以下契约已在内网主机 `http://lzxsvn:3001`（new-api，2026-08-29 为 v1.0.0-rc.27 官方零补丁，2026-08-31 上游已升级、版本号未重新核对）真实验证；文生图与模型列表夹具保存于 `contracts/fixtures/2026-08-17-team-gateway/`，JSON 图片编辑夹具保存于 `contracts/fixtures/2026-08-29-team-gateway-edit-json/`，编辑边界（3 张参考图、n=3/5、原生负向提示词）夹具保存于 `contracts/fixtures/2026-08-31-team-gateway-edit-boundaries/`：

- 鉴权使用 `Authorization` 头；无效密钥返回 401 和 `new_api_error`。
- 模型列表为 `GET /v1/models`，返回 `data` 模型数组和 `success: true`。
- 文生图为 `POST /v1/images/generations`，使用 `model`、`prompt`、`negative_prompt`、`n`、`size`（`WxH`）和 `watermark` 字段；成功返回临时 `url`，并在元数据中返回图片内容。
- 图片编辑为 `POST /v1/images/edits`，编码为 JSON 而非 multipart；multipart 路径已被 JSON data-URL 编码取代。
- 编辑透传实测：`parameters.size=1024*1024` 使 800x400（2:1）输入输出为 1024x1024 方形（尺寸生效）；双参考图响应 `input_image_count=2`（两张参考图均被采纳）；`parameters.n=2` 响应 `output_image_count=2`（出图数量生效）。
- 出图真源是 `metadata.output.choices[].message.content[].image`；`n>1` 时上游把多张图放进同一个 choice 的 `message.content`，网关顶层 `data` 仅产出一条且 `data[0].url` 被覆盖成最后一张，顶层 `data` 视图在 `n>1` 时丢图，客户端不得依赖它统计出图数量。实测 metadata 图片为临时地址（URL）而非 base64，解析须同时兼容两种形态。
- 已验证模型仅为 `qwen-image-3.0-pro`；列表中的其他模型不得启用。

部分失败、幂等键、运行中取消、任务查询和可靠 `Retry-After` 没有得到足够的真实证据，均记录为 `unknown`，客户端不得依赖这些行为。顶层 `data` 与元数据输出数量不一致只能证明响应视图不可靠，不能证明网关提供了可依赖的部分失败语义，适配器必须将其视为未知结果并保守处理。`parameters.n` 经网关按百炼 `usage.image_count` 结算，JSON 透传不会造成漏计费。

未实测（如实标注）：非法或不支持的 size 档位报错形态；JSON 路径失败场景的错误映射是否与 multipart 一致；其余模型的图片编辑；`input.negative_prompt` 对出图效果的实际约束强度（协议层已实测接受，需人工视觉对比）。

## 2026-09-16 冒烟：多轮消息、序号措辞与高亮叠加

夹具保存于 `contracts/fixtures/2026-09-16-team-gateway-multiturn-refs-mask/`（仅 `qwen-image-3.0-pro`，合成几何图形）：

- **多轮消息不可用**：`input.messages` 放两条 user 消息或含 assistant 角色均返回 HTTP 400（上游明确「only supports single-turn conversation」）。多轮修改只能结果回灌：上一轮结果图作为参考图重新提交，无状态单轮即可累计效果。
- **参考图序号措辞**：3 张参考图下「图N」「Image N」「Picture N」「图N（汉字）」各测序号 2 与 3，8/8 命中。客户端默认改写为「图N」/「Image N」并保留数量顺序前缀。
- **无原生 mask**：`input.mask` 与 `parameters.mask_image_url` 被网关与上游静默忽略（HTTP 200，整图改色）；百炼文档亦无 mask/区域参数。
- **高亮叠加有效**：原图 + 「紫色半透明高亮叠加图」作第 2 张参考图并在提示词说明只改高亮区域，3/3 只改高亮区域，且 5 个相同物体只高亮其一时恰好命中；无叠加图对照随机。代价：占用一个参考图名额。
- **速率限制**：6～10 个请求并发时返回 HTTP 429，无 `Retry-After`；间隔 60 s 串行重试成功。

## 2026-09-17 冒烟：Seedream 5.0 pro / lite

夹具保存于 `contracts/fixtures/2026-09-17-team-gateway-seedream/`（`doubao-seedream-5-0-pro-260628`、`doubao-seedream-5-0-lite-260128`，合成几何图形，脚本 `contracts/smoke/multiturn-refs-mask/seedream.py`）：

- **模型 ID**：网关只认 `-lite-` 别名；文档正式 ID `doubao-seedream-5-0-260128` 返回 HTTP 503 `model_not_found`。
- **请求形态**：`POST /v1/images/generations`，顶层 `model`、`prompt`、`size`（`WxH` 或 `2K` 档位）、`image`（data-URL 数组）、`response_format:"url"`、`watermark`、`output_format`；`/v1/images/edits` 同形态等价。qwen 的 `input.messages` 形态 HTTP 200 但参考图被静默丢弃（`usage.input_images=0`），不得使用。出图在顶层 `data[].url`，不是 `metadata.output.choices`。
- **多轮消息不可用**，沿用结果回灌。
- **参考图序号措辞**：「图N」「Image N」「图一/二/三」各测序号 2 与 3，两模型各 6/6。
- **区域指示**：高亮叠加参考图、图上标记（红框画在原图上替换原图）两模型各 2/2；`<bbox>` 坐标标签（0～999）pro 2/2，lite 也 2/2 但文档仅 pro 支持，能力表保守不开；无指示对照未命中目标。
- **参考图上限**：pro 10、lite 14，超限 HTTP 400「number of reference images cannot exceed N」。
- **速率限制**：每模型 10 并发全部 HTTP 200，未触发 429；阈值未探。
- **多区域**：双区域不同指令，高亮叠加（紫 / 黄分色）、图上标记（紫 / 黄框）、坐标标签（两段 `<bbox>`）两模型各 3/3，无残留。
- **透明背景**：pro 单张带 alpha 输入 + `background:"transparent"` 输出 RGBA；不带参数输出白底 RGB；lite 忽略该参数。
- **图层拆分**：`layer_decomposition` 三种猜测形态均被静默忽略；真实参数未知。

## 探测流程

临时密钥只能通过环境变量或权限受限的临时文件提供：

```bash
export UGC_IMAGE_TOOL_GATEWAY_API_KEY='temporary-key'
PYTHONPATH=src python3 -m ugc_image_tool.contracts.cli record \
  --base-url 'http://lzxsvn:3001' \
  --interface models \
  --path '<通过实测确认的路径>' \
  --method GET \
  --output .scratch/models-exchange.json
```

文生图和图片编辑探测使用经过团队批准的测试载荷文件：

```bash
PYTHONPATH=src python3 -m ugc_image_tool.contracts.cli record \
  --base-url 'http://lzxsvn:3001' \
  --interface text_to_image \
  --path '<通过实测确认的路径>' \
  --method POST \
  --body-file .scratch/text-to-image-request.json \
  --output .scratch/text-to-image-exchange.json
```

探测器只执行一次请求，不自动重试生成请求。输出会替换鉴权头、提示词、参考图、图片字节和有效 URL；生成正式夹具前仍需人工检查脱敏结果。

将交互整理进 `contracts/fixtures/<版本>/manifest.json` 后运行：

```bash
PYTHONPATH=src python3 -m ugc_image_tool.contracts.cli validate contracts/fixtures/<版本>
```

完整清单必须记录三类接口、主要错误映射、部分失败以及五项行为（幂等键、运行中取消、任务查询、`Retry-After`、部分失败）的 `supported`、`unsupported` 或 `unknown` 结论和证据。只覆盖部分接口的清单视为 partial manifest（如 `2026-08-29-team-gateway-edit-json/` 的编辑专用清单）：`interfaces` 缺任一三类接口即为 partial，此时仅校验已记录的接口与行为（行为结论另可用 `confirmed` 表示本轮实测确认），跳过主要错误映射、`unsafe_to_enable` 和全接口覆盖的强制要求，其余规则不变。只有 `supported` 且有真实夹具的能力才可进入本地模型能力表；Flash 专属例外如下，不改变其他模型准入。

## 2026-10-10 Flash 普通通路与证据准入

按 [Issue #8 最终 Resolution](https://github.com/TLOBillyQ/kacha/issues/8#issuecomment-6093423192)，Flash 官方明确支持能力可在客户端实现及自动化验证完成后开放，无须逐项真实网关冒烟。官方支持、当前网关实测、客户端实现分开记录，详见 [Flash 研究](../research/seedream-flash.md)。路径与有序 `image` 已有真实证据；普通输入/尺寸边界、JPEG、水印、base64、standard 优化按官方规则验证，不冒称网关已测。

#15 普通文生图与编辑均使用 `POST /v1/images/generations`：完整模型 ID `doubao-seedream-5-0-flash-260915`，精确 `WxH`，顶层有序 `image`（0 图时省略），默认 url/png/watermark:false，优化仅 standard。最多 10 张；保守字节政策 30000000（官方 30MB 未定义二进制/十进制），实际参考图快照必须通过格式、字节、像素、边长和比例校验；处理失败不可退回违规原字节。不得发送 n、negative_prompt、seed、mask、input.messages、sequential_image_generation、流式或搜索字段。

普通 `data` 必须恰好一项有效 URL 或 base64 图片；多项、空/坏项、下载失败均失败。URL 立即下载并保存，不持久化临时签名地址。HTTP 拒绝含 429 不自动重发/退避、不换模型。幂等、网关取消、Retry-After、任务查询继续 unknown。真实夹具从 `c3646077d5d9a252c541ae8434308f947030127e` 原样取回 manifest/text/overlay/transparent 四份；回放的替代图片字节和浏览器生成响应明确是合成测试数据，不证明真实编辑视觉语义。透明/区域扩展/图层通路由后续工作票实现，能力事实与客户端开放状态分离。
