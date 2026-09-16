# Seedream 5.0 系列：能力表相关事实（2026-09-16）

来源（火山引擎方舟官方文档，经文档中心 JSON 接口 `getDocDetail` 抓取原文）：

- 提示词指南 [82379/1829186](https://www.volcengine.com/docs/82379/1829186)（Seedream 4.0–5.0 通用）
- 图片生成 API 参考 [82379/1541523](https://www.volcengine.com/docs/82379/1541523)
- 图片生成教程 [82379/1824121](https://www.volcengine.com/docs/82379/1824121)
- Seedream 5.0 pro 教程 [82379/2582774](https://www.volcengine.com/docs/82379/2582774)
- 5.0 pro 交互编辑指南 [82379/2582775](https://www.volcengine.com/docs/82379/2582775)

以下均为官方文档陈述；团队网关 new-api 是否原样透传，待 #79 冒烟。

## 模型 ID 与总览

| | 5.0 pro | 5.0 lite | 4.5 | 4.0 |
|---|---|---|---|---|
| Model ID | `doubao-seedream-5-0-pro-260628` | `doubao-seedream-5-0-260128`（别名 `-lite-`） | `doubao-seedream-4-5-251128` | `doubao-seedream-4-0-250828` |
| 参考图上限 | **10** | **14** | 14 | 14 |
| 分辨率档位 | 1K / 1.5K / 2K | 2K / 3K / 4K | 2K / 4K | 1K / 2K / 4K |
| 像素模式总像素范围 | [921600, 4624220] | [3686400, 16777216] | 同 lite | [921600, 16777216] |
| 宽高比 | [1/16, 16] | 同 | 同 | 同 |
| 输出格式 | png / jpeg | png / jpeg | jpeg | jpeg |
| 组图 `sequential_image_generation` | 不支持 | 支持 | 支持 | 支持 |
| 流式 | 不支持 | 支持 | 支持 | 支持 |
| 交互编辑（坐标 / 标记） | **支持** | ✗ | ✗ | ✗ |
| 图层拆分 `layer_decomposition` | 支持（1 底图 + ≤16 图层） | ✗ | ✗ | ✗ |
| 联网搜索 `tools: web_search` | ✗ | 支持 | ✗ | ✗ |
| 限流 IPM | 500 张/分钟/模型 | 500 | 500 | 500 |

端点：`POST /api/v3/images/generations`，单端点同时承担文生图与图生图（`image` 可选），无独立编辑端点。

## 请求参数（与本项目相关）

- `prompt` string：图片生成必选；建议中文 ≤300 字 / 英文 ≤600 词。
- `image` string | string[]：URL 或 `data:image/<fmt>;base64,...`。单张要求：格式 jpeg/png/webp/bmp/tiff/gif/heic/heif，宽高比 [1/16,16]，边长 >14 px，≤30 MB，总像素 [196, 3600 万]。
- `size` string：两种方式不可混用。方式 1 = 档位（`"2K"`）+ 提示词里自然语言写宽高比；方式 2 = `宽x高`，须同时满足总像素范围与宽高比范围。各档位 × 比例的官方像素映射表见 API 参考（例：lite 2K 16:9 = 2848x1600；pro 2K 1:1 = 2048x2048；4.0 1K 16:9 = 1280x720）。
- `watermark` boolean，**默认 true**（右下角「AI 生成」）。
- `output_format` png/jpeg，默认 jpeg（仅 5.0）。
- `response_format` url / b64_json；**URL 24 小时失效**。
- `sequential_image_generation` disabled/auto，默认 disabled；`sequential_image_generation_options.max_images` [1,15]；参考图数 + 生成数 ≤ 15。
- `optimize_prompt_options.mode` standard/fast（lite、4.5 不支持 fast）。
- `background` transparent/opaque（仅 pro，仅单张带透明通道输入）。
- **没有** `negative_prompt`、`seed`、`n`、`mask` 参数。

## 多轮与参考图指代

- 文档未提供会话/多轮参数；单次请求无状态。与 qwen 一致，「结果回灌」路线成立。
- 官方多图写法：提示词指南用「**图一 / 图二 / 图三**」（汉字），教程与 5.0 pro 指南用「**图1 / 图 1**」（数字，可带空格）。英文写法未见官方示例。
- 局部编辑（所有 Seedream 4.0+）：提示词指南明确「可采用**箭头、线框、涂鸦**等方式指明编辑对象和位置」，标记直接画在输入图上，示例「将房间内红色涂抹位置放入电视，蓝色涂抹位置放入沙发」「放大标题至红框大小」。**不占额外参考图名额**（标记在原图上）。

## 5.0 pro 交互编辑（坐标标签）

- 在 prompt 内写归一化坐标，范围 **0–999**（图片宽高各等分 1000 份，左上 0,0，右下 999,999）。
- 点选 `<point>x y</point>`：模型自行判断影响范围。框选 `<bbox>x1 y1 x2 y2</bbox>`：精确区域。
- 跨图：`将图 1 <bbox>179 283 796 986</bbox> 的主体放到图 2 <bbox>118 331 933 871</bbox> 位置`。
- 可框出「保持不变」区域并在 prompt 中声明。
- 也接受形式 1：在图上手绘标记 + 自然语言（「在蓝色框内添加一个电视机」）。
- 官方 demo 是 Web 画布（Client → World → Normalized 三级坐标换算），与 React Flow 场景同构。

## 对 #61 能力表的直接影响

1. **参考图上限跨度大**（qwen 3 / pro 10 / lite 14）：`max_references` 必须按模型取值，Autogrow 端口需容纳 14。
2. **尺寸规则不再是一套预设 + 一个像素区间**：Seedream 有档位模式与像素模式，且 lite 的像素下限 3686400 让 qwen 的 1024x1024 预设非法。能力表尺寸规则需按模型给「档位 × 比例 → 像素」表或直接给像素预设。
3. **区域指示是三档而非布尔**：qwen = 高亮叠加参考图（占名额）；Seedream lite/4.x = 图上标记（不占名额，效果待冒烟）；5.0 pro = 坐标标签（不占名额，官方支持）。
4. **措辞**：中文「图N」与官方一致；英文 `Image N` 无官方背书，标待测。
5. **固定必发字段**：`watermark=false`、`sequential_image_generation="disabled"`（lite/4.x）、`response_format`；`output_format` 仅 5.0 可发。
6. **无负向提示词**：Seedream 全系 `supports_negative_prompt=false`，负向提示词端口对这些模型需要隐藏或并入正向文本。
7. 图层拆分、透明背景、联网搜索、组图：新能力，不在当前目的地内，需在地图上定去留。
