import { describe, expect, it } from "vitest";
import type { BoardEdge } from "./board";
import { BUILTIN_TABLE, findModel, type ModelCapability, type WorkflowName } from "./capabilities";
import { applyHighlightOverlay, REGION_COLORS } from "./overlay";
import { expandImageEdges, firstRegionOf, slotsFromReferences, type SlotRef } from "./region";
import { planSend, promptLanguage, referenceProblemsOf } from "./sendPlan";

const flash = findModel(BUILTIN_TABLE, "doubao-seedream-5-0-flash-260915")!;

it("Flash 跨图坐标区域按输入顺序用图N，提示坐标端点为0–999", () => {
  const edges: BoardEdge[] = [
    { from: ["a", "out"], to: ["t", "image:0"], source_layer: null, system: false, extra: {}, region: { rects: [[0, 0, 1, 1]], render: "bbox_tag" } },
    { from: ["b", "out"], to: ["t", "image:1"], source_layer: null, system: false, extra: {}, region: { rects: [[0.25, 0.25, 0.75, 0.75]], render: "bbox_tag", coordinate_kind: "point" } },
  ];
  const plan = planSend(flash, expandImageEdges(edges, "highlight_overlay"), "Copy region 2 of Image 2 into region 1 of @图1, keep the rest unchanged", "");
  expect(plan.referenceCount).toBe(2);
  expect(plan.text).toContain("图1 <bbox>0 0 999 999</bbox>");
  expect(plan.text).toContain("图2 <point>500 500</point>");
  expect(plan.text).toContain("keep the rest unchanged");
  expect(plan.text).not.toContain("Image ");
});

it("Flash 同时编号坐标与叠加区域，双图展开后重建一致且拒绝坏坐标及引用", () => {
  const refs = [
    { source: { kind: "reference" }, region: { rects: [[0, 0, 1, 1] as [number, number, number, number]], render: "bbox_tag" as const, source_port: 1 } },
    { source: { kind: "reference" } },
    { source: { kind: "overlay" }, region: { rects: [[0.1, 0.1, 0.5, 0.5] as [number, number, number, number]], render: "highlight_overlay" as const, source_port: 2 } },
  ];
  const slots = slotsFromReferences(refs);
  const plan = planSend(flash, slots, "图2 的区域2复制到区域1，其余不变", "");
  expect(plan.text).toContain("图2 的黄色区域复制到图1 <bbox>0 0 999 999</bbox>");
  expect(plan.referenceCount).toBe(3);
  expect(plan.referenceProblems.issues).toEqual([]);
  expect(planSend(flash, slots, "图3，Image 0，区域3", "").referenceProblems.issues).toHaveLength(3);
  refs[0].region!.rects = [[-0.1, 0, 1, 1]];
  expect(planSend(flash, slotsFromReferences(refs), "图1", "").referenceProblems.issues).toContain("图1 的区域坐标无效，需要0–1范围内的非空矩形");
});

it("Flash 单图叠加的说明使用实际两图数量，所有区域输入拒绝坏坐标", () => {
  const slots = [image(1, 1), overlay(2, 1, 1, 1)];
  const plan = planSend(flash, slots, "把区域1改为红色", "");
  expect(plan.text).toContain("本次提供 2 张参考图，按顺序为图1、图2。");
  const edge: BoardEdge = { from: ["a", "out"], to: ["t", "image:0"], source_layer: null, system: false, extra: {}, region: { rects: [[0.8, 0, 0.2, 1]], render: "highlight_overlay" } };
  expect(planSend(flash, expandImageEdges([edge], "highlight_overlay"), "图1", "").referenceProblems.issues).toContain("图1 的区域坐标无效，需要0–1范围内的非空矩形");
});

const qwenPro = findModel(BUILTIN_TABLE, "qwen-image-3.0-pro")!;
const qwen = findModel(BUILTIN_TABLE, "qwen-image-3.0")!;
const seedreamPro = findModel(BUILTIN_TABLE, "doubao-seedream-5-0-pro-260628")!;
/** 没有区域固定句模板：发送文本 = 前缀 + 改写后的提示词，便于单看改写。 */
const noPhrases: ModelCapability = { ...qwenPro, region_hint_phrasing: {} };

const image = (port: number, userPort: number): SlotRef => ({ kind: "image", port, userPort, sourcePort: null, regionCount: 0 });
const overlay = (port: number, userPort: number, sourcePort: number, regionCount: number): SlotRef => ({ kind: "overlay", port, userPort, sourcePort, regionCount });

/** 去掉参考说明，只看改写后的用户指令。 */
const rewritten = (prompt: string, slots: SlotRef[]) => planSend(noPhrases, slots, prompt, "").text.split(/用户指令：\n|User instructions:\n/).at(-1)!.split("\n").slice(slots.filter((s) => s.kind === "image").length === 1 ? 0 : 1).join("\n");

const PHRASE_ZH = (overlay: number, source: number, colors: string) =>
  `图${overlay} 是图${source} 的标注版，${colors}半透明高亮标出的是要修改的区域。只修改图${source} 中高亮区域内的内容，高亮区域之外的所有内容保持完全不变，输出图里不要出现任何高亮颜色。`;
const PHRASE_EN = (overlay: number, source: number, colors: string) =>
  `Image ${overlay} is an annotated copy of Image ${source}; the translucent ${colors} highlights mark the areas to modify. Only change the content inside the highlighted areas of Image ${source}, keep everything outside them exactly unchanged, and do not show any highlight colors in the output.`;

/** 表驱动：每行给出提示词与期望的发送文本（负向行插在 head 与 tail 之间）。 */
interface Case {
  name: string;
  slots: SlotRef[];
  workflow: WorkflowName;
  zh: { prompt: string; head: string; tail: string };
  en: { prompt: string; head: string; tail: string };
}

const CASES: Case[] = [
  {
    name: "0 图",
    slots: [],
    workflow: "text_to_image",
    zh: { prompt: "一只橘猫", head: "一只橘猫", tail: "" },
    en: { prompt: "an orange cat", head: "an orange cat", tail: "" },
  },
  {
    name: "1 图",
    slots: [image(1, 1)],
    workflow: "image_edit",
    zh: { prompt: "把@图1 调亮", head: "本次提供一张参考图，编号为图1。请依据图1的视觉内容执行下方用户指令；指令中省略编号的图片指代均指图1。\n\n用户指定参考用途时，按指定用途使用图1。用户要求修改图片时，以图1为编辑基础，保留与修改要求无关的内容。\n\n用户指令：\n把图1 调亮", tail: "" },
    en: { prompt: "Make @图1 brighter", head: "This request provides one reference image, identified as Image 1. Use the visual content of Image 1 to follow the user instructions below; image references without a number in those instructions refer to Image 1.\n\nWhen the user specifies a reference purpose, use Image 1 for that purpose. When the user asks to modify the image, use Image 1 as the editing base and preserve content unrelated to the requested changes.\n\nUser instructions:\nMake Image 1 brighter", tail: "" },
  },
  {
    name: "2 图",
    slots: [image(1, 1), image(2, 2)],
    workflow: "image_edit",
    zh: { prompt: "把@图2的帽子戴到@图1头上", head: "本次提供 2 张参考图，按顺序为图1、图2。\n把图2的帽子戴到图1头上", tail: "" },
    en: { prompt: "Put the hat from @图2 on @图1", head: "This request provides 2 reference images, in order: Image 1, Image 2.\nPut the hat from Image 2 on Image 1", tail: "" },
  },
  {
    name: "1 图带区域",
    slots: [image(1, 1), overlay(2, 1, 1, 1)],
    workflow: "image_edit",
    zh: { prompt: "把@图1 的区域1 改成红色", head: "本次提供一张参考图，编号为图1。请依据图1的视觉内容执行下方用户指令；指令中省略编号的图片指代均指图1。\n\n用户指定参考用途时，按指定用途使用图1。用户要求修改图片时，以图1为编辑基础，保留与修改要求无关的内容。\n\n用户指令：\n把图1 的紫色区域 改成红色", tail: `\n${PHRASE_ZH(2, 1, "紫色")}` },
    en: { prompt: "Paint region 1 of @图1 red", head: "This request provides one reference image, identified as Image 1. Use the visual content of Image 1 to follow the user instructions below; image references without a number in those instructions refer to Image 1.\n\nWhen the user specifies a reference purpose, use Image 1 for that purpose. When the user asks to modify the image, use Image 1 as the editing base and preserve content unrelated to the requested changes.\n\nUser instructions:\nPaint the purple region of Image 1 red", tail: `\n${PHRASE_EN(2, 1, "purple")}` },
  },
  {
    name: "2 图带多区域（图1 两个区域、图2 一个）",
    slots: [image(1, 1), overlay(2, 1, 1, 2), image(3, 2), overlay(4, 2, 3, 1)],
    workflow: "image_edit",
    zh: {
      prompt: "区域1 放狐狸，区域2 放礼物盒，区域3 放路牌，@图2 当背景",
      head: "本次提供 4 张参考图，按顺序为图1、图2、图3、图4。\n紫色区域 放狐狸，黄色区域 放礼物盒，洋红色区域 放路牌，图3 当背景",
      tail: `\n${PHRASE_ZH(2, 1, "紫色、黄色")}\n${PHRASE_ZH(4, 3, "洋红色")}`,
    },
    en: {
      prompt: "region 1 gets a fox, region 2 a gift box, region 3 a sign, @图2 is the background",
      head: "This request provides 4 reference images, in order: Image 1, Image 2, Image 3, Image 4.\nthe purple region gets a fox, the yellow region a gift box, the magenta region a sign, Image 3 is the background",
      tail: `\n${PHRASE_EN(2, 1, "purple, yellow")}\n${PHRASE_EN(4, 3, "magenta")}`,
    },
  },
];

/** qwen 两个工作流都有原生负向；Seedream 都没有，负向拼进发送文本。 */
const MODELS: { model: ModelCapability; native: boolean }[] = [
  { model: qwenPro, native: true },
  { model: qwen, native: true },
  { model: seedreamPro, native: false },
  { model: flash, native: false },
];

const NEGATIVE = { zh: { text: "模糊", line: "\n避免出现：模糊" }, en: { text: "blurry", line: "\nAvoid: blurry" } };

it("单张用户参考图默认引用，按已确认文本说明参考用途与编辑基础", () => {
  const prompt = "把衣服改成红色";
  const plan = planSend(qwenPro, [image(1, 1)], prompt, "");
  expect(plan.text).toBe(
    "本次提供一张参考图，编号为图1。请依据图1的视觉内容执行下方用户指令；指令中省略编号的图片指代均指图1。\n\n用户指定参考用途时，按指定用途使用图1。用户要求修改图片时，以图1为编辑基础，保留与修改要求无关的内容。\n\n用户指令：\n把衣服改成红色",
  );
  expect(plan.referenceProblems).toEqual({ issues: [], warnings: [], unreferenced: [] });
  expect(plan.referenceCount).toBe(1);
});

describe("发送计划：4 个内置模型 × 参考图与区域 × 语言 × 负向", () => {
  for (const { model, native } of MODELS) {
    for (const c of CASES) {
      for (const language of ["zh", "en"] as const) {
        for (const withNegative of [true, false]) {
          it(`${model.model_id}｜${c.name}｜${language}｜${withNegative ? "有" : "无"}负向`, () => {
            const { prompt, head, tail } = c[language];
            const negative = withNegative ? NEGATIVE[language].text : "";
            const plan = planSend(model, c.slots, prompt, negative);
            const expected = `${head}${withNegative && !native ? NEGATIVE[language].line : ""}${tail}`;
            const flashHead = c.slots.length === 2 && c.slots[1].kind === "overlay" ? (language === "zh" ? "本次提供 2 张参考图，按顺序为图1、图2。\n把图1 的紫色区域 改成红色" : "This request provides 2 reference images, in order: 图1, 图2.\nPaint the purple region of 图1 red") : null;
            const flashExpected = flashHead === null ? expected.replace(/Image (\d+)/g, "图$1") : `${flashHead}${withNegative ? NEGATIVE[language].line : ""}${tail.replace(/Image (\d+)/g, "图$1")}`;
            expect(plan).toEqual({
              text: model === flash ? flashExpected : expected,
              nativeNegativePrompt: withNegative && native ? negative : null,
              workflow: c.workflow,
              negativeInlined: !native,
              referenceCount: c.slots.length,
              referenceProblems: { issues: [], warnings: [], unreferenced: [] },
            });
          });
        }
      }
    }
  }
});

describe("发送计划：「图N」改写", () => {
  it("中文提示词改写为「图N」，英文提示词改写为 Image N；不带 @ 的原样保留", () => {
    expect(rewritten("把@图2的帽子戴到@图1头上，图3 不动", [image(1, 1), image(2, 2), image(3, 3)])).toBe("把图2的帽子戴到图1头上，图3 不动");
    expect(rewritten("Put the hat from @图2 on @图1", [image(1, 1), image(2, 2)])).toBe("Put the hat from Image 2 on Image 1");
  });

  it("语言按用户文本（去掉 @图N 标记）里是否有汉字判定", () => {
    expect(promptLanguage("@图1 in watercolor")).toBe("en");
    expect(promptLanguage("@图1 水彩风格")).toBe("zh");
  });

  // 三张用户图，图1、图2 各带区域：发送序 图1 叠加 图2 叠加 图3 → 用户 1/2/3 对应发送 1/3/5。
  const three = [image(1, 1), overlay(2, 1, 1, 1), image(3, 2), overlay(4, 2, 3, 1), image(5, 3)];

  it("用户序号换算成发送序号：@图N、不带 @ 的图N、Image N 都换算", () => {
    expect(rewritten("把@图2的少女放入@图1，图3 当背景", three)).toBe("把图3的少女放入图1，图5 当背景");
    expect(rewritten("Put @图2 into image 1, keep Image 3", three)).toBe("Put Image 3 into image 1, keep Image 5");
  });

  it("前面是普通汉字的「图N」照常换算（把图2、放入图1）", () => {
    expect(rewritten("把图2的少女放入图1的框选区域", [image(1, 1), overlay(2, 1, 1, 1), image(3, 2)])).toBe("把图3的少女放入图1的框选区域");
  });

  it("以「图」结尾的词（地图、截图、示意图…）后接数字不算引用，原样保留", () => {
    expect(rewritten("沿着地图2 走，参考截图3 和示意图2，图2 放中间", three)).toBe("沿着地图2 走，参考截图3 和示意图2，图3 放中间");
  });

  it("越界序号原样保留（@ 照常去掉），交给校验标红", () => {
    expect(rewritten("@图4 和 图0", three)).toBe("图4 和 图0");
  });

  it("没有叠加槽时序号恒等：只改 @ 标记", () => {
    expect(rewritten("把@图2的帽子戴到@图1头上，图 3 不动，地图2", [image(1, 1), image(2, 2), image(3, 3)])).toBe("把图2的帽子戴到图1头上，图 3 不动，地图2");
  });

  it("前缀按实际张数；固定句在换算之后追加、不被二次换算", () => {
    const slots = [image(1, 1), overlay(2, 1, 1, 1), image(3, 2)];
    expect(planSend(qwenPro, slots, "把@图2的少女放入图1的区域1", "").text).toBe(
      `本次提供 3 张参考图，按顺序为图1、图2、图3。\n把图3的少女放入图1的紫色区域\n${PHRASE_ZH(2, 1, "紫色")}`,
    );
  });
});

describe("发送计划：区域改写与固定句", () => {
  const REGION = { rects: [[0.1, 0.1, 0.5, 0.5] as [number, number, number, number]], render: "highlight_overlay" as const };
  const edge = (port: number, region: typeof REGION | null = null): BoardEdge => ({ from: [`r${port}`, "out"], to: ["t", `image:${port}`], source_layer: null, region, system: false, extra: {} });

  it("从画板展开的槽：用户序号 → 发送序号跳过叠加图", () => {
    const two = { ...REGION, rects: [REGION.rects[0], REGION.rects[0]] };
    const slots = expandImageEdges([edge(0, two), edge(1), edge(2, REGION)], "highlight_overlay");
    expect(rewritten("看@图1、@图2、@图3", slots)).toBe("看图1、图3、图4");
    // 删除区域：恒等。
    expect(rewritten("看@图1、@图2、@图3", expandImageEdges([edge(0), edge(1), edge(2)], "highlight_overlay"))).toBe("看图1、图2、图3");
  });

  it("没有叠加槽时「区域N」是普通文字，不改写", () => {
    expect(planSend(qwenPro, [image(1, 1)], "把@图1 的区域1 调亮", "").text).toBe("本次提供一张参考图，编号为图1。请依据图1的视觉内容执行下方用户指令；指令中省略编号的图片指代均指图1。\n\n用户指定参考用途时，按指定用途使用图1。用户要求修改图片时，以图1为编辑基础，保留与修改要求无关的内容。\n\n用户指令：\n把图1 的区域1 调亮");
  });

  it("模型没有固定句模板时不追加固定句", () => {
    expect(planSend(noPhrases, [image(1, 1), overlay(2, 1, 1, 1)], "改区域1", "").text).toBe("本次提供一张参考图，编号为图1。请依据图1的视觉内容执行下方用户指令；指令中省略编号的图片指代均指图1。\n\n用户指定参考用途时，按指定用途使用图1。用户要求修改图片时，以图1为编辑基础，保留与修改要求无关的内容。\n\n用户指令：\n改紫色区域");
  });

  it("越界的区域编号原样保留", () => {
    expect(rewritten("区域1 和区域3", [image(1, 1), overlay(2, 1, 1, 2)])).toBe("紫色区域 和区域3");
  });

  it("跨模块：叠加图第 k 个框的颜色 ≡ 发送文本里区域 k 的颜色", () => {
    // 图1 两个框、图2 一个框：区域 1、2 在叠加图 2 上，区域 3 在叠加图 4 上。
    const slots = [image(1, 1), overlay(2, 1, 1, 2), image(3, 2), overlay(4, 2, 3, 1)];
    const first = firstRegionOf(slots);
    // 每个叠加图的每个框单独涂一张 1×1 白图，读出混合后的颜色，再反查区域编号。
    const colorIndexOfBox = (port: number, k: number) => {
      const rects = Array.from({ length: k + 1 }, (): [number, number, number, number] => [1, 1, 1, 1]);
      rects[k] = [0, 0, 1, 1];
      const px = applyHighlightOverlay(new Uint8Array([255, 255, 255, 255]), 1, 1, rects, first.get(port)!);
      return REGION_COLORS.findIndex(({ rgb }) => rgb.every((v, i) => Math.round(255 * 0.5 + v * 0.5) === px[i]));
    };
    const boxColors = slots.flatMap((s) => (s.kind === "overlay" ? Array.from({ length: s.regionCount }, (_, k) => colorIndexOfBox(s.port, k)) : []));
    const text = planSend(qwenPro, slots, "区域1；区域2；区域3", "").text.split("\n")[1];
    const textColors = text.split("；").map((name) => REGION_COLORS.findIndex((c) => name === `${c.zh}区域`));
    expect(boxColors).toEqual([0, 1, 2]);
    expect(textColors).toEqual(boxColors);
  });
});

describe("发送计划：引用问题", () => {
  const images = (n: number) => Array.from({ length: n }, (_, i) => image(i + 1, i + 1));
  const problems = (prompt: string, slots: SlotRef[], model: ModelCapability = qwenPro) => planSend(model, slots, prompt, "").referenceProblems;

  it("引用序号 > 已接参考图数 = 红；有线未被引用 = 黄", () => {
    expect(problems("把@图3 的颜色用到@图1 上", images(2))).toEqual({
      issues: ["提示词引用了图3，但只接了 2 张参考图"],
      warnings: ["图2 已连接，尚未说明它的用途。可在提示词中点击参考图插入引用，并描述如何使用它。"],
      unreferenced: [2],
    });
  });

  it("不带 @ 的「图N」/ Image N 也算引用", () => {
    expect(problems("把图2的帽子戴到 Image 1 头上", images(3)).unreferenced).toEqual([3]);
  });

  it("换算与校验同一口径：「地图2」不算引用图2，「把图2」算", () => {
    expect(problems("沿着地图2 走，把图1 调亮", images(2)).unreferenced).toEqual([2]);
    expect(problems("把图2 放进图1", images(2)).unreferenced).toEqual([]);
  });

  it("红只看 @图N：不带 @ 的「地图5」「image 5 of」不算越界", () => {
    expect(problems("沿着地图5 的路线，image 5 of the series，@图1", images(1))).toEqual({ issues: [], warnings: [], unreferenced: [] });
  });

  it("图0 越界", () => {
    expect(problems("@图0 @图1", images(1)).issues).toEqual(["提示词引用了图0，但只接了 1 张参考图"]);
  });

  it("叠加图不占用户序号：上限按用户连线数，固定句里的引用换回用户序号", () => {
    // 两张用户图，图2 带区域：固定句「图3 是图2 的标注版」让用户图2 算被引用。
    expect(problems("@图1", [image(1, 1), image(2, 2), overlay(3, 2, 2, 1)])).toEqual({ issues: [], warnings: [], unreferenced: [] });
    // 图1 带区域：固定句「图2 是图1 的标注版」只让用户图1 算引用；@图3 越界（只接了 2 张）。
    expect(problems("@图3", [image(1, 1), overlay(2, 1, 1, 1), image(3, 2)])).toMatchObject({ issues: ["提示词引用了图3，但只接了 2 张参考图"], unreferenced: [2] });
  });

  it("区域生效时「区域N」越界 = 红；没有叠加槽时不校验", () => {
    expect(problems("把区域3 调亮", [image(1, 1), overlay(2, 1, 1, 2)]).issues).toEqual(["提示词引用了区域3，但只框选了 2 个区域"]);
    expect(problems("把@图1 的区域3 调亮", images(1)).issues).toEqual([]);
  });

  it("模型缺失时也能算：没有固定句参与", () => {
    expect(referenceProblemsOf(undefined, [image(1, 1), image(2, 2)], "@图1")).toEqual({ issues: [], warnings: ["图2 已连接，尚未说明它的用途。可在提示词中点击参考图插入引用，并描述如何使用它。"], unreferenced: [2] });
    expect(referenceProblemsOf(qwenPro, [image(1, 1), image(2, 2)], "@图1")).toEqual(problems("@图1", images(2)));
  });
});
