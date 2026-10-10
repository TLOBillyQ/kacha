# 图片编辑链路改用 JSON 透传

本条 JSON `input.messages` / `parameters` / `metadata.output.choices` 结论限于 qwen。Flash 普通生成与参考图编辑走 `POST /v1/images/generations`，顶层有序 `image`、顶层 `data[].url` 或 `data[].b64_json`，不发送 qwen 字段；证据与准入见 [Flash 研究](../research/seedream-flash.md)和 ADR 0001。

图片编辑原以 multipart 表单提交参考图，但网关的 multipart 转换路径只透传 n 与 watermark，尺寸与多参考图均不可用。2026-08-29 在 new-api v1.0.0-rc.27 官方零补丁网关上实测：改走 JSON（`Content-Type: application/json`，参考图编码为 data-URL 进入 `input.messages`）后，`parameters.size`（「宽*高」星号格式）、`parameters.n` 与多参考图（1～3 张）全部原生生效，无需网关补丁。因此编辑链路固定为 JSON 透传：请求顶层必须携带 `prompt`（网关必填），尺寸与出图数量走 `parameters`，出图以 `metadata.output.choices` 为真源而非顶层 `data`。证据见 `contracts/fixtures/2026-08-29-team-gateway-edit-json/`。
