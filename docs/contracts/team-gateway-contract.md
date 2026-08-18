# 团队网关契约

本目录保存通过团队网关真实交互获得的脱敏契约夹具。夹具验证器只接受明确记录的实测结果，不根据 OpenAI、DashScope 或其他厂商文档推断路径和载荷。

## 适配器实现状态

`src/ugc_image_tool/team_gateway.py` 依据本目录夹具实现真实适配器，客户端默认通过它接入团队网关：

- **模型发现**：`GET /v1/models`，`Authorization: Bearer` 鉴权；`data[].id` 作为模型 ID 交给本地能力表合并，未知模型保持禁用。
- **文生图**：`POST /v1/images/generations`，仅发送实测字段 `model`、`prompt`、`negative_prompt`、`n`、`size`（`WxH`）、`watermark`。
- **图片编辑**：`POST /v1/images/edits`，参考图按实测编码发送为 multipart 文件字段 `image`；成功响应按 `metadata.output` 的实际图片数量保存，并检测顶层 `data` 数量不一致。
- **错误映射**：401 → 鉴权失败；429 → 网关限流（可操作提示，不依赖 `Retry-After`）；4xx → 网关拒绝；5xx → 网关服务错误；连接失败 → 网络不可达（任务状态为结果未知）。
- **重试**：模型列表等只读请求由发现层有限重试；生成请求不自动重发，契约未确认幂等键，不使用稳定任务 ID 重试。
- **保持关闭（未实测）**：图片编辑的多参考图、负向提示词、尺寸与多张出图；生成请求的幂等键、运行中取消、任务查询和 `Retry-After`。这些能力在真实交互验证前不向网关发出。

## 当前结论

截至 2026-08-17，以下契约已在内网主机 `http://lzxsvn:3001` 真实验证，并保存于 `contracts/fixtures/2026-08-17-team-gateway/`：

- 鉴权使用 `Authorization` 头；无效密钥返回 401 和 `new_api_error`。
- 模型列表为 `GET /v1/models`，返回 `data` 模型数组和 `success: true`。
- 文生图为 `POST /v1/images/generations`，使用 `model`、`prompt`、`negative_prompt`、`n`、`size` 和 `watermark` 字段；成功返回临时 `url`，并在元数据中返回图片内容。
- 图片编辑为 `POST /v1/images/edits`；经过验证的参考图编码是 multipart 文件字段 `image`，不是 JSON data URI。成功响应的 `input_image_count` 为 1。
- 已验证模型仅为 `qwen-image-3.0-pro`；列表中的其他模型不得启用。

部分失败、幂等键、运行中取消、任务查询和可靠 `Retry-After` 没有得到足够的真实证据，均记录为 `unknown`，客户端不得依赖这些行为。`n=2` 样例显示元数据输出两张图片而顶层 `data` 只有一项；这只能证明响应视图不一致，不能证明网关提供了可依赖的部分失败语义，适配器必须将其视为未知结果并保守处理。

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

清单必须记录三类接口、主要错误映射、部分失败以及五项行为（幂等键、运行中取消、任务查询、`Retry-After`、部分失败）的 `supported`、`unsupported` 或 `unknown` 结论和证据。只有 `supported` 且有真实夹具的能力才可进入本地模型能力表。
