// 发送计划：一处决定「模型 + 端口槽 + 提示词 → 发什么」。二次确认展示的、任务记录保存的、请求发出的都是它的发送文本。
// 不认识画板、不认识 task.json：调用方给出模型与已展开的端口槽（画板上由 expandImageEdges、重新生成时由 slotsFromReferences 构造）。
// 两套序号：用户序号（「图N」，只数用户图片连线）与发送序号（叠加图紧随原图的实际发送顺序）；发送文本里一律是发送序号。
// 文本改写与引用校验共用同一正则、同一组固定句、同一张用户序号 → 发送序号换算表。
import { isSupported, workflowFor, type ModelCapability, type WorkflowName } from "./capabilities";
import { REGION_COLORS } from "./overlay";
import { firstRegionOf, type SlotRef } from "./region";

export type PromptLanguage = "zh" | "en";

/** 提示词里的「图N」/「区域N」引用问题：红 = 不可运行，黄 = 仅提示。任务节点角标与二次确认共用。 */
export interface ReferenceProblems {
  issues: string[];
  warnings: string[];
  /** 有线但提示词没提到的用户序号。 */
  unreferenced: number[];
}

export interface SendPlan {
  /** 发送文本：有参考图时含参考说明；negativeInlined 时含「避免出现：」一行；区域固定句追加在末尾。 */
  text: string;
  /** 走请求体原生字段的负向提示词；负向拼进文本或为空时为 null。 */
  nativeNegativePrompt: string | null;
  workflow: WorkflowName;
  /** 该工作流下模型不支持原生负向：负向（非空时）拼进发送文本。 */
  negativeInlined: boolean;
  /** 实际发给模型的参考图张数（含叠加图）。 */
  referenceCount: number;
  referenceProblems: ReferenceProblems;
}

/** 按提示词决定发什么：发送文本、负向去向与引用问题。 */
export function planSend(model: ModelCapability, slots: SlotRef[], prompt: string, negativePrompt: string): SendPlan {
  const language = promptLanguage(prompt);
  const workflow = workflowFor(slots.length);
  const negativeInlined = !isSupported(model.workflows[workflow].supports_negative_prompt);
  const phrases = [...overlayPhrases(model, slots, language), ...coordinatePhrases(slots, language)];
  const rewritten = rewriteRegionRefs(rewriteImageRefs(prompt, imageRefMap(slots)), regionNames(slots, language));
  const note = imageRefMap(slots).length === 1 && !(model.request_shape === "seedream_flash_images_generations" && slots.length > 1) ? singleImageNote(language) : referenceNote(slots.length, language);
  const withNote = slots.length === 0 ? rewritten : `${note}\n${rewritten}`;
  const negative = negativeInlined && negativePrompt ? `\n${language === "en" ? "Avoid: " : "避免出现："}${negativePrompt}` : "";
  return {
    text: officialReferences(`${withNote}${negative}${phrases.length ? `\n${phrases.join("\n")}` : ""}`, model),
    nativeNegativePrompt: !negativeInlined && negativePrompt ? negativePrompt : null,
    workflow,
    negativeInlined,
    referenceCount: slots.length,
    referenceProblems: referenceProblemsOf(model, slots, prompt),
  };
}

/**
 * 引用问题；模型缺失时（没有发送计划）也要给任务节点角标用，此时没有固定句。
 * 全部按用户序号判断：区域叠加图没有用户序号，不参与黄检查，也不能被用户引用；固定句按发送序号书写，换回用户序号再算引用。
 */
export function referenceProblemsOf(model: ModelCapability | undefined, slots: SlotRef[], prompt: string): ReferenceProblems {
  const language = promptLanguage(prompt);
  const map = imageRefMap(slots);
  const count = map.length;
  const injected = [...referencedIndexes(model ? overlayPhrases(model, slots, language) : [])].flatMap((s) => {
    const user = map.indexOf(s);
    return user < 0 ? [] : [user + 1];
  });
  const referenced = new Set([...referencedIndexes([prompt]), ...injected]);
  // 红是硬阻断，只认用户明确写的 @图N；「地图5」之类的普通文字不拦。
  const tagged = new Set([...prompt.matchAll(model?.request_shape === "seedream_flash_images_generations" ? REFERENCE : TAG)].map((m) => Number(m.groups ? m.groups.tagged ?? m.groups.zhN ?? m.groups.enN : m[1])));
  const outOfRange = [...tagged].filter((n) => n < 1 || n > count).sort((a, b) => a - b);
  const unreferenced = count === 1 ? [] : Array.from({ length: count }, (_, i) => i + 1).filter((n) => !referenced.has(n));
  // 只有区域真的生效（叠加槽存在）时才校验「区域N」；没有框选时这两个字是普通文字。
  const regions = regionNames(slots, language).length;
  const regionIssues = regions > 0 ? referencedRegions(prompt).filter((n) => n < 1 || n > regions).map((n) => `提示词引用了区域${n}，但只框选了 ${regions} 个区域`) : [];
  return {
    issues: [...outOfRange.map((n) => `提示词引用了图${n}，但只接了 ${count} 张参考图`), ...regionIssues,
      ...slots.filter((s) => {
        const region = s.regionData ?? s.coordinateRegion;
        return region && (region.coordinate_kind !== undefined && !["point", "bbox"].includes(region.coordinate_kind) || region.rects.some((r) => !Array.isArray(r) || r.length !== 4 || r.some((n) => !Number.isFinite(n) || n < 0 || n > 1) || r[0] >= r[2] || r[1] >= r[3]));
      }).map((s) => `图${s.userPort} 的区域坐标无效，需要0–1范围内的非空矩形`)],
    warnings: unreferenced.map((n) => `图${n} 已连接，尚未说明它的用途。可在提示词中点击参考图插入引用，并描述如何使用它。`),
    unreferenced,
  };
}

// ---- 「图N」：改写与校验共用 ----

const TAG = /@图\s*(\d+)/g;
/** 以「图」结尾的常见词：后面跟数字也不是在引用参考图（「地图2」「截图3」「示意图2」）。 */
const NOT_A_REF = "地|插|配|附|草|截|蓝|构|视|贴|拼|制|绘|作|底|示意|效果|线稿|素材|分镜|流程";
/**
 * 算作引用的写法：`@图N`、不带 @ 的「图N」（前面是 NOT_A_REF 里的词时不算）、`Image N`（不区分大小写）。
 * 换算与黄检查共用，保证「算作引用」的就一定被换算。
 */
const REFERENCE = new RegExp(`@图\\s*(?<tagged>\\d+)|(?<!${NOT_A_REF})(?<zhWord>图\\s*)(?<zhN>\\d+)|(?<enWord>\\bimage\\s*)(?<enN>\\d+)`, "gi");

/** 语言按用户文本（去掉 @图N 标记）里是否有汉字判定。 */
export function promptLanguage(prompt: string): PromptLanguage {
  return /\p{Script=Han}/u.test(prompt.replace(TAG, "")) ? "zh" : "en";
}

/** 用户序号 → 发送序号：第 N-1 项为用户图N 的发送序号。没有叠加槽时为恒等。 */
function imageRefMap(slots: SlotRef[]): number[] {
  return slots.filter((s) => s.kind === "image").map((s) => s.port);
}

/** `@图N` 按语言改写（中文「图N」、英文 `Image N`），用户序号换算成发送序号；越界序号原样保留（由校验标红）。 */
function rewriteImageRefs(prompt: string, map: number[]): string {
  const word = promptLanguage(prompt) === "zh" ? "图" : "Image ";
  const send = (n: number) => map[n - 1] ?? n;
  return prompt.replace(REFERENCE, (match, ...args) => {
    const { tagged, zhWord, zhN, enWord, enN } = args[args.length - 1] as Record<string, string | undefined>;
    if (tagged !== undefined) return `${word}${send(Number(tagged))}`;
    const [prefix, digits] = zhN !== undefined ? [zhWord, zhN] : [enWord, enN];
    const n = Number(digits);
    return send(n) === n ? match : `${prefix}${send(n)}`;
  });
}

function referencedIndexes(texts: string[]): Set<number> {
  const out = new Set<number>();
  for (const text of texts) for (const m of text.matchAll(REFERENCE)) out.add(Number(m.groups!.tagged ?? m.groups!.zhN ?? m.groups!.enN));
  return out;
}

function singleImageNote(language: PromptLanguage): string {
  return language === "zh"
    ? "本次提供一张参考图，编号为图1。请依据图1的视觉内容执行下方用户指令；指令中省略编号的图片指代均指图1。\n\n用户指定参考用途时，按指定用途使用图1。用户要求修改图片时，以图1为编辑基础，保留与修改要求无关的内容。\n\n用户指令："
    : "This request provides one reference image, identified as Image 1. Use the visual content of Image 1 to follow the user instructions below; image references without a number in those instructions refer to Image 1.\n\nWhen the user specifies a reference purpose, use Image 1 for that purpose. When the user asks to modify the image, use Image 1 as the editing base and preserve content unrelated to the requested changes.\n\nUser instructions:";
}

function referenceNote(count: number, language: PromptLanguage): string {
  if (language === "en") {
    if (count === 1) return "This request provides 1 reference image.";
    const ordered = Array.from({ length: count }, (_, i) => `Image ${i + 1}`).join(", ");
    return `This request provides ${count} reference images, in order: ${ordered}.`;
  }
  if (count <= 1) return `本次提供 ${count} 张参考图。`;
  const ordered = Array.from({ length: count }, (_, i) => `图${i + 1}`).join("、");
  return `本次提供 ${count} 张参考图，按顺序为${ordered}。`;
}

// ---- 「区域N」与区域固定句 ----

const colorName = (index: number, language: PromptLanguage) => REGION_COLORS[index % REGION_COLORS.length][language];

/**
 * 每个叠加槽一句区域固定句，模板取自能力表 region_hint_phrasing.highlight_overlay；无模板时为空。
 * 占位符：{overlay} 叠加图序号、{source} 原图序号、{colors} 该图各区域的颜色名。
 */
function overlayPhrases(model: ModelCapability, slots: SlotRef[], language: PromptLanguage): string[] {
  const template = model.region_hint_phrasing.highlight_overlay?.[language];
  if (!template) return [];
  const first = firstRegionOf(slots);
  return slots
    .filter((s) => s.kind === "overlay")
    .map((s) => {
      const colors = Array.from({ length: s.regionCount }, (_, k) => colorName(first.get(s.port)! + k, language)).join(language === "zh" ? "、" : ", ");
      return template.split("{source}").join(String(s.sourcePort)).split("{overlay}").join(String(s.port)).split("{colors}").join(colors);
    });
}

/** 区域编号 → 发送文本里的指代（区域1 → 紫色区域 / the purple region），按区域编号排列。 */
function officialReferences(text: string, model: ModelCapability): string {
  return model.request_shape === "seedream_flash_images_generations" ? text.replace(/\bImage\s*(\d+)/gi, "图$1") : text;
}

function coordinateName(slot: SlotRef, index: number): string {
  const rect = slot.coordinateRegion!.rects[index];
  const q = (n: number) => Math.round(n * 999);
  return slot.coordinateRegion!.coordinate_kind === "point"
    ? `图${slot.port} <point>${q((rect[0] + rect[2]) / 2)} ${q((rect[1] + rect[3]) / 2)}</point>`
    : `图${slot.port} <bbox>${rect.map(q).join(" ")}</bbox>`;
}

function coordinatePhrases(slots: SlotRef[], language: PromptLanguage): string[] {
  return slots.filter((s) => s.coordinateRegion).map((s) => {
    const names = s.coordinateRegion!.rects.map((_, i) => coordinateName(s, i)).join(language === "zh" ? "、" : ", ");
    return language === "zh" ? `区域指示：${names}。按用户指令修改或保持这些区域，未要求修改的内容保持不变。` : `Region indicators: ${names}. Modify or preserve these regions as instructed; keep content unchanged where no change is requested.`;
  });
}

function regionNames(slots: SlotRef[], language: PromptLanguage): string[] {
  const first = firstRegionOf(slots);
  return slots.flatMap((s) => Array.from({ length: s.regionCount }, (_, i) => s.coordinateRegion ? coordinateName(s, i) : (language === "zh" ? `${colorName(first.get(s.port)! + i, language)}区域` : `the ${colorName(first.get(s.port)! + i, language)} region`)));
}

const REGION_REF = /区域\s*(\d+)|\bregion\s*(\d+)/gi;

/** 「区域N」/「Region N」改写为颜色指代；越界的编号原样保留（由校验标红）。 */
function rewriteRegionRefs(text: string, names: string[]): string {
  if (names.length === 0) return text;
  return text.replace(REGION_REF, (match, zh?: string, en?: string) => names[Number(zh ?? en) - 1] ?? match);
}

/** 提示词引用的区域编号（1 起）。 */
function referencedRegions(text: string): number[] {
  return [...new Set([...text.matchAll(REGION_REF)].map((m) => Number(m[1] ?? m[2])))].sort((a, b) => a - b);
}
