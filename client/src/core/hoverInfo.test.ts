import { describe, expect, it } from "vitest";
import type { BoardEdge, ReferenceNode, ResultNode } from "./board";
import { actionHoverInfo, CANCELLED_HINT, edgeHoverInfo, PROMPT_CLAMP_LINES, referenceHoverInfo, resultHoverInfo, taskHoverInfo } from "./hoverInfo";

const time = (d: Date) => d.toISOString();

function result(patch: Partial<ResultNode> = {}): ResultNode {
  return {
    id: "r",
    type: "result",
    pos: [0, 0],
    size: [240, 135],
    extra: {},
    task_id: "20260917-0001",
    file: "result.png",
    path: "2026-09-17/20260917-0001/result.png",
    layer_count: 0,
    record: { model: "qwen-image-3.0", prompt: "一只橘猫", negative_prompt: "", size_spec: { tier: "2K", ratio: "16:9", width: null, height: null }, submitted_at: "2026-09-17T05:00:00.000Z" },
    ...patch,
  };
}

const reference: ReferenceNode = { id: "a", type: "reference", pos: [0, 0], size: [240, 180], extra: {}, path: "参考/cat.png", sha256: "0".repeat(64), display_name: "cat.png" };

describe("结果节点悬浮信息", () => {
  it("模型、提示词全文（限 6 行）、尺寸、时间、任务号", () => {
    expect(resultHoverInfo({ node: result(), modelName: "通义万相", image: undefined, missing: false, formatTime: time })).toEqual([
      { label: "模型", text: "通义万相" },
      { label: "提示词", text: "一只橘猫", clamp: PROMPT_CLAMP_LINES },
      { label: "尺寸", text: "2K · 16:9" },
      { label: "时间", text: "2026-09-17T05:00:00.000Z" },
      { label: "任务", text: "20260917-0001", mono: true },
    ]);
    expect(PROMPT_CLAMP_LINES).toBe(6);
  });

  it("带透明通道、有图层时列出；自定义尺寸与实际像素", () => {
    const node = result({ layer_count: 3, record: { ...result().record, size_spec: { tier: null, ratio: null, width: 1000, height: 500 } } });
    const info = resultHoverInfo({ node, modelName: "m", image: { width: 1000, height: 500, has_alpha: true }, missing: false, formatTime: time });
    expect(info.filter((l) => l.label === "尺寸" || l.label === "透明" || l.label === "图层")).toEqual([
      { label: "尺寸", text: "1000×500" },
      { label: "透明", text: "带透明通道" },
      { label: "图层", text: "3 个图层" },
    ]);
  });

  it("缺图时首行给出原因，标红", () => {
    const [first] = resultHoverInfo({ node: result(), modelName: "m", image: null, missing: true, formatTime: time });
    expect(first).toEqual({ label: null, text: "图片缺失：2026-09-17/20260917-0001/result.png，可重新定位或选文件", tone: "error" });
  });

  it("作为任务输入：发送时的自动处理说明在前，不可修复的警告标黄在后", () => {
    const info = resultHoverInfo({ node: result(), modelName: "m", image: undefined, missing: false, notes: ["发送时将自动缩小到 2048×2048"], warnings: ["最短边 300 px 小于 384 px"], formatTime: time });
    expect(info.slice(-2)).toEqual([
      { label: null, text: "发送时将自动缩小到 2048×2048" },
      { label: null, text: "最短边 300 px 小于 384 px", tone: "warn" },
    ]);
  });

  it("提交时间读不出时原样显示", () => {
    const node = result({ record: { ...result().record, submitted_at: "昨天" } });
    expect(resultHoverInfo({ node, modelName: "m", image: undefined, missing: false, formatTime: time })).toContainEqual({ label: "时间", text: "昨天" });
  });
});

describe("参考图节点悬浮信息", () => {
  it("文件名与路径、像素尺寸、透明、警告原因", () => {
    expect(referenceHoverInfo({ node: reference, image: { width: 800, height: 600, has_alpha: true }, missing: false, warnings: ["短边小于 512px"] })).toEqual([
      { label: "文件", text: "cat.png" },
      { label: "路径", text: "参考/cat.png", mono: true },
      { label: "像素", text: "800×600" },
      { label: "透明", text: "带透明通道" },
      { label: null, text: "短边小于 512px", tone: "warn" },
    ]);
  });

  it("发送时的自动处理说明不标黄", () => {
    expect(referenceHoverInfo({ node: reference, image: undefined, missing: false, warnings: [], notes: ["发送时将转为 JPEG"] })).toContainEqual({ label: null, text: "发送时将转为 JPEG" });
  });

  it("图片信息未读到时不列像素与透明；缺图给原因", () => {
    expect(referenceHoverInfo({ node: reference, image: null, missing: true, warnings: [] })).toEqual([
      { label: null, text: "图片缺失：参考/cat.png，可重新定位或选文件", tone: "error" },
      { label: "文件", text: "cat.png" },
      { label: "路径", text: "参考/cat.png", mono: true },
    ]);
  });
});

describe("任务节点悬浮信息", () => {
  const base = { modelName: "通义万相", sizeSpec: { tier: "2K", ratio: "1:1", width: null, height: null }, issues: [], warnings: [], status: null };

  it("给了宽高比显示文本（自动状态）时尺寸行用它", () => {
    expect(taskHoverInfo({ ...base, ratioNote: "自动（16:9 · 图1）" })[1]).toMatchObject({ label: "尺寸", text: "2K · 自动（16:9 · 图1）" });
  });

  it("模型、尺寸；不可运行原因标红，提示标黄", () => {
    expect(taskHoverInfo({ ...base, issues: ["正向提示词未连接"], warnings: ["图2 已接线但提示词未引用"] })).toEqual([
      { label: "模型", text: "通义万相" },
      { label: "尺寸", text: "2K · 1:1" },
      { label: null, text: "正向提示词未连接", tone: "error" },
      { label: null, text: "图2 已接线但提示词未引用", tone: "warn" },
    ]);
  });

  it("状态详情：失败原因、取消后网关可能仍在计算、已中断", () => {
    const statusLine = (status: Parameters<typeof taskHoverInfo>[0]["status"]) => taskHoverInfo({ ...base, status }).find((l) => l.label === "状态");
    expect(statusLine({ kind: "failed", label: "网关超时" })).toEqual({ label: "状态", text: "失败：网关超时", tone: "error" });
    expect(statusLine({ kind: "cancelled", gatewayMayContinue: true })).toEqual({ label: "状态", text: `已取消：${CANCELLED_HINT}` });
    expect(statusLine({ kind: "cancelled", gatewayMayContinue: false })).toEqual({ label: "状态", text: "已取消" });
    expect(statusLine({ kind: "interrupted" })).toEqual({ label: "状态", text: "已中断：上次程序异常退出时仍在执行，可重新生成" });
    expect(statusLine({ kind: "queued" })).toEqual({ label: "状态", text: "排队中" });
  });
});

describe("连线悬浮信息", () => {
  const edge = (patch: Partial<BoardEdge>): BoardEdge => ({ from: ["a", "out"], to: ["t", "image:0"], source_layer: null, region: null, system: false, extra: {}, ...patch });

  it("图片线：区域数与来源图层", () => {
    expect(edgeHoverInfo(edge({ source_layer: 2, region: { rects: [[0, 0, 1, 1], [0, 0, 0.5, 0.5]], render: "bbox_tag" } }))).toEqual([
      { label: "区域", text: "2 个修改区域" },
      { label: "来源", text: "图层 2" },
    ]);
    expect(edgeHoverInfo(edge({}))).toEqual([
      { label: "区域", text: "未框选" },
      { label: "来源", text: "合成图" },
    ]);
  });

  it("提示词线与系统连线没有悬浮信息", () => {
    expect(edgeHoverInfo(edge({ to: ["t", "positive"] }))).toEqual([]);
    expect(edgeHoverInfo(edge({ to: ["r", "in"], system: true }))).toEqual([]);
  });
});

describe("动作的悬浮信息", () => {
  it("可用：动作名；置灰：动作名 + 不可用原因", () => {
    expect(actionHoverInfo({ action: "preview", label: "放大预览", disabledReason: null })).toEqual([{ label: null, text: "放大预览" }]);
    expect(actionHoverInfo({ action: "addAsReference", label: "加为参考图", disabledReason: "先选中一个生成任务" })).toEqual([
      { label: null, text: "加为参考图" },
      { label: null, text: "先选中一个生成任务", tone: "error" },
    ]);
  });
});
