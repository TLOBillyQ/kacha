// 区域指示（规格第 6 节）：连线上的矩形区域如何渲染、如何展开成参考图序号、固定句如何生成。
// 区域端口是派生的，不写进画板连线：换模型自动长出 / 消失、序号顺延 / 回缩，区域数据原样保留。
import type { Board, BoardEdge, PortRef, Region, RegionRender } from "./board";
import { isSupported, type ModelCapability } from "./capabilities";
import type { PromptLanguage } from "./imageRefs";
import { REGION_COLORS } from "./overlay";

/** 渲染方式选择优先级：取模型支持的第一个。 */
export const RENDER_PRIORITY: RegionRender[] = ["bbox_tag", "marked_image", "highlight_overlay"];

/** 模型当前生效的区域渲染方式；全部不支持 / 待测为 null。 */
export function effectiveRegionRender(model: ModelCapability | undefined): RegionRender | null {
  if (!model) return null;
  return RENDER_PRIORITY.find((kind) => isSupported(model.region_hint[kind])) ?? null;
}

/** 展开后槽位的最小形状（重新生成时从 task.json 重建，没有连线对象）。 */
export interface SlotRef {
  kind: "image" | "overlay";
  /** 图N 的 N（1 起），即发送序参考图序号。 */
  port: number;
  /** 叠加槽：原图序号；原图槽：null。 */
  sourcePort: number | null;
  /** 叠加槽：该图框出的区域数；原图槽：0。 */
  regionCount: number;
}

/** 展开后的端口槽：highlight_overlay 下有区域的用户线贡献「原图 + 紧随的叠加图」两个序号。 */
export interface PortSlot extends SlotRef {
  /** 来源用户连线。 */
  edge: BoardEdge;
}

/**
 * 把用户图片线（已按端口升序）展开成发送序槽位。
 * 仅当渲染方式为 highlight_overlay 且连线上有非空矩形时插入叠加槽；其它渲染方式不占名额（仅占位，行为后续切片实现）。
 */
export function expandImageEdges(edges: BoardEdge[], render: RegionRender | null): PortSlot[] {
  const slots: PortSlot[] = [];
  for (const edge of edges) {
    slots.push({ port: slots.length + 1, kind: "image", edge, sourcePort: null, regionCount: 0 });
    const regionCount = edge.region?.rects.length ?? 0;
    if (render === "highlight_overlay" && regionCount > 0) {
      slots.push({ port: slots.length + 1, kind: "overlay", edge, sourcePort: slots[slots.length - 1].port, regionCount });
    }
  }
  return slots;
}

/** 各叠加槽第一个区域的区域编号（0 起）：按槽顺序、再按框选先后连续编号。 */
export function firstRegionOf(slots: SlotRef[]): Map<number, number> {
  const out = new Map<number, number>();
  let next = 0;
  for (const s of slots) {
    if (s.kind !== "overlay") continue;
    out.set(s.port, next);
    next += s.regionCount;
  }
  return out;
}

const colorName = (index: number, language: PromptLanguage) => REGION_COLORS[index % REGION_COLORS.length][language];

/**
 * 每个叠加槽一句区域固定句，模板取自能力表 region_hint_phrasing.highlight_overlay；无模板时为空。
 * 占位符：{overlay} 叠加图序号、{source} 原图序号、{colors} 该图各区域的颜色名。
 */
export function overlayPhrases(model: ModelCapability, slots: SlotRef[], language: PromptLanguage): string[] {
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
export function regionNames(slots: SlotRef[], language: PromptLanguage): string[] {
  const total = slots.reduce((n, s) => n + (s.kind === "overlay" ? s.regionCount : 0), 0);
  return Array.from({ length: total }, (_, i) => (language === "zh" ? `${colorName(i, language)}区域` : `the ${colorName(i, language)} region`));
}

const REGION_REF = /区域\s*(\d+)|\bregion\s*(\d+)/gi;

/** 提示词里的「区域N」/「Region N」改写为颜色指代；越界的编号原样保留（由校验标红）。 */
export function rewriteRegionRefs(text: string, names: string[]): string {
  if (names.length === 0) return text;
  return text.replace(REGION_REF, (match, zh?: string, en?: string) => names[Number(zh ?? en) - 1] ?? match);
}

/** 提示词引用的区域编号（1 起）。 */
export function referencedRegions(text: string): number[] {
  return [...new Set([...text.matchAll(REGION_REF)].map((m) => Number(m[1] ?? m[2])))].sort((a, b) => a - b);
}

/** 设置 / 清除一条连线的区域。region.render 仅作创建时记录，行为一律按当前模型推导（effectiveRegionRender）。 */
export function setEdgeRegion(board: Board, ref: { from: PortRef; to: PortRef }, region: Region | null): Board {
  const match = (e: BoardEdge) => e.from[0] === ref.from[0] && e.from[1] === ref.from[1] && e.to[0] === ref.to[0] && e.to[1] === ref.to[1];
  return { ...board, edges: board.edges.map((e) => (match(e) ? { ...e, region } : e)) };
}
