# 开源图像生成 Harness 调研：多轮修改与参考图交互

> 调研日期：2026-09-15。star 数、许可证与最近推送时间都通过 GitHub API（`gh api repos/<owner>/<repo>`）在当天查询。
> 本文的结论都尽量追到一手来源：仓库源码、官方文档和第一方 API 文档。标注「未核实」的内容，只见于二手资料或从有限证据推断，没有在源码里确认。
> 行号会随上游提交变化，所以正文引用只到文件和函数一级。

## 1. 摘要与关键结论

1. **多轮修改的做法有三种，用哪种主要看模型接口。**
   - **无状态回灌**：把上一轮结果当作下一轮的输入图重新提交。几乎所有模型都能用，OpenAI `images/edits`、Qwen、Seedream、Flux Kontext 等都属于这一类。gpt-image-2-mcp、Jaaz、LibreChat、Open WebUI、Cherry Studio 用的都是它。
   - **对话历史回放**：把前几轮的 user 文本和 model 图片按原样放进 `contents`。只适用于 Gemini 这类原生多模态对话模型。NanoBananaEditor 和 Google 官方 quickstart 用这种方式。
   - **服务端会话引用**：OpenAI Responses API 的 `previous_response_id`，或者直接传图片生成调用的 ID。[OpenAI 文档](https://developers.openai.com/api/docs/guides/image-generation)支持这种方式，但本次调研的开源 harness 里还没有找到实际采用的。
2. **版本关系**：做得最细的是 NanoBananaEditor 的 `parentId` 谱系。它存在 IndexedDB 里，可以从任意历史节点分叉，回放时只往回取 2 轮。画布类工具（InvokeAI、Krita）不维护对话，而是用「暂存区 / 结果列表 → 采纳为图层」来表达迭代。
3. **参考图的角色有两种表达方式。**
   - **结构化角色**：InvokeAI 用 discriminated union 区分 `ip_adapter` / `flux_redux` / `flux_kontext_reference_image` / `qwen_image_reference_image` 等配置；Krita 用 `ControlMode` 区分 reference / style / composition / face / pose 等；Fooocus 的 ImagePrompt 分 ImagePrompt / FaceSwap / PyraCanny / CPDS。这些主要服务于本地扩散模型的 IP-Adapter / ControlNet。
   - **序号加提示词**：面向指令式编辑模型（Qwen-Image-Edit、Gemini、gpt-image）时，主流做法是按顺序传图，在提示词里写「图1 / Picture 2 / @Image3」。ComfyUI 官方 Qwen 节点会把 `@ImageN` 改写成 `Image N`，并校验序号有没有越界；Krita 的文档也要求 Qwen 用 “Picture 1/2/3”。
4. **Agent / 对话类 harness 的共同做法是给每张图一个 ID**，让 LLM 在工具调用里引用：LibreChat 用 `image_ids`，Jaaz 用 `input_images: ['im_xxx.png']`，Open WebUI 用 `image_urls`，LobeHub 用 `imageUrl/imageUrls`。能不能跨轮引用，取决于这些 ID 是否还在上下文窗口里。
5. **局部修改（mask）在 API 模型上普遍支持得不好。** OpenAI 的 mask 只能配单张输入图，ComfyUI 源码对此有显式校验；InvokeAI 明确说不支持 OpenAI 和 Gemini 的 mask。NanoBananaEditor 给没有 mask 参数的 Gemini 找了个办法：同时发一张黑白 mask 和一张“紫色半透明叠加预览图”。
6. **把每个模型的参考图上限写进本地能力表是通行做法。** 例如 NanoBananaEditor 的 `maxInputImages`、ComfyUI OpenAI 节点最多 16 张、Qwen 节点 1–3 张、InvokeAI Gemini 最多 14 张。这和本仓库 ADR 0004（本地能力表）的方向一致。
7. **对本仓库最值得借鉴的三点**：(a) 一键「用结果继续编辑 / 设为参考图」，并在任务记录里记下 `parent` 任务编号，形成谱系；(b) 参考图序号与提示词里的 `图N` 标记做双向校验；(c) 对 `qwen-image-*` 这类走 new-api JSON 透传的模型，多轮修改采用无状态回灌，不去依赖模型或网关的会话能力。详见第 6 节。

## 2. 对比表

图例：Y 表示已在源码或官方文档中确认，P 表示部分支持，N 表示明确不支持或没有找到，? 表示未核实。

| Harness | 形态 / 许可 / 活跃度 | 多轮：结果回灌为输入 | 多轮：对话历史回放 | 版本 / 分叉 / 暂存 | 局部 mask | 多参考图 | 参考图角色 | 从历史拖拽为参考 | 主要后端 |
|---|---|---|---|---|---|---|---|---|---|
| [ComfyUI](https://github.com/Comfy-Org/ComfyUI) | 节点图 / GPL-3.0 / 13.3 万 star，活跃 | 手动连线 | N（每次执行是一张 DAG） | 工作流本身 | Y（遮罩编辑器 + 节点） | Y（GPT 最多 16，Qwen 1–3） | 按节点输入口区分；Qwen 用 `@ImageN` | P | 本地模型 + 官方 API 节点 |
| [InvokeAI](https://github.com/invoke-ai/InvokeAI) | Web 画布 / Apache-2.0 / 2.8 万 star，活跃 | Y（暂存区采纳为图层） | N | Y（暂存区接受 / 丢弃） | Y（本地模型）；OpenAI、Gemini 不支持 | Y | Y（结构化配置；全局 / 区域参考） | Y（5 个投放区） | 本地 SD/Flux/Qwen + OpenAI/Gemini/Seedream/阿里云 |
| [Krita AI Diffusion](https://github.com/Acly/krita-ai-diffusion) | Krita 插件 / GPL-3.0 / 1.06 万 star，活跃 | Y（结果写成图层或替换） | N | Y（历史 / 任务队列） | Y（选区 + 羽化 / 混合） | Y（控制层） | Y（`ControlMode` 17 种）；Qwen 用 Picture N | P（任意图层都可设为控制层） | ComfyUI 后端：Flux Kontext / Flux2 Klein / Qwen Edit / SDXL |
| [Fooocus](https://github.com/lllyasviel/Fooocus) | Gradio / GPL-3.0 / 5.3 万 star，2025-12 后无推送 | 手动 | N | N | Y | Y（默认 4 槽，可配置） | Y（4 种类型） | N | 本地 SDXL |
| [SD WebUI (A1111)](https://github.com/AUTOMATIC1111/stable-diffusion-webui) / [Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge) | Gradio / AGPL-3.0 / A1111 最后推送 2026-03，Forge 2025-07 | Y（“Send to img2img/inpaint”） | N | N | Y | 靠扩展 | 靠扩展 | N | 本地 SD |
| [Open WebUI](https://github.com/open-webui/open-webui) | 对话 / 自定义许可 / 15.2 万 star，活跃 | Y（取最近 2 组图作为编辑输入） | N（图片编辑不回放历史） | 对话树 | ?（依赖引擎） | Y | 仅靠提示词 | N | OpenAI / Gemini / ComfyUI |
| [LibreChat](https://github.com/danny-avila/LibreChat) | 对话 / MIT / 4.4 万 star，活跃 | Y（LLM 在 `image_ids` 里引用历史图） | 由 LLM 代理 | 对话 | N（源码中 `TODO: mask`） | Y | 仅靠提示词 | P（侧栏重新附加） | gpt-image / Gemini / Flux / SD |
| [LobeHub](https://github.com/lobehub/lobehub) | 对话 + 独立绘画页 / 自定义许可 / 8.2 万 star，活跃 | P（“复用设置”，参考图 URL 随批次保存） | N | 批次列表 | ? | Y（`imageUrls`，按槽位容量） | 槽位（如起始帧、参考数组） | ? | 多服务商 |
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) | 桌面 / AGPL-3.0 / 5.2 万 star，活跃 | P（按所选模型切换编辑模式，上传输入图） | N | 绘画历史（记录 input/output 文件） | ? | Y | 仅靠提示词 | ? | DMXAPI / SiliconFlow 等聚合商 |
| [Jaaz](https://github.com/11cafe/jaaz) | Agent + Excalidraw 画布 / 双许可（社区版 + 商业版）/ 6.6k star，2026-03 后无推送 | Y（工具参数 `input_images` 传文件 ID） | 由 LLM 代理 | 画布元素 | N | Y（gpt-image 支持多张，Kontext 只允许 1 张） | 仅靠提示词 | Y（画布选中后发给对话） | gpt-image / Flux Kontext / Seedream / Seededit / Imagen / MJ / ComfyUI |
| [Loomic](https://github.com/fancyboi999/Loomic) | Agent + 画布 / MIT / 245 star，活跃 | Y（`inputImages` 解析 assetId） | 由 LLM 代理 | 画布 | ? | Y | ? | ? | Imagen / DALL·E / Replicate |
| [NanoBananaEditor](https://github.com/markfulton/NanoBananaEditor) | Web / AGPL-3.0 / 711 star，活跃 | Y | Y（沿 `parentId` 回放 2 轮） | Y（IndexedDB 存历史，任意节点分叉） | Y（mask + 叠加预览图） | Y（14/10/6） | Y（source/reference/mask/mask-preview） | Y（从历史选图上画布） | Gemini 图像模型 |
| [gemini-image-editing-nextjs-quickstart](https://github.com/google-gemini/gemini-image-editing-nextjs-quickstart) | Google 官方示例 / Apache-2.0 / 541 star | Y | Y（前端把 history 传给后端） | N | N | N（单图） | N | N | Gemini 2.0 Flash exp |
| [gpt-image-2-mcp](https://github.com/Borys520/gpt-image-2-mcp) | MCP / MIT / 12 star | Y（会话中上一轮输出自动作为输入） | N | 内存会话 | Y | Y（1–8 张） | N | N | OpenAI gpt-image-2 |
| [gemini-image-mcp](https://github.com/JimothySnicket/gemini-image-mcp) | MCP / MIT / 1 star | Y | Y（`sessionId`，前几轮保留在上下文，30 分钟过期） | 会话 | ? | Y（约 14 张） | N | N | Gemini |
| [Qwen-Image 官方 demo](https://github.com/QwenLM/Qwen-Image) | Gradio / Apache-2.0 / 8.3k star | N | N | N | N | N（单输入图） | N | N | 本地 Qwen-Image-Edit |
| [GenArtist](https://github.com/zhenyuw16/GenArtist) | 研究代码 / 无许可证 / 2024-10 后无推送 | Y（agent 规划后逐步编辑，含验证与自我纠正） | N | N | 工具内 | ? | ? | N | SD 系列 + AnyDoor / LaMa / InstructPix2Pix 等 |

## 3. 各项目细节

### 3.1 ComfyUI

- 仓库 [Comfy-Org/ComfyUI](https://github.com/Comfy-Org/ComfyUI)，GPL-3.0，约 13.3 万 star，当天仍有推送。前端单独在 [Comfy-Org/ComfyUI_frontend](https://github.com/Comfy-Org/ComfyUI_frontend)（GPL-3.0），带遮罩编辑器组件，见 [`src/components/maskeditor/`](https://github.com/Comfy-Org/ComfyUI_frontend/tree/main/src/components/maskeditor)。
- **多轮修改**：没有“对话”的概念。每次执行都是一张节点图，迭代要靠用户把输出接回输入。所以它更适合当“能力底座”来参考，而不是交互范式。
- **参考图进 API 的方式**，以官方 API 节点为准：
  - OpenAI（[`comfy_api_nodes/nodes_openai.py`](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api_nodes/nodes_openai.py)）：旧版 `OpenAIGPTImage1` 把 batch 里的每张图以 `image[]` 多段表单发到 `/images/edits`。mask 会被转换成 RGBA，alpha 取 `1 - mask`。源码显式检查“Cannot use a mask with multiple image”。新版 `OpenAIGPTImageNodeV2`（显示名 “OpenAI GPT Image 2.5”）用 `Autogrow` 动态输入口，tooltip 写明“Up to 16 images”，模型列表包括 `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2`、`gpt-image-1.5`、`gpt-image-1`。
  - Qwen（[`nodes_qwen.py`](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api_nodes/nodes_qwen.py)）：`qwen-image-3.0-pro` / `qwen-image-3.0` 节点接受 `image_1..image_3` 共 1–3 张参考图。`_resolve_image_refs` 把提示词里的 `@image` / `@Image2` 改写成模型能识别的 “Image N”；序号超出已连接的图数时报错。图片以 PNG data URI 发送，超过 10MB 解码上限时回退为 JPEG。
  - Gemini（[`nodes_gemini.py`](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api_nodes/nodes_gemini.py)）：前 10 张参考图先上传换成 URL（注释说明这是 Vertex 对图片链接数量的上限），超出部分改用 inline 数据发送。
  - BFL（[`nodes_bfl.py`](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api_nodes/nodes_bfl.py)）：Flux Kontext Pro/Max 只有一个 `input_image`；Flux2 系列按 `input_image`、`input_image_2`… 编号传入多张。
  - Seedream（[`nodes_bytedance.py`](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api_nodes/nodes_bytedance.py)）：模型映射包括 seedream 4.0 / 4.5 / 5.0 lite / 5.0 pro，`max_images` 参数上限为 15。

### 3.2 InvokeAI

- 仓库 [invoke-ai/InvokeAI](https://github.com/invoke-ai/InvokeAI)，Apache-2.0，约 2.8 万 star，活跃。
- **多轮修改（画布式）**：生成结果先进入“暂存区”（Staging Area），可以逐张浏览、接受、丢弃选中项、全部丢弃、存入图库，或者“New Layer From Image”。见 [`features/controlLayers/components/StagingArea/`](https://github.com/invoke-ai/InvokeAI/tree/main/invokeai/frontend/web/src/features/controlLayers/components/StagingArea)，组件包括 `StagingAreaToolbarAcceptButton`、`...DiscardSelectedButton`、`...MenuNewLayerFromImage` 等。[官方支持文档](https://support.invoke.ai/support/solutions/articles/151000096682-control-canvas)写明，有待处理图片时，部分设置要等接受或丢弃后才能修改。
- **参考图的数据模型**：[`controlLayers/store/types.ts`](https://github.com/invoke-ai/InvokeAI/blob/main/invokeai/frontend/web/src/features/controlLayers/store/types.ts) 里的 `zRefImageState.config` 是按 `type` 区分的联合类型：
  - `ip_adapter`：weight 取 -1…2，`beginEndStepPct`，`method`（风格 / 构图等）。
  - `flux_redux`：`imageInfluence` 取 lowest…highest。
  - `flux_kontext_reference_image`、`flux2_reference_image`、`qwen_image_reference_image`、`wan_reference_image`：注释说明这些模型“built-in reference image support”，不需要额外的适配模型。
  - 区域引导（`regional_guidance`）实体自带 `referenceImages` 数组。
  - 参考图本身是 `zCroppableImageWithDims`，也就是说可以裁剪。
- **全局参考与区域参考**：[支持文档](https://support.invoke.ai/support/solutions/articles/151000159340-global-and-regional-reference-images-ip-adapters-)说明，全局参考图可以把图片拖进提示词下方的 “Reference Image” 框；区域参考图作为画布图层，只作用于画笔圈出的区域。
- **拖拽投放区**：[`docs/.../Canvas/layers-and-drops.mdx`](https://github.com/invoke-ai/InvokeAI/blob/main/docs/src/content/docs/features/Canvas/layers-and-drops.mdx) 描述了拖图到画布时出现的 5 个投放区：新建栅格层、新建控制层、新建区域参考、新建局部重绘遮罩、新建按画布尺寸缩放的控制层。图片可以来自图库、磁盘或任何能拖拽图片的面板。这是“历史结果 → 指定角色”最直接的一种交互设计。
- **外部 API 模型的限制**：
  - [OpenAI 文档](https://github.com/invoke-ai/InvokeAI/blob/main/docs/src/content/docs/features/External%20Models/openai.mdx)：只要请求带初始图或参考图，就自动转到 `/v1/images/edits`；任何 OpenAI 模型都不支持 mask 局部重绘。
  - [Gemini 文档](https://github.com/invoke-ai/InvokeAI/blob/main/docs/src/content/docs/features/External%20Models/gemini.mdx)：参考图以 inline PNG 发送，但仍算 txt2img，img2img 强度和 inpaint mask 都不支持；Gemini 3 Pro Image 最多 14 张（6 物体 + 5 角色），3.1 Flash Image 最多 14 张（10 物体 + 4 角色），每次请求只出 1 张。
  - 同一目录下还有 `seedream.mdx` 和 `alibabacloud.mdx`（本次未展开）。

### 3.3 Krita AI Diffusion

- 仓库 [Acly/krita-ai-diffusion](https://github.com/Acly/krita-ai-diffusion)，GPL-3.0，约 1.06 万 star，最近推送 2026-08-28，以 ComfyUI 为后端。
- **多轮修改**：
  - 结果以图层形式落回文档。[`ai_diffusion/model/model.py`](https://github.com/Acly/krita-ai-diffusion/blob/main/ai_diffusion/model/model.py) 里的 `apply_result` 支持三种行为：`ApplyBehavior.replace` 覆盖当前层，默认行为新建一层并命名为 `提示词 (seed)`，`layer_active` 插在当前层之上。有区域时按区域生成图层组。
  - 任务历史在 [`model/jobs.py`](https://github.com/Acly/krita-ai-diffusion/blob/main/ai_diffusion/model/jobs.py)：`JobQueue` 记录每个 `Job` 的 `JobParams`，包括 bounds、区域、`ref_layers`（“layer name -> prompt image id”）；`in_use` 标记哪些结果已被采用。
  - 选区操作的[文档](https://docs.interstice.cloud/selections/)列出 Fill / Expand / Remove Content / Add Content / Replace Background 几种模式，外加选区羽化、混合和上下文区域设置。
- **参考图角色**：[`backend/resources.py`](https://github.com/Acly/krita-ai-diffusion/blob/main/ai_diffusion/backend/resources.py) 的 `ControlMode` 枚举有 reference、style、composition、face、inpaint、universal、scribble、line_art、soft_edge、canny_edge、depth、normal、pose、segmentation、blur、stencil、hands。[控制层文档](https://docs.interstice.cloud/control-layers/)把它们分成“参考类”（Reference / Style/Composition / Face）和“结构类”，每层都有 Strength 和 Range（生效的采样步区间）两个参数。任意图层都能通过 “Add control layer” 指定角色，之后也能改。
- **区域**：[文档](https://docs.interstice.cloud/regions/)说明，一个区域提示词可以关联多个图层，每个区域有自己的控制层；Refine Region 用当前层的覆盖范围作为 mask，只使用当前区域提示词加根提示词。
- **指令式编辑模型**：[Edit models 文档](https://docs.interstice.cloud/edit-models/)列出 Flux Kontext（主力）、Flux 2 Klein（实验性）、Qwen Image Edit（实验性）。额外的参考图要单独放在一个图层，再点 “Add control layer”。用 Qwen 时，提示词里以 “Picture 1” 指主画布，“Picture 2/3” 按界面顺序指参考图。文档建议“Make changes one at a time”。

### 3.4 Fooocus 与 SD WebUI / Forge

- [Fooocus](https://github.com/lllyasviel/Fooocus)（GPL-3.0，2025-12 后无推送）：[`webui.py`](https://github.com/lllyasviel/Fooocus/blob/main/webui.py) 的 Image Prompt 标签页按 `default_controlnet_image_count` 生成若干槽位，每个槽位有 Stop At、Weight 和 Type。类型定义在 [`modules/flags.py`](https://github.com/lllyasviel/Fooocus/blob/main/modules/flags.py)，共 `ImagePrompt / FaceSwap / PyraCanny / CPDS` 四种，每种有默认的 stop 和 weight。高级选项里还有 “Mixing Image Prompt and Inpaint”。这是“固定槽位 + 角色单选”的早期典型。
- [A1111](https://github.com/AUTOMATIC1111/stable-diffusion-webui)（AGPL-3.0）：[`modules/infotext_utils.py`](https://github.com/AUTOMATIC1111/stable-diffusion-webui/blob/master/modules/infotext_utils.py) 的 `create_buttons` / `bind_buttons` 实现“发送到 img2img / inpaint 标签页”，同时带上图片和生成参数。这是“结果回灌为输入”最原始的形式。[Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge) 自 2025-07 起无推送。

### 3.5 Open WebUI

- 仓库 [open-webui/open-webui](https://github.com/open-webui/open-webui)，约 15.2 万 star，许可证在 API 中显示为 NOASSERTION，属于自定义许可。
- **两条路径**：
  - 旧模式：打开图像开关后，[`utils/middleware.py`](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/utils/middleware.py) 的 `chat_image_generation_handler` 拿最后一条用户消息作为提示词，再用 `get_images_from_messages` 从当前对话分支倒序收集图片，只取最近 2 组（注释：“Limit to first 2 sets of images”）。有图就走编辑，没图就走生成。因此上一轮生成的图（作为 message files）会被自动当成下一轮的编辑输入，这是隐式的无状态回灌。
  - 原生函数调用模式：[`tools/builtin.py`](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/tools/builtin.py) 暴露 `generate_image` 和 `edit_image(prompt, image_urls)`，由模型自己决定引用哪些图的 URL。
- **引擎**：[`routers/images.py`](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/routers/images.py) 的 `image_edits` 支持三种引擎。OpenAI 以 `image[]` 多段表单发到 `/images/edits`；Gemini 以 `inline_data` 发送；ComfyUI 需要指定工作流和节点映射。[官方文档](https://docs.openwebui.com/features/chat-conversations/image-generation-and-editing/usage/)也描述了上传多张图做合成（主体图 + 背景图）的用法。
- 源码里没有专门的参考图角色 UI。

### 3.6 LibreChat

- 仓库 [danny-avila/LibreChat](https://github.com/danny-avila/LibreChat)，MIT，约 4.4 万 star。
- **图片 ID 机制**：
  - [`OpenAIImageTools.js`](https://github.com/danny-avila/LibreChat/blob/main/api/app/clients/tools/structured/OpenAIImageTools.js) 的编辑工具接收 `image_ids` 数组。它先在当前请求的文件里找，找不到再去数据库按 `file_id` 查，保持原顺序，以 `image[]` 发到 `/images/edits`。结果文本里写回 `generated_image_id` 和 `referenced_image_ids`，让 LLM 后续还能引用。源码注释 `// TODO: mask support` 说明目前不支持 mask。
  - [`GeminiImageGen.js`](https://github.com/danny-avila/LibreChat/blob/main/api/app/clients/tools/structured/GeminiImageGen.js) 用同样的 `image_ids`，转成 `inlineData` 后拼进 `contents`。
- **上下文限制**：[官方文档](https://www.librechat.ai/docs/features/image_gen)写明，生成图只在刚生成时作为视觉上下文发给 LLM，后续轮次要从侧栏重新附加；历史图的 ID 只要还在上下文窗口内就能继续用于编辑。

### 3.7 LobeHub（原 LobeChat）

- 仓库已从 lobe-chat 更名为 [lobehub/lobehub](https://github.com/lobehub/lobehub)，约 8.2 万 star。
- **Agent 工具**：[`packages/builtin-tool-image-generation/src/manifest.ts`](https://github.com/lobehub/lobehub/blob/main/packages/builtin-tool-image-generation/src/manifest.ts) 定义了四个工具：`listImageModels`、`getImageModelParameters`（要求先查询模型的参数 schema）、`generateImage`（支持 `imageUrl` 单参考图、`imageUrls` 多参考图，`imageNum` 1–8，可异步等待）和 `getImageGenerationStatus`。“先查能力，再传参数”这一点值得注意。
- **绘画页**：
  - [`useReferenceImageUpload.ts`](https://github.com/lobehub/lobehub/blob/main/src/routes/(main)/(create)/features/GenerationInput/useReferenceImageUpload.ts) 抽象出“参考槽位”，每个槽位有 `capacity`，例如起始帧、参考数组、结束帧。拖入的文件按优先级依次填满，超出上限时回调提示。
  - [`GenerationFeed/BatchItem.tsx`](https://github.com/lobehub/lobehub/blob/main/src/routes/(main)/(create)/image/features/GenerationFeed/BatchItem.tsx) 在每个批次上展示当时用的参考图，并提供“复用设置”（`reuseSettings`，去掉 seed），属于“参数级回灌”。
  - 没有找到“把某张结果设为参考图”的专门按钮（未核实，可能在其他组件里）。

### 3.8 Cherry Studio

- 仓库 [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio)，AGPL-3.0，约 5.2 万 star。
- [官方文档](https://github.com/CherryHQ/cherry-studio-docs/blob/main/cherrystudio/preview/drawing.md)说明，绘图和编辑没有单独的切换按钮，由所选模型决定：选 `qwen-image-edit` 这类编辑模型，就要先上传图片再描述改动。
- 源码 [`PaintingComposer.tsx`](https://github.com/CherryHQ/cherry-studio/blob/main/src/renderer/pages/paintings/components/PaintingComposer.tsx) 用 `isEditImageModel`（依据输入模态）判断能不能加图，再用能力注册表里的 `modes` 判断图是不是必填（没有 `generate` 模式就必须有图）。编辑模型的输入图放在顶部的参考图托盘里。
- [`usePaintingComposerInputFiles.ts`](https://github.com/CherryHQ/cherry-studio/blob/main/src/renderer/pages/paintings/hooks/usePaintingComposerInputFiles.ts) 的注释值得参考：草稿期间不落库，生成时才把附件“物化”为文件条目；只要有一张没成功，整个任务就中止；切到不接受图片的模型时清空草稿。
- 历史（[`usePaintingHistory.ts`](https://github.com/CherryHQ/cherry-studio/blob/main/src/renderer/pages/paintings/hooks/usePaintingHistory.ts)）为每条记录保存 `files.input` 和 `files.output`。

### 3.9 Jaaz

- 仓库 [11cafe/jaaz](https://github.com/11cafe/jaaz)，约 6.6k star，双许可（社区版 + 商业版，见 [LICENSE](https://github.com/11cafe/jaaz/blob/main/LICENSE)），2026-03 后无推送。README 自称“open-source multimodal creative assistant”，定位是 Lovart 的开源替代。
- **架构**：LangGraph 多智能体。[`image_designer_config.py`](https://github.com/11cafe/jaaz/blob/main/server/services/langgraph_service/configs/image_designer_config.py) 定义了批量生成和错误处理的系统提示，并能把任务交接给 video_designer。
- **参考图数据流**：
  - 前端 [`ChatTextarea.tsx`](https://github.com/11cafe/jaaz/blob/main/react/src/components/chat/ChatTextarea.tsx) 在用户消息文本末尾追加 `<input_images count=N><image index="1" file_id=... width=... height=.../></input_images>`，同时把图片以 base64 的 `image_url` 发给视觉 LLM。
  - LLM 调工具时在 `input_images` 里填文件 ID。以 [`generate_image_by_gpt_image_1_jaaz.py`](https://github.com/11cafe/jaaz/blob/main/server/tools/generate_image_by_gpt_image_1_jaaz.py) 为例，参数说明写着 “Pass a list of image_id here, e.g. ['im_jurheut7.png', ...]”。
  - Kontext 工具（[`..._flux_kontext_pro_jaaz.py`](https://github.com/11cafe/jaaz/blob/main/server/tools/generate_image_by_flux_kontext_pro_jaaz.py)）在描述里限定 “Only one input image is allowed”，用工具描述把模型能力告诉 LLM。
  - 需要注意，本地 [`openai_provider.py`](https://github.com/11cafe/jaaz/blob/main/server/tools/image_providers/openai_provider.py) 编辑时只取 `input_images[0]`，多参考图只有经过 Jaaz 云端 provider 时才可能生效（未在云端核实）。
- **结果回到画布**：[`image_canvas_utils.py`](https://github.com/11cafe/jaaz/blob/main/server/tools/utils/image_canvas_utils.py) 的 `save_image_to_canvas` 先加画布锁，再用 `find_next_best_element_position` 自动排布，把结果作为 Excalidraw 元素追加进去。于是结果既在对话里，又在画布上，可以再选中后发回对话。

### 3.10 其他 Lovart 类 Agent 画布

- [Loomic](https://github.com/fancyboi999/Loomic)（MIT，245 star，活跃）：Next.js、Excalidraw 画布加对话 agent。[`apps/server/src/agent/tools/image-generate.ts`](https://github.com/fancyboi999/Loomic/blob/main/apps/server/src/agent/tools/image-generate.ts) 的 `inputImages` 支持 assetId 引用，服务端会解析成 base64 data URI；结果带画布显示宽高。
- [Anil-matcha/Open-AI-Design-Agent](https://github.com/Anil-matcha/Open-AI-Design-Agent)（MIT，359 star）和 [Open-Generative-AI](https://github.com/anil-matcha/open-generative-ai)（MIT，2.8 万 star）：只看了 README，多轮和参考图机制未核实。

### 3.11 NanoBananaEditor（多轮与分叉做得最完整的参考实现）

- 仓库 [markfulton/NanoBananaEditor](https://github.com/markfulton/NanoBananaEditor)，AGPL-3.0，711 star，活跃，仅支持 Gemini 图像模型，带积分和 Supabase 后端。
- **状态**：[`src/store/useAppStore.ts`](https://github.com/markfulton/NanoBananaEditor/blob/main/src/store/useAppStore.ts) 用 zustand 加 IndexedDB（`idb-keyval`）持久化，历史上限 `MAX_HISTORY = 80`。状态分三块：composer 的 `references`、画布的 `canvasImage` 与 `brushStrokes`（笔画可撤销）、以及 `keepConversation` 开关。
- **谱系**：[`src/types/index.ts`](https://github.com/markfulton/NanoBananaEditor/blob/main/src/types/index.ts) 里的 `HistoryItem` 包含 `inputs: { source, references[], maskPreview }`、`output`、`parentId`，还有 `batchId`、`variantIndex`（一次出 1/2/4 个变体）。
- **多轮回放**：[`src/hooks/useGenerate.ts`](https://github.com/markfulton/NanoBananaEditor/blob/main/src/hooks/useGenerate.ts) 的 `buildConversation` 找到当前画布图对应的历史项，沿 `parentId` 往回最多取 `MAX_CHAIN_TURNS = 2` 项，拼成 `user(prompt) → model(image)` 的轮次。最后一项的输出不再重复放进历史，而是作为本轮的 `source` 发送。因为回放从“当前画布图”出发，从历史里任意选一张放上画布，就相当于从那个节点分叉。
- **参考图角色**：[`src/services/imageApi.ts`](https://github.com/markfulton/NanoBananaEditor/blob/main/src/services/imageApi.ts) 给每张图标注 `role: 'source' | 'reference' | 'mask' | 'mask-preview'`。
- **mask**：[`maskService.ts`](https://github.com/markfulton/NanoBananaEditor/blob/main/src/services/maskService.ts) 生成两张图：黑底白区的 mask，以及原图加紫色半透明覆盖的预览图。这样没有 mask 参数的指令式模型也能“看到”要改哪里。
- **上限校验**：[`src/lib/models.ts`](https://github.com/markfulton/NanoBananaEditor/blob/main/src/lib/models.ts) 规定 `maxInputImages` 为 14 / 10 / 6，超出时直接提示用户“删掉一些参考图或换模型”。

### 3.12 官方示例

- **Google** [gemini-image-editing-nextjs-quickstart](https://github.com/google-gemini/gemini-image-editing-nextjs-quickstart)（Apache-2.0，541 star，模型仍是 `gemini-2.0-flash-exp-image-generation`，偏旧）：[`app/api/image/route.ts`](https://github.com/google-gemini/gemini-image-editing-nextjs-quickstart/blob/main/app/api/image/route.ts) 由前端保存 history，每次请求带上整段历史，服务端转成 `contents` 调 `generateContent`。一个细节是：只有 `role === "user"` 的图片会转成 `inlineData`，model 轮次里的图片被替换成空文本。也就是说，这个示例回放时实际丢掉了模型产出的图，只保留了用户上传的图（从代码推断）。
- **Gemini API 文档**（[image-generation](https://ai.google.dev/gemini-api/docs/image-generation)）：推荐用多轮对话迭代图像（“Multi-turn conversation is the recommended way to iterate on images”）。参考图上限按模型分：Gemini 3.1 Flash Lite Image 最多 14 张物体图；3.1 Flash Image 10 张物体 + 4 张角色；3 Pro Image 6 张物体 + 5 张角色 + 3 张风格。多轮时关于 thought signature 的具体要求，本次未展开核实。
- **OpenAI 文档**（[image-generation guide](https://developers.openai.com/api/docs/guides/image-generation)）：Responses API 下的多轮，可以把上一次的图片生成调用输出（或只传图片 ID）放进上下文，也可以用 `previous_response_id`。Image API 编辑示例用 4 张输入图，但文档没写最大张数。mask 必须和原图同格式、同尺寸，并带 alpha 通道。
- **Qwen**：[Qwen-Image 仓库](https://github.com/QwenLM/Qwen-Image)的 [`src/examples/edit_demo.py`](https://github.com/QwenLM/Qwen-Image/blob/main/src/examples/edit_demo.py) 是单输入图的 Gradio demo，可选先用 `polish_edit_prompt` 改写提示词，没有多轮。
- **Flux Kontext**：[black-forest-labs/flux](https://github.com/black-forest-labs/flux) 自 2025-07 起无推送，没有找到官方交互式多轮 app（未深入）。

### 3.13 MCP 服务器

- [gpt-image-2-mcp](https://github.com/Borys520/gpt-image-2-mcp)（MIT）：[`src/tools/session-tools.ts`](https://github.com/Borys520/gpt-image-2-mcp/blob/main/src/tools/session-tools.ts) 提供 `start_edit_session`（用 1–8 张图启动会话）和 `continue_edit_session`（描述写明 “The previous turn's output image is used as the input”），建议每轮用简短提示词来“limit drift”。[README](https://github.com/Borys520/gpt-image-2-mcp) 说明会话只存在内存里，重启就丢；Responses API 回退路径也不使用 `previous_response_id`。
- [gemini-image-mcp](https://github.com/JimothySnicket/gemini-image-mcp)（MIT）：[README](https://github.com/JimothySnicket/gemini-image-mcp) 说明传 `sessionId` 就能延续多轮，前几轮保留为上下文，`SESSION_TIMEOUT_MS` 默认 30 分钟；每次返回会话累计成本；建议给 agent 设置每小时请求数和成本上限。
- [claude-image-gen](https://github.com/guinacio/claude-image-gen)（MIT，65 star）：README 提到最多传 5 张参考图路径（只看了搜索摘要，未核实）。
- 共同点：MCP 工具的参数只能是文件路径、URL 或 base64，“角色”只能写在提示词里；多轮状态由服务端的会话 ID 维护。

### 3.14 研究代码

- [GenArtist](https://github.com/zhenyuw16/GenArtist)（NeurIPS 2024 spotlight，无许可证文件，2024-10 后无推送）：[README](https://github.com/zhenyuw16/GenArtist) 描述了一个由 MLLM agent 做工具选择、执行、验证和自我纠正的统一生成与编辑系统，工具包括 AnyDoor、GroundingDINO、Inpaint-Anything、InstructPix2Pix（MagicBrush）等。它更像“自动多轮”的思路参考，不是可用产品。

## 4. 跨项目设计模式

### 4.1 多轮修改

| 模式 | 做法 | 代表 | 优点 | 代价 |
|---|---|---|---|---|
| A. 结果回灌（无状态） | 上一轮输出作为下一轮的 `image`/`input_images` 重新提交 | gpt-image-2-mcp、Open WebUI、LibreChat、Jaaz、A1111 “Send to” | 适用于所有编辑模型；网关和服务端无状态；可以复现 | 每轮重新上传图片；语义上下文（“刚才那个帽子”）要写进提示词；多轮后画质漂移会累积 |
| B. 历史回放 | 把 `user 文本 / model 图` 轮次拼进 `contents` | NanoBananaEditor、Google quickstart、gemini-image-mcp | 模型能理解指代，一致性更好 | 只适合 Gemini 类模型；token 和成本随轮数增长，所以要截断（NBE 只取 2 轮） |
| C. 服务端会话 | `previous_response_id` / 图片生成调用 ID | OpenAI Responses API 文档 | 客户端很轻 | 绑定厂商；经过 new-api 这类网关时是否透传未知；本次没找到开源 harness 实际采用 |
| D. 画布图层 | 结果进入暂存区或结果列表，采纳后变成图层，下一轮以画布或选区为输入 | InvokeAI、Krita | 适合局部迭代、不破坏原图、可以对比 | UI 复杂度高 |
| E. Agent 自动多轮 | agent 规划、执行、验证、再修正 | GenArtist、Jaaz 规划智能体 | 用户省事 | 结果不可控，成本不可控（gemini-image-mcp 专门建议限流） |

版本管理上有三点共识：
- 每次生成都要记录**输入快照**（原图、参考图、mask），不能只存路径。NanoBananaEditor 的 `inputs`、Cherry Studio 的 `files.input`、Krita 的 `JobParams` 都是这么做的。
- 用 `parentId` 形成谱系，从任意节点重新编辑就是分叉。
- 结果先进入候选区，由用户确认“采用”，而不是自动覆盖当前图（InvokeAI 暂存区、Krita `in_use`）。

### 4.2 参考图交互

1. **角色表达的两种路线**：
   - 扩散模型加适配器：用结构化字段（type、weight、step range、region）表达角色。
   - 指令式编辑模型：按序号传图，角色写在提示词里。可以用 `@ImageN` 这类标记绑定序号，并在提交前校验（ComfyUI Qwen 节点、Krita 的 Picture N 约定）。
2. **能力驱动的 UI**：用每个模型的 `maxInputImages`、是否必须有输入图、是否支持 mask，决定能不能加图、提交按钮是否可用、换模型时是否清空参考图（Cherry Studio、NanoBananaEditor、LobeHub、ComfyUI）。
3. **槽位容量**：LobeHub 的 `ReferenceUploadSlot.capacity` 和 Fooocus 的固定槽位都属于此类。一次拖入多张图时，按槽位优先级依次填满，超出就提示。
4. **从历史拖成参考图**：InvokeAI 的 5 个投放区在拖放时直接选角色；NanoBananaEditor 从历史选图上画布；Jaaz 在画布选中后发给对话。
5. **ID 化引用（agent 场景）**：给图片一个短 ID（`im_xxx.png`、`file_id`、URL），工具结果回写 `generated_image_id` / `referenced_image_ids`，方便 LLM 跨轮引用（LibreChat、Jaaz）。
6. **没有 mask 参数时的局部编辑**：额外发一张带高亮叠加的预览图作为参考（NanoBananaEditor 的 `mask-preview`）。
7. **参考图裁剪和缩放**：InvokeAI 的 `zCroppableImageWithDims`；ComfyUI 统一缩放到约 2048² 以内，PNG 超限时回退 JPEG。

## 5. 对本仓库的启示

本仓库目前的形态（见 [CONTEXT.md](../../CONTEXT.md)、[ADR 0006](../adr/0006-use-json-passthrough-for-image-edit.md)、[模型矩阵](../model-matrix.md)）是：生成任务之间彼此独立；参考图按顺序提供，每张的用途写在提示词里；提交时保存参考图快照；编辑走 new-api JSON 透传，参考图以 data-URL 放进 `input.messages`，1–3 张；任务记录只用于追溯，不是可搜索的历史库。

1. **多轮修改优先采用“结果回灌”（模式 A）。** 团队网关只保证 JSON 透传，`qwen-image-2.0-pro` 等模型也不是 Gemini 式的对话模型，所以最稳妥的是一个客户端动作：“以此结果继续编辑 / 设为参考图”。它把某张生成结果复制成新任务的参考图快照（沿用现有的快照概念），不引入网关会话。这和 gpt-image-2-mcp 的 `continue_edit_session`、Open WebUI 取最近图片作为编辑输入是同一个思路。
2. **任务记录里补一个“来源任务编号 / 来源结果”字段。** 这相当于 NanoBananaEditor 的 `parentId`，最低成本地支持追溯和从任意结果分叉，而且不需要把任务记录变成历史库。领域语言上可以考虑新增“派生任务”之类的词（需要在 CONTEXT.md 里正式定义）。
3. **参考图序号和提示词双向绑定。** 模型矩阵里的 qwen 系列正是 ComfyUI `_resolve_image_refs` 针对的模型族。可以借鉴：界面给参考图标上“图1/图2/图3”，提示词里插入 `@图N` 快捷标记，提交前检查引用序号不超过参考图数量，再改写成模型能识别的措辞。改写成什么词最有效（例如“图1”还是 “Image 1”），需要在网关上实测。
4. **把能力表扩展到交互约束**（延续 ADR 0004）：每个模型的最少和最多参考图数、输入图是否必填、是否支持 mask。换模型时，按 Cherry Studio 的方式处理超出的参考图：提示用户或自动截断，而不是提交失败。
5. **“候选 → 采用”要轻量。** 多张出图时可以学 InvokeAI 暂存区和 Krita `in_use`，标记哪张被“继续编辑”过，方便日后追溯。
6. **局部修改**：如果目标模型不支持 mask（qwen-image-2.0-pro 的 mask 能力未核实），可以学 NanoBananaEditor，在客户端生成“原图 + 高亮叠加”作为额外参考图，同时在提示词里说明“只修改高亮区域”。但这会占用 1–3 张参考图配额中的一张，效果也需要实测。
7. **控制漂移和成本**：多轮链不宜过长（NanoBananaEditor 只取 2 轮，gpt-image-2-mcp 建议用短提示词）。可以在界面上提示“多轮编辑后建议回到原图重新编辑”。（已否决：连续编辑是美术的常规工作方式，界面不做此提示，见 #111。）

## 6. 待确认问题

1. `qwen-image-2.0-pro`、`qwen-image-edit-max`、`wan2.7-image` 在网关的 JSON 路径上，`input.messages` 能不能放多轮 user/assistant 消息并真正产生对话式编辑效果？还是只看最后一条？（未核实，需要对网关做冒烟测试。）
2. 这些模型有没有原生 mask 或区域参数？“高亮叠加预览图”这种替代方案在 Qwen 系列上效果如何？
3. 提示词里的参考图指代，哪种写法对 qwen 系列最稳？ComfyUI 改写成 “Image N”，Krita 文档用 “Picture N”；中文“图1”的效果未验证。
4. OpenAI Responses API 的 `previous_response_id` 多轮，经过 new-api 是否可用？（本仓库目前没接 OpenAI，优先级低。）
5. LobeHub 绘画页和 Cherry Studio 有没有“把结果设为输入图”的一键操作？本次源码检索没有找到，可能在未检查的组件里。
6. Jaaz 云端 provider 对 gpt-image 多参考图的实际处理方式：本地 OpenAI provider 只取第一张。
7. Open-Generative-AI、Open-AI-Design-Agent 等高 star 的 Lovart 类项目，多轮和参考图的实现细节未核实。
