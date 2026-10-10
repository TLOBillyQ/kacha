// 区域指示：连线上的矩形区域如何渲染、如何展开成端口槽、区域如何编号。
// 区域端口是派生的，不写进画板连线：换模型自动长出 / 消失，区域数据原样保留。
// 两套序号：用户序号（「图N」，只数用户图片连线，不受区域影响）与发送序号（叠加图紧随原图的实际发送顺序）。
// 区域编号是槽的属性：成像（叠加图上色、画板给框上色）与发送计划各自从同一份槽读 firstRegionOf。文本部分在发送计划（sendPlan.ts）。
import type { Board, BoardEdge, PortRef, Region, RegionRender } from "./board";
import { isSupported, type ModelCapability } from "./capabilities";

/**
 * 客户端已实现的渲染方式，按优先级取模型支持的第一个。能力表记模型事实、不记客户端实现（ADR 0004）：
 * 高亮叠加为默认；Flash坐标表达由连线的bbox_tag选择，不新增派生图片。
 * marked_image未实现；用户提供的视觉标记按普通参考图发送。
 */
export const RENDER_PRIORITY: RegionRender[] = ["highlight_overlay"];

/** 模型当前生效的区域渲染方式；全部不支持 / 待测为 null。 */
export function effectiveRegionRender(model: ModelCapability | undefined): RegionRender | null {
  if (!model) return null;
  return RENDER_PRIORITY.find((kind) => isSupported(model.region_hint[kind])) ?? null;
}

/** 展开后槽位的最小形状（重新生成时由 slotsFromReferences 从 task.json 重建，没有连线对象）。 */
export interface SlotRef {
  kind: "image" | "overlay";
  /** 发送序号（1 起）：叠加图紧随原图的实际发送顺序。 */
  port: number;
  /** 用户序号（1 起），即用户写的「图N」的 N；叠加槽没有自己的用户序号，记原图的。 */
  userPort: number;
  /** 叠加槽：原图的发送序号；原图槽：null。 */
  sourcePort: number | null;
  /** 叠加槽：该图框出的区域数；原图槽：0。 */
  regionCount: number;
  /** 官方提示坐标，不增加参考图名额。 */
  coordinateRegion?: Region;
  /** 用于提交前校验，叠加图和坐标共用用户区域数据。 */
  regionData?: Region;
}

/** 展开后的端口槽：highlight_overlay 下有区域的用户线贡献「原图 + 紧随的叠加图」两个发送序号、一个用户序号。 */
export interface PortSlot extends SlotRef {
  /** 来源用户连线。 */
  edge: BoardEdge;
}

/**
 * 把用户图片线（已按端口升序）展开成发送序槽位。行为一律按当前模型推导（region.render 仅作创建时记录）：
 * 仅当渲染方式为 highlight_overlay 且连线上有非空矩形时插入叠加槽；其它渲染方式不占名额（仅占位，行为后续切片实现）。
 * 坐标区域是客户端只接了 Flash 的通路（ADR 0004 的「客户端已实现」清单）：当前模型是 Flash 请求形态且支持 bbox_tag 时，
 * 连线上创建时记为 bbox_tag 的区域按坐标槽处理；否则回落当前模型的渲染方式（如高亮叠加），区域数据不动。
 */
export function expandImageEdges(edges: BoardEdge[], model: ModelCapability | undefined): PortSlot[] {
  const render = effectiveRegionRender(model);
  const coordinatePath = render !== null && model?.request_shape === "seedream_flash_images_generations" && isSupported(model.region_hint.bbox_tag);
  const slots: PortSlot[] = [];
  for (const [i, edge] of edges.entries()) {
    const coordinateRegion = coordinatePath && edge.region?.render === "bbox_tag" ? edge.region : undefined;
    slots.push({ port: slots.length + 1, userPort: i + 1, kind: "image", edge, sourcePort: null, regionCount: coordinateRegion?.rects.length ?? 0, ...(coordinateRegion ? { coordinateRegion } : {}), ...(edge.region ? { regionData: edge.region } : {}) });
    const regionCount = edge.region?.rects.length ?? 0;
    if (render === "highlight_overlay" && !coordinateRegion && regionCount > 0) {
      slots.push({ port: slots.length + 1, userPort: i + 1, kind: "overlay", edge, sourcePort: slots[slots.length - 1].port, regionCount });
    }
  }
  return slots;
}

/**
 * 槽的第二个构造函数：从任务记录的 references[]（按发送序号排列，叠加图紧随原图）重建。
 * 用户序号按顺序给非叠加条目编 1..k；叠加条目沿用原图的用户序号。#113 之前的旧任务记录 references[] 形状相同，同样适用。
 */
export function slotsFromReferences(references: { source: { kind: string }; region?: { source_port: number; rects: unknown[]; render?: string; coordinate_kind?: "point" | "bbox" } }[]): SlotRef[] {
  let userPort = 0;
  return references.map((ref, i) =>
    ref.source.kind === "overlay" && ref.region
      ? { kind: "overlay", port: i + 1, userPort, sourcePort: ref.region.source_port, regionCount: ref.region.rects.length }
      : { kind: "image", port: i + 1, userPort: ++userPort, sourcePort: null, regionCount: ref.region?.render === "bbox_tag" ? ref.region.rects.length : 0, ...(ref.region?.render === "bbox_tag" ? { coordinateRegion: ref.region as Region } : {}) },
  );
}

/** 各叠加槽第一个区域的区域编号（0 起）：按槽顺序、再按框选先后连续编号。 */
export function firstRegionOf(slots: SlotRef[]): Map<number, number> {
  const out = new Map<number, number>();
  let next = 0;
  for (const s of slots) {
    if (s.kind !== "overlay" && !s.coordinateRegion) continue;
    out.set(s.port, next);
    next += s.regionCount;
  }
  return out;
}

/** 设置 / 清除一条连线的区域。region.render 仅作创建时记录，行为一律按当前模型推导（effectiveRegionRender）。 */
export function setEdgeRegion(board: Board, ref: { from: PortRef; to: PortRef }, region: Region | null): Board {
  const match = (e: BoardEdge) => e.from[0] === ref.from[0] && e.from[1] === ref.from[1] && e.to[0] === ref.to[0] && e.to[1] === ref.to[1];
  return { ...board, edges: board.edges.map((e) => (match(e) ? { ...e, region } : e)) };
}
