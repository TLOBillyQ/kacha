# Seedream Flash 身份、Lite 退役与网关契约差异（2026-10-09）

研究票：[核实 Flash 身份、Lite 退役公告与网关契约差异 #2](http://lzxsvn:3000/qinyuanj/kacha/issues/2)；父地图：[Seedream Lite 退役与 Flash 接入决策地图 #1](http://lzxsvn:3000/qinyuanj/kacha/issues/1)。资产分支：`research/seedream-flash-contract`，基线 `da7fa381473277edb71c06cebe984b95d6aec1b5`。本次只调查现有 Seedream 替换，不修改产品代码、能力表或网关，不执行付费生成。

## 结论与证据边界

- **官方身份已核实**：字节跳动的 Doubao Seedream 5.0 flash 是独立图片生成模型，完整 ID 为 `doubao-seedream-5-0-flash-260915`，发布公告列在 **202609** 的“新发布”行。不能从 ID 后缀推导精确上线日期，也不能将其当作 Lite 的别名。[S1][S2]
- **官方退役期限已核实**：第十批公告明确列出 `doubao-seedream-5-0-lite-260128`，启动通知为 **2026-09-22 10:00**、EOM 为 **2026-09-24 10:00**、EOS 为 **2026-11-24 14:00**，均 UTC+8。该表推荐迁移到 **pro** `doubao-seedream-5-0-pro-260628`，没有承诺 Lite 自动转为 Flash。[S3]
- **不能只换 ID**：Flash 官方参考图上限从 Lite 的 14 降为 10；分辨率档从 2K/3K/4K 变为 1K/1.5K/2K；总像素上限从 16,777,216 降为 4,624,220。Flash 明确“不支持配置 `sequential_image_generation`”，不可继承 Lite 的 `sequential_image_generation:"disabled"`。[S4][R1]
- **当前团队网关契约未验证**：9 月 17 日夹具仅证明当时 Lite/pro 的行为，不能证明 10 月 9 日 Flash 可发现、可调用或透传正确。本次没有取得当前网关发现结果，也没有发送生成请求。凭据/私有渠道缺口已移交 [#6](http://lzxsvn:3000/qinyuanj/kacha/issues/6)，需要另行授权的真实生成证据已移交 [#7](http://lzxsvn:3000/qinyuanj/kacha/issues/7)。官方声明及 GET 模型发现均不等于团队网关生成契约验证。[R2][R5]

## 官方身份与过渡期

模型列表和教程同时列出 Lite 的两种拼写：`doubao-seedream-5-0-260128` 与 `doubao-seedream-5-0-lite-260128`；退役表明确列的是后一拼写。两种拼写的官方对应关系不能变成客户端的迁移别名，也不能据此认为改用无 `-lite-` 的拼写可避开 EOS。当前团队渠道如何路由这两个 ID 仍需 #6 的证据。[S2][S3][R4][R6]

|节点|官方日期（UTC+8）|公告承诺及限制|
|---|---|---|
|启动与通知|2026-09-22 10:00|逐步下调模型配额。|
|EOM：停止新购|2026-09-24 10:00|不能新增/开通旧模型服务与推理接入点；下线流程写明存量推理接入点可正常使用，但配额逐步下调。|
|EOS：停止服务|2026-11-24 14:00|旧模型停止服务；残留接入点自动替换或直接关停，取决于接入点条件。|

以上来自公告“第十批模型下线说明”“下线流程”“节点说明”。公告另有 **2026-10-22 14:00** 的例外，针对 `doubao-seed-2-0-lite-260215` 和 `doubao-seed-2-0-mini-260215`，不是 Seedream Lite，不能误套。[S3]

公告说明：自定义接入点若依赖平台自动切换，需要提前开通替代模型，否则可能调用报错；预置接入点到期直接关停、不自动切换；安心体验或配置用量上限的接入点也到期关停。第十批推荐表只有“建议迁移模型”列，没有给 Lite 一条独立的确定自动替换映射。因此，“官方推荐 pro”“存量接入点在过渡期可用”都不能证明本团队网关会一直提供 Lite、到期自动变 pro 或 Flash，亦不能确定第三方渠道的日期。[S3]

Flash 发布公告称“能力与 Seedream 5.0 pro 完全一致”“生图速度更快、价格更低”；pro/flash 教程进一步区分 pro 质量更高与 Flash 时延/成本定位。API 和教程参数表明确 Flash 不支持 pro 的 `optimize_prompt_options.mode:"fast"`。概述中的能力一致不能用于继承所有 pro 参数，更不能说明与 Lite 等价。本次未做质量、延迟或成本实测，也没有据此决定客户端模型档位。[S1][S4][S5]

## 官方 API 与现有客户端的契约差异

以下为官方文档承诺与仓库代码事实的比较，**不表示当前网关已实测支持 Flash**。

|项目|现有 Lite 配置/发送|Flash 官方 API|切换需处理的差异|
|---|---|---|---|
|调用端点|客户端 `POST /v1/images/generations`|方舟原生 `POST https://ark.cn-beijing.volces.com/api/v3/images/generations`|原生文档不能证明团队 `/v1` 路由兼容；按 ADR 0001 单独取证。[S4][R2][R5]|
|模型身份|`doubao-seedream-5-0-lite-260128`|`doubao-seedream-5-0-flash-260915`|完整新 ID 独立发现与能力记录；不能按名称继承。[S1][R1][R5]|
|参考输入|顶层有序 `image` data-URL 数组|`image:string\|string[]`；URL 或 `data:image/<小写格式>;base64,...`|官方形态相似；当前渠道是否采纳参考图与顺序仍待测。[S4][R2]|
|普通输入限制|14 张；≤30 MiB，像素 196–36,000,000，短边≥15，宽高比 1/16–16|最多 **10 张**；官方单图≤30 MB，像素 196–36,000,000，边长>14，宽高比 1/16–16；jpeg/png/webp/bmp/tiff/gif/heic/heif|数量下降；30 MB 与本地 `31457280` 字节口径是否一致仍需网关边界证据；区域指示展开后的实际发送数计入限制。[S4][R1]|
|生成尺寸|精确 `WxH`；2K/3K/4K；像素 3,686,400–16,777,216|1K/1.5K/2K（默认 2K），或 `WxH`；像素 **921,600–4,624,220**，宽高比 1/16–16|旧 3K/4K 均不能原样用于 Flash；2K 映射也有差异，见下表。[S4][R1][R2]|
|单结果|`sequential_image_generation:"disabled"`|普通生成只产单图，**不支持配置 `sequential_image_generation`**|不能照搬 Lite fixed_params；不添加无文档依据的 `n`。[S4][R1]|
|输出|`response_format:"url"`，`output_format:"png"`，`watermark:false`；客户端解析 `data[].url`|url/b64_json；png/jpeg；水印默认 true；URL 生成后 24 小时有效|候选普通生成保留 url/png/无水印；实际响应与下载待测。客户端现有 Seedream 解析器只取 URL，不能由官方支持 b64_json 推导客户端已兼容。[S4][R2]|
|负向提示词|无原生字段，由发送计划拼入发送文本|完整 API 字段未列 `negative_prompt`、`seed`、`n`、`mask`|“未公开字段”不是实测拒绝；不新增猜测参数。负向拼接效果仍需证据。[S4][R2][R3]|
|区域指示|Lite 表中高亮叠加/图上标记 supported，bbox_tag unsupported|Flash 明确支持坐标、框选、箭头；指南 `<point>`/`<bbox>` 坐标 0–999，示例引用“图 1/图 2”|官方标记/坐标支持不证明 Kacha 当前高亮叠加、双区域或英文 `Image N` 模板有效，分别待测；叠加图会占参考图名额。[S4][S5][S6][R1]|
|透明背景|Lite unsupported|`background:"transparent"`：仅图生图且单张带 alpha 输入；输出 PNG，JPEG 输入或输出配置不允许|新增官方能力，网关待测；是否纳入切换由地图决定，不自动开启。[S4][R1]|
|组图/流式/联网|Lite 官方支持；当前客户端单结果线路未启用组图、流式或搜索|Flash 暂不支持组图、流式、联网搜索|官方能力损失不等于当前用户已用能力损失；不能沿用相关参数。[S4][R2]|
|提示词优化|Lite 仅 standard|Flash 仅 standard，不支持 fast|不能继承 pro fast 参数。[S4][S5]|
|图层拆分|Lite unsupported；旧 pro 冒烟未确认参数|`layer_decomposition:boolean`，默认 false；1 底图+最多16层|新的公开协议事实见下文；本次范围不自动扩展。[S4][R1][R3]|
|限流|本地不从名称猜阈值|官方列表 Flash/Lite 最大 IPM 500 张/分钟|方舟指标不等于团队账号当前配额、网关并发限制或 Retry-After 支持。[S2][S3][R3]|

尺寸表为官方常见映射参考，客户端需依选定模型的能力表解析生成尺寸，不能仅把旧档位字符串或像素复用到新模型：[S4][R1]

|宽高比|Lite 2K（现有表）|Flash 1K|Flash 1.5K|Flash 2K|
|---|---|---|---|---|
|1:1|2048x2048|1024x1024|1536x1536|2048x2048|
|4:3|2304x1728|1152x864|1792x1344|2368x1776|
|3:4|1728x2304|864x1152|1344x1792|1776x2368|
|16:9|2848x1600|1424x800|2048x1152|2816x1584|
|9:16|1600x2848|800x1424|1152x2048|1584x2816|
|3:2|2496x1664|1248x832|1872x1248|2496x1664|
|2:3|1664x2496|832x1248|1248x1872|1664x2496|
|21:9|3136x1344|1568x672|2352x1008|3136x1344|

部分旧 Lite 2K 精确像素仍落在 Flash 的合法范围内，但这不能决定迁移时应保留旧像素还是采用 Flash 映射；旧 11–14 张参考图亦无法原样提交到 Flash。用户配置的处理由 #4 决定，本票只提供边界。[S4][R1]

Flash 图层拆分的官方请求参数已公开：`layer_decomposition:true`，输入必须单张 PNG/JPEG、像素 262,144–36,000,000；尺寸只用 1K/1.5K/2K/auto（默认 auto），不能用精确像素。输出 `data` 含底图和透明 PNG 图层、`z_index/name/description/bounding_box`；`bounding_box` 是含 `absolute` 和 `normalized` 的对象，后者范围 **0–1000**，与交互编辑提示词的 **0–999** 不同；任一图层失败整体请求报错。[S4][S6]

现有 Seedream URL 解析器没有图层元数据处理，旧 pro 三种参数猜测被忽略的结论只能描述 9 月 17 日测试。不能声称参数至今仍未知，也不能声称官方新协议已被团队网关透传。图层拆分是否纳入本次替换仍由地图决策；不因此扩展单结果边界或实现图层功能。[R2][R3][S4]

## 仓库事实与历史网关证据

当前内置表只有 qwen 两项、Seedream pro 和 Lite，没有 Flash。默认优先 Lite；模型发现返回 ID 后按完整字符串与上架清单求交集。实际代码有例外：从未成功发现模型时退回上架清单；默认选择函数在可用列表为空时也可退回上架清单首项。这些是当前代码行为，不是本票批准的切换策略；#3 必须考虑无发现/旧缓存/空列表状态。[R1][R7]

现有 Seedream 构造器发送 `model/prompt/size/response_format` 加模型 `fixed_params`，可选 `image` 数组与透明背景；请求体不含 qwen 的 `input.messages`。模型能力按完整 ID 查找，`untested` 不被 `isSupported` 认作支持。[R2][R6]

9 月 17 日真实夹具证明：

- 使用 `-lite-` ID 通过 `/v1/images/generations` 参考图请求成功，返回体 `model` 为无 `-lite-` 拼写，输出 `data[].url`；单次请求/响应不能证明今日渠道配置。[R4a]
- 无 `-lite-` ID 当时返回 HTTP 503、`model_not_found`，原文为 default 分组“无可用渠道”。这只能证明该测试上下文无可用渠道，不能概括为所有网关永久不接受正式 ID。[R4b]
- 15 张 Lite 输入返回 HTTP 400，“number of reference images cannot exceed 14”。[R4c]
- 契约文档另记录 pro 10/lite 14、图N与Image N、高亮叠加/图上标记、多区域、透明背景等测试；均明确是 **2026-09-17 的 pro/Lite**。不能把这些结论移植为 Flash 当前能力。[R3]

本次未执行 `GET /v1/models`：检查到 `KACHA_GATEWAY_API_KEY`、`KACHA_GATEWAY_KEY_FILE`、`KACHA_GATEWAY_BASE_URL` 环境变量不存在，原项目 `.scratch/gateway.key` 未找到；没有调用系统凭据库，也没有打印任何密钥。此结论只表示本调查没有可用凭据，不表示用户设备或团队没有凭据。当前模型发现、私有路由、Lite 当期可用性和 EOS 到期行为全部未核实，交由 #6。

旧任务重新生成/生成变体由 `prepareRegenerate` 读取任务目录的 `task.json`，以 `previous.model` 精确查能力表，缺失时报“模型 … 已不在能力表内”；发送计划按当前规则重算，但新任务仍记录旧模型 ID，没有别名转换。任务目录每个文件只写一次且不可变。切换默认模型不能改变旧任务身份，不能为“兼容”篡改旧记录或暗中将它发送给 Flash；后续兼容行为由 #4 决定。[R6][R8][R9]

## 明确缺口、前置票与下一 frontier

|前置票|需要的外部证据|本次状态|
|---|---|---|
|[#6 补齐当前网关 Flash/Lite 模型发现与渠道退役事实](http://lzxsvn:3000/qinyuanj/kacha/issues/6)|现有授权凭据的只读发现；维护者提供脱敏的实际供应商/版本/接入点类型/模型映射及过渡期处置|open、未认领；没有发现或私有配置证据。|
|[#7 取得当前网关 Flash 单结果契约与区域指示的授权实测证据](http://lzxsvn:3000/qinyuanj/kacha/issues/7)|#6 完成；取得测试载荷与明确生成预算授权，或提供当前渠道已有脱敏夹具；覆盖普通单结果协议、输入采纳、尺寸、参考图与区域指示，以及选定功能|open、未认领；本研究未授权也未执行任何生成。|

已建立 Gitea 原生 dependencies：#7 blocked by #6；#3 新增 blocked by #6/#7；#5 新增 blocked by #7。原 #4 blocked by #2/#3、#5 blocked by #2/#3/#4 的关系保留。研究可在“事实已总结、无法取证项明确移交”边界结案，但 **Flash 当前生成契约仍未验证**，不意味着产品已可上架。[T]

下一 frontier 是 #6 的只读发现及维护者私有资料，随后 #7 的授权取证，再进入 #3 的人工上架/默认/退出时序决策。#4 的旧配置兼容与 #5 的验收交接仍未决；本票不代答。官方日期与能力差异已足以说明需要处理的边界，不能替代人工选择并存、退出或迁移策略。[T]

## 一手来源与复核方式

官方页面在 WebFetch 中多次返回空内容。本调查直接读取火山引擎官网文档中心公开 JSON 接口的 `Result.MDContent`，没有使用搜索摘要作为最终证据：

`GET https://www.volcengine.com/api/doc/getDocDetail?LibraryCode=ark&DocumentCode=<code>`

该接口路径和参数由官方页面加载的 doccenter `main.3613eab6.js` 中的 `getDocDetail` 实现确认。原文读取日为 **2026-10-09（UTC+8）**。下表的 SHA-256 为 `Result.MDContent` 原始字符串的 UTF-8 字节（未归一化、未替换 Markdown 转义），可检查后续文档是否变更；不是网关夹具。

|编号|官方原文（页面）|DocumentCode / DocumentID|MDContent SHA-256|
|---|---|---|---|
|S1|[模型发布公告：202609](https://docs.volcengine.com/docs/ark/model-release-announcement)|model-release-announcement / 1159178|`d40d15404114f20c9c5a0a0dcd7142b2176cee4a60d48ce95cc1832f34cf9009`|
|S2|[模型列表：图片生成模型](https://docs.volcengine.com/docs/ark/model-list)|model-list / 1330310|`78109fba41fb29cf20d3db0c728dc0d6513fd159d00b9e2417adeee479998f9b`|
|S3|[模型下线公告：第十批及节点说明](https://docs.volcengine.com/docs/ark/model-deprecation-notice#tenth-model-deprecation)|model-deprecation-notice / 1350667|`0e0d95eb524dbb601e3542165f3b957936c2eb97d3e23198b661c87c80feffa1`|
|S4|[图片生成 API](https://docs.volcengine.com/docs/ark/image-generation-api)|image-generation-api / 1541523|`e350ac947953b00d7bc42f8e29ca3242687f848b6ff2838a81011827d2ad4b0b`|
|S5|[Seedream 5.0 pro / flash 教程](https://docs.volcengine.com/docs/ark/seedream-5-0-pro)|seedream-5-0-pro / 2582774|`718f8a43e5e6306e848efd6e44cdcffa266c900366ca87857b2ed7385c32d31b`|
|S6|[Seedream 5.0 pro / flash 交互编辑指南](https://docs.volcengine.com/docs/ark/seedream-5-0-pro-editing-guide)|seedream-5-0-pro-editing-guide / 2582775|`557e3e6c55136bd70c3387f025a6ba4a92b303dd74d96e981f15208dd24a241f`|
|S7|[Seedream 4.0–5.0 提示词指南](https://docs.volcengine.com/docs/ark/seedream-4-0-5-0-prompt-guide)|seedream-4-0-5-0-prompt-guide / 1829186|`ac477395d35d89766bef1177180904f6bede8eb405ec5e7708ef4abb9d074e9f`|

S7 提供 Lite 通过箭头、线框、涂鸦标记的旧有官方依据；Flash 的交互编辑依据使用 S5/S6，不能仅因通用提示词指南的标题而继承所有行为。

仓库来源均按本研究基线读取；后续修改应重新核对：

- **R1**：[内置模型能力表](../../client/src/core/capabilities.builtin.json)。
- **R2**：[团队网关适配器](../../client/src/core/gateway.ts)，`buildSeedreamImagesGenerations`、`parseImageUrls`、`listModels`。
- **R3**：[团队网关契约](../contracts/team-gateway-contract.md)，尤其“2026-09-17 冒烟”；旧研究 [Seedream 5.0 系列](seedream-5.md) 仅作调查入口，官方事实已回溯 S1–S7。
- **R4a**：[历史 Lite 参考图成功夹具](../../contracts/fixtures/2026-09-17-team-gateway-seedream/lite-probe-gen-img.json)。
- **R4b**：[历史无 `-lite-` ID 无可用渠道夹具](../../contracts/fixtures/2026-09-17-team-gateway-seedream/official-id-probe-gen-t2i.json)。
- **R4c**：[历史 Lite 15 张参考图拒绝夹具](../../contracts/fixtures/2026-09-17-team-gateway-seedream/lite-limit-15.json)。
- **R5**：[ADR 0001：仅通过团队网关](../adr/0001-integrate-only-through-team-gateway.md)、[ADR 0004：本地能力表](../adr/0004-use-a-local-model-capability-registry.md)。
- **R6**：[能力表精确 ID 查找与 supported 判断](../../client/src/core/capabilities.ts)。
- **R7**：[模型发现、缓存与默认选择](../../client/src/core/settings.ts)，`availableModels`、`defaultTaskModel`。
- **R8**：[旧任务读取与重新生成](../../client/src/core/run.ts)，`prepareRegenerate`。
- **R9**：[ADR 0010：任务目录不可变真源](../adr/0010-task-directory-is-the-source-of-truth-boards-are-views.md)、[壳侧只写一次存储](../../client/src-tauri/src/store.rs)、[领域语言](../../CONTEXT.md)。
- **T**：通过 `tea --login qinyuanj --repo qinyuanj/kacha` 读取 [地图 #1](http://lzxsvn:3000/qinyuanj/kacha/issues/1)、[#2](http://lzxsvn:3000/qinyuanj/kacha/issues/2)、[#3](http://lzxsvn:3000/qinyuanj/kacha/issues/3)、[#4](http://lzxsvn:3000/qinyuanj/kacha/issues/4)、[#5](http://lzxsvn:3000/qinyuanj/kacha/issues/5)；创建并回读 #6/#7，以 `tea api` 写入并回读原生依赖。
