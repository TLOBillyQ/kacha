# 生成尺寸行为：任意尺寸、编辑默认尺寸、提示词写尺寸（2026-09-18）

> 范围：内置能力表 `client/src/core/capabilities.builtin.json` 里的 4 个模型：`qwen-image-3.0-pro`、`qwen-image-3.0`、`doubao-seedream-5-0-pro-260628`、`doubao-seedream-5-0-lite-260128`。`docs/model-matrix.md` 里的 wan / z-image 等模型没有进入能力表，客户端无法选用，这里不讨论。
> 来源：千问 AI 平台官方文档（2026-09-18 抓取），火山方舟官方文档（通过文档中心 `getDocDetail` 接口取原文，文档 `UpdatedTime` 为 2026-09-09）。下文凡标「文档」的都是原文陈述；标「未见文档」的，表示在所列一手来源里没有找到对应说法；标「实测」的，证据在本仓库 `contracts/fixtures/`。

## 1. 总表

| 模型 | 任意尺寸？约束 | 编辑时不传 size 的默认 | 提示词写尺寸 / 比例是否有效 | 本项目当前传参 |
|---|---|---|---|---|
| `qwen-image-3.0-pro` / `qwen-image-3.0` | **是**，在范围内可「自由设置宽度和高度」。格式 `宽*高`，总像素 512×512–2048×2048，宽高比 1:8–8:1。没写步长要求（「自动调整为 16 的倍数」这句只针对 edit-max/plus） | 文档：「不指定时由模型根据提示词自动推荐分辨率」，**不跟随输入图**。同一页 `content` 字段的说明又写「输出图像的宽高比由最后一张图像决定」，两处矛盾 | **不传 size 时有效**（文档明确说由提示词推荐分辨率）。传了 size 之后提示词能不能改尺寸，未见文档；实测 size 会覆盖输入图比例 | 每次都显式传：文生图顶层 `size: "WxH"`，编辑 `parameters.size: "W*H"` |
| Seedream 5.0 pro | **是，但分两种方式，不能混用**。① 档位 `1K`/`1.5K`/`2K`（默认 `2K`），具体宽高由模型决定；② `宽x高`，总像素 [921600, 4624220]，宽高比 [1/16, 16]。没写步长要求 | 普通生成 / 编辑：未见「跟随输入图」的说明，文档只给默认 `2K`。只有图层拆分场景有 `auto`（按输入图尺寸和比例输出） | **档位模式下有效，这是官方推荐用法**：「在 prompt 中用自然语言描述图片宽高比、图片形状或图片用途，最终由模型判断生成图片的大小」。像素模式下提示词是否起作用，未见文档 | 每次都显式传 `size: "WxH"`（像素模式），**不用档位模式** |
| Seedream 5.0 lite | 同上。① 档位 `2K`/`3K`/`4K`；② `宽x高`，总像素 [3686400, 16777216]，宽高比 [1/16, 16]，默认值 `2048x2048`（这个默认值本身低于它的像素下限，是文档内部矛盾） | 未见「跟随输入图」的说明 | 同 pro：档位模式下有效，像素模式未见文档 | 同 pro |

结论：

1. **尺寸基本是任意的**：四个模型都接受范围内的任意宽高，约束是总像素区间加宽高比区间，都没有写步长要求。本项目 UI 只提供「档位 × 比例」预设（`client/src/ui/nodes.tsx:499-520`），没有自定义宽高输入框，所以用户实际上只能选表里的那些尺寸。
2. **编辑时默认不按输入图尺寸**：qwen-image-3.0 文档写的是「由提示词推荐」；Seedream 只写了默认档位 `2K`，没说跟随输入图（跟随输入图只在 pro 的图层拆分 `auto` 里出现）。只有旧模型 qwen-image-2.0（不在能力表里）文档写「默认与输入图像相同」。不过这些默认值对本项目不起作用，因为**客户端每次都显式传 size**。
3. **提示词写尺寸**：只有「不传 size（qwen-image-3.0）」和「只传档位（Seedream）」这两种情况，文档明确说提示词会影响输出尺寸。本项目两种情况都没用到：每次都传精确像素，所以在提示词里写「16:9」或「1024x1536」有没有作用，**没有一手文档依据**，需要冒烟才能下结论。

## 2. 本项目客户端实际发什么

- 尺寸规则来自能力表 `size_rule`：`tiers`（档位 → 比例 → `[宽, 高]`）加 `custom`（像素范围）。`client/src/core/capabilities.ts:32-36`。
- 发送前由 `resolveSize` 换算成像素，档位或比例不在表里就返回 null，任务不可运行（`client/src/core/size.ts:30-38`，`client/src/core/run.ts:100-101`）。
- **新建任务的默认尺寸**是表里第一个档位的第一个比例（`client/src/core/size.ts:40-45`；文生图见 `client/src/core/dragCreate.ts:67`）。按当前表：qwen 两款为 `1K 1:1 = 1024x1024`，Seedream pro 为 `1K 1:1 = 1024x1024`，Seedream lite 为 `2K 1:1 = 2048x2048`。
- **从结果或参考图发起编辑**（`client/src/core/iterate.ts:52-58`）：从结果节点发起时，继承产出它的任务的 `size_spec`（档位 + 比例），前提是新模型的尺寸表里有这个组合，否则回落到上面的默认值；从参考图节点发起时直接用默认值。**任何路径都不会读取输入图的宽高来设定生成尺寸。** 所以对一张 16:9 的参考图做编辑，默认发出的是 1:1。
- 请求体：
  - qwen 文生图：顶层 `size: "${w}x${h}"`（`client/src/core/gateway.ts:159`）。
  - qwen 编辑：JSON 透传 `parameters.size: "${w}*${h}"`（`client/src/core/gateway.ts:171`；ADR 0006）。
  - Seedream：文生图和编辑都用顶层 `size: "${w}x${h}"`（`client/src/core/gateway.ts:186`），不发 `2K` 这类档位字符串。
- 实测证据：
  - qwen 编辑时 `parameters.size=1024*1024`，输入 800x400（2:1），输出 1024x1024。说明 size 优先于输入图比例（`docs/contracts/team-gateway-contract.md` 2026-08-29 条目）。
  - Seedream 请求 `2400x800`（pro）和 `3456x1152`（lite），返回的 `data[].size` 与请求完全一致（`contracts/fixtures/2026-09-17-team-gateway-seedream/*-region-*.json`）。这组夹具的输入图本身也是 3:1，所以只能证明像素值被原样执行，不能证明 size 会覆盖输入图比例。
  - Seedream 传 `size:"2K"` 加 1 张输入图，两款模型都返回 2048x2048（`*-probe-gen-img.json`）。输入图宽高和提示词在夹具里已脱敏，无法据此判断档位模式下是否跟随输入图。

## 3. qwen-image-3.0 / 3.0-pro（千问 AI 平台 / DashScope）

- 图像编辑 API 参考 `parameters.size`：「qwen-image-3.0 系列：总像素在 512\*512 到 2048\*2048 之间，宽高比在 1:8 到 8:1 之间，不指定时由模型根据提示词自动推荐分辨率。qwen-image-2.0 系列：……默认与输入图像相同（多图请求以最后一张图像为准）。qwen-image-edit-max/plus：……宽高比与输入图像相近，自动调整为最近的 16 的倍数。」推荐尺寸：`1024*1024`、`768*1152`/`1024*1536`、`1152*768`/`1536*1024`、`720*1280`/`1080*1920`、`1280*720`/`1920*1080`。[qwen-image-editing API](https://platform.qianwenai.com/docs/api-reference/image-generation/qwen-image-editing)
- 同一页 `input.messages.content` 的说明：「多图输入时，图像按位置引用（图像 1、图像 2、图像 3），输出图像的宽高比由最后一张图像决定。」这句没有区分模型，和上面 3.0「由提示词推荐」的说法矛盾。同上。
- 图像编辑指南：「对于 qwen-image-2.0/3.0 系列模型，可以自由设置宽度和高度，输出图片的总像素须在 512 x 512 至 2048 x 2048 之间。qwen-image-2.0 系列默认分辨率与输入图片相同（多张图片时取最后一张）；qwen-image-3.0 系列不指定时由模型根据提示词自动推荐分辨率。」输入图建议宽高在 384–3072 px。[图像编辑指南](https://platform.qianwenai.com/docs/developer-guides/image-generation/image-editing)
- 文生图指南的分辨率表：qwen-image-3.0 系列为自定义 `"宽*高"`，范围 `512*512 – 2048*2048`，默认「由模型根据提示词自动推荐」，宽高比 `1:8 – 8:1`。「2K」推荐分辨率：16:9 = `2688*1536`、9:16 = `1536*2688`、4:3 = `2368*1728`、3:4 = `1728*2368`、1:1 = `2048*2048`。[文生图指南](https://platform.qianwenai.com/docs/developer-guides/image-generation/text-to-image)
- 文生图 API 参考的 `parameters.size` 字段头写「默认值 "2048\*2048"」，正文却写 3.0「不指定时由模型根据提示词自动推荐分辨率」，页内自相矛盾。[qwen-text-to-image API](https://platform.qianwenai.com/docs/api-reference/image-generation/qwen-text-to-image)
- 计费档位：`usage.output_image_type` 按输出面积判断，「面积不大于 2,250,000 为 qima_output_1k，大于 2,250,000 为 qima_output_2k」。[qwen-image-editing API](https://platform.qianwenai.com/docs/api-reference/image-generation/qwen-image-editing)
- 提示词写比例：文生图指南的官方示例提示词里出现过「整体采用 16:9 的宽屏比例」「宽高比为 16:9 的专业教育类 PPT 幻灯片」，但示例代码同时传了 `size`。文档没有说明传了 size 之后提示词里的比例会不会生效，也没有说明冲突时谁优先。

**与本项目的出入**：能力表 qwen 的「2K」档里，16:9 / 9:16 是 `1920x1080` / `1080x1920`，面积 2,073,600，低于 2,250,000，按官方口径属于 1K 计量档；官方 2K 档的 16:9 是 `2688*1536`。`custom` 范围（262144–4194304，1/8–8）和文档一致。

## 4. Seedream 5.0 pro / lite（火山方舟）

- API 参考 `size`，Seedream 5.0 pro（图片生成场景）：「支持以下两种方式，不可混用：方式 1（推荐）：指定分辨率档位，并在 prompt 中用自然语言描述图片宽高比、图片形状或图片用途，最终由模型判断生成图片的大小。默认值：`2K`；可选值：`1K`、`1.5K`、`2K`。方式 2：指定宽高像素值（`宽x高`）。总像素取值范围：[`1280x720`（921600）, `2048x2048x1.1025`（4624220）]；宽高比取值范围：[1/16, 16]。」档位映射表注明「不限于以下标准值，仅列常见」。[图片生成 API](https://www.volcengine.com/docs/82379/1541523)
- 同页 Seedream 5.0 lite：方式 1 可选 `2K`、`3K`、`4K`；方式 2「默认值：`2048x2048`；总像素取值范围：[`2560x1440`（3686400）, `4096x4096`（16777216）]；宽高比 [1/16, 16]」。文档自己给的无效示例是 `1500x1500`（低于下限）。同上。
- 同页 pro 图层拆分场景：「默认值：`auto`；可选值：`1K`、`1.5K`、`2K`、`auto`（根据输入图的尺寸和宽高比进行输出）」，底图输出「和原待拆分图的宽高比一致」。**这是 Seedream 文档里唯一一处说输出跟随输入图尺寸的地方，只适用于图层拆分。** 同上。
- 图片生成教程重复了方式 1 的说法：「使用方式 1 并在 prompt 中描述特定宽高比时，模型实际映射的宽高像素参考值如下表所示（模型支持生成的宽高比不限于以下列举的标准值……）」；编辑能力的列举里包括「改变背景/视角/尺寸等」。[图片生成教程](https://www.volcengine.com/docs/82379/1824121)，[5.0 pro 教程](https://www.volcengine.com/docs/82379/2582774)
- 提示词指南「参考图生图」的官方示例提示词里写了「……**生成尺寸和现在图一样**；手办在图片的左边……」。这是官方示例用提示词要求输出和输入图同尺寸；但示例没有给出请求里的 `size` 值，也没有文字说明这种写法的作用范围。[提示词指南](https://www.volcengine.com/docs/82379/1829186)
- 单张输入图要求（与输出无关）：宽高比 [1/16, 16]，边长大于 14 px，总像素 [196, 3600 万]。[图片生成 API](https://www.volcengine.com/docs/82379/1541523)

**与本项目的出入**：客户端 UI 上叫「档位」，但发给 Seedream 的是换算好的像素（方式 2），不是档位字符串（方式 1）。所以官方推荐的「档位 + 提示词描述比例」这条路径，本项目从来没有走过。能力表里的像素值取自官方方式 1 的映射表，都在方式 2 的合法范围内。

## 5. 一手来源没有覆盖的点（需要冒烟）

1. 显式传了像素 size 之后，提示词里写的「16:9」「1024x1536」「生成尺寸和原图一样」能否改变输出尺寸或比例。四个模型都没有文档说明。从 API 语义推断，输出像素应该由 size 决定，提示词最多影响画面内的构图，但这只是推断。
2. Seedream 普通编辑（非图层拆分）只传档位、提示词里不描述比例时，输出会不会跟随输入图比例。
3. qwen-image-3.0 编辑时不传 size，到底是「由提示词推荐」还是「跟随最后一张图」（API 参考两处说法矛盾）。另外，团队网关 new-api 在不传 size 时是否会自己补一个默认值，也没有实测过。
4. 各模型是否存在没写进文档的步长或取整（比如对齐到 16 的倍数）。已知实测里，2400x800 和 3456x1152 都按原值返回。

## 来源

- 千问 AI 平台：图像编辑指南 <https://platform.qianwenai.com/docs/developer-guides/image-generation/image-editing>
- 千问 AI 平台：Qwen 图像编辑 API 参考 <https://platform.qianwenai.com/docs/api-reference/image-generation/qwen-image-editing>
- 千问 AI 平台：文生图指南 <https://platform.qianwenai.com/docs/developer-guides/image-generation/text-to-image>
- 千问 AI 平台：Qwen 文生图 API 参考 <https://platform.qianwenai.com/docs/api-reference/image-generation/qwen-text-to-image>
- 火山方舟：图片生成 API <https://www.volcengine.com/docs/82379/1541523>
- 火山方舟：图片生成教程 <https://www.volcengine.com/docs/82379/1824121>
- 火山方舟：Doubao Seedream 5.0 pro 教程 <https://www.volcengine.com/docs/82379/2582774>
- 火山方舟：Seedream 4.0–5.0 提示词指南 <https://www.volcengine.com/docs/82379/1829186>
- 本仓库：`client/src/core/gateway.ts`、`client/src/core/size.ts`、`client/src/core/iterate.ts`、`client/src/core/capabilities.builtin.json`、`docs/contracts/team-gateway-contract.md`、`contracts/fixtures/2026-09-17-team-gateway-seedream/`
