// 预览弹窗的矩形几何：归一化 0–1 坐标 [x1, y1, x2, y2]，纯函数便于单测。
export type Rect01 = [number, number, number, number];
export interface Point01 {
  x: number;
  y: number;
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 拖出矩形：任意对角两点 → 规范 [x1, y1, x2, y2]。 */
export function dragRect(a: Point01, b: Point01): Rect01 {
  return [clamp01(Math.min(a.x, b.x)), clamp01(Math.min(a.y, b.y)), clamp01(Math.max(a.x, b.x)), clamp01(Math.max(a.y, b.y))];
}

/** 平移：形状不变，整体钳回图内。 */
export function moveRect(r: Rect01, dx: number, dy: number): Rect01 {
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  const x1 = Math.min(1 - w, Math.max(0, r[0] + dx));
  const y1 = Math.min(1 - h, Math.max(0, r[1] + dy));
  return [x1, y1, x1 + w, y1 + h];
}

export type Corner = "nw" | "ne" | "sw" | "se";

/** 角柄缩放：对角不动，拖动角跟随指针；越过对角时交换边，保持 x1<x2、y1<y2。 */
export function resizeRect(r: Rect01, corner: Corner, to: Point01): Rect01 {
  const x = clamp01(to.x);
  const y = clamp01(to.y);
  const [x1, y1, x2, y2] = r;
  const xs: [number, number] = corner === "nw" || corner === "sw" ? [x, x2] : [x1, x];
  const ys: [number, number] = corner === "nw" || corner === "ne" ? [y, y2] : [y1, y];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** 小于该边长的拖拽视为误触，不落矩形。 */
export function isMeaningful(r: Rect01, min = 0.01): boolean {
  return r[2] - r[0] >= min && r[3] - r[1] >= min;
}
