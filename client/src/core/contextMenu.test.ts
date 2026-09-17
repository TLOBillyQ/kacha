import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, TaskNode } from "./board";
import { BUILTIN_TABLE } from "./capabilities";
import { LOCKED_HINT } from "./iterate";
import { clampMenuPosition, menuItems, selectionForMenu, actionBarItems, type MenuFacts } from "./contextMenu";

const SPEC_2K = { tier: "2K", ratio: "16:9", width: null, height: null };

function board(nodes: BoardNode[] = [], edges: BoardEdge[] = []): Board {
  return { format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

function facts(patch: Partial<MenuFacts> = {}): MenuFacts {
  return { board: board(), table: BUILTIN_TABLE, selected: new Set(), locked: new Set(), expanded: new Set(), undoLabel: null, redoLabel: null, ...patch };
}

const summary = (items: ReturnType<typeof menuItems>) => items.map((i) => [i.action, i.label, i.disabledReason]);

describe("空白处菜单", () => {
  it("给出新建三项与撤销 / 重做，撤销文案带上一步描述", () => {
    const items = menuItems({ kind: "pane" }, facts({ undoLabel: "移动 2 个节点", redoLabel: "新建提示词" }));
    expect(summary(items)).toEqual([
      ["newPrompt", "新建提示词", null],
      ["newTask", "新建生成任务", null],
      ["addReferences", "添加参考图…", null],
      ["undo", "撤销 移动 2 个节点", null],
      ["redo", "重做 新建提示词", null],
    ]);
  });

  it("无可撤销 / 可重做时两项置灰", () => {
    const items = menuItems({ kind: "pane" }, facts());
    expect(summary(items).slice(3)).toEqual([
      ["undo", "撤销", "没有可撤销的操作"],
      ["redo", "重做", "没有可重做的操作"],
    ]);
  });
});

function reference(id: string): BoardNode {
  return { id, type: "reference", pos: [0, 0], size: [200, 220], extra: {}, path: `${id}.png`, sha256: "0".repeat(64), display_name: `${id}.png` };
}

function result(id: string): BoardNode {
  return {
    id,
    type: "result",
    pos: [0, 0],
    size: [220, 300],
    extra: {},
    task_id: `t-${id}`,
    file: "result.png",
    path: `x/${id}/result.png`,
    layer_count: 0,
    record: { model: "qwen-image-3.0", prompt: "", negative_prompt: "", size_spec: SPEC_2K, submitted_at: "" },
  };
}

function task(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    type: "task",
    pos: [0, 0],
    size: [280, 260],
    extra: {},
    model: "qwen-image-3.0",
    size_spec: SPEC_2K,
    image_ports: 0,
    layer_decomposition: false,
    transparent_background: false,
    last_submitted: null,
    ...patch,
  };
}

function edge(from: string, fromPort: string, to: string, toPort: string, system = false): BoardEdge {
  return { from: [from, fromPort], to: [to, toPort], source_layer: null, region: null, system, extra: {} };
}

describe("图片节点菜单", () => {
  it("参考图：放大预览 / 以此继续编辑 / 删除", () => {
    const b = board([reference("r")]);
    expect(summary(menuItems({ kind: "node", nodeId: "r" }, facts({ board: b, selected: new Set(["r"]) })))).toEqual([
      ["preview", "放大预览", null],
      ["continueEditing", "以此继续编辑", null],
      ["delete", "删除", null],
    ]);
  });

  it("结果：另有加为参考图与生成变体，置灰原因同节点按钮", () => {
    const b = board([result("res")]);
    expect(summary(menuItems({ kind: "node", nodeId: "res" }, facts({ board: b, selected: new Set(["res"]) })))).toEqual([
      ["preview", "放大预览", null],
      ["continueEditing", "以此继续编辑", null],
      ["addAsReference", "加为参考图", "先选一个生成任务"],
      ["generateVariant", "生成变体", "父任务已删除"],
      ["delete", "删除", null],
    ]);
  });

  it("父任务排队 / 执行中时生成变体置灰", () => {
    const b = board([task("t"), result("res")], [edge("t", "result", "res", "in", true)]);
    const items = menuItems({ kind: "node", nodeId: "res" }, facts({ board: b, selected: new Set(["res"]), locked: new Set(["t"]) }));
    expect(items.find((i) => i.action === "generateVariant")?.disabledReason).toBe("父任务正在排队 / 执行");
  });
});

describe("任务 / 提示词节点菜单", () => {
  const submitted = { task_id: "20260917-0001" };

  it("空闲任务：展开设置在首；运行可用，取消置灰；没提交过时重新生成置灰", () => {
    const b = board([task("t")]);
    expect(summary(menuItems({ kind: "node", nodeId: "t" }, facts({ board: b, selected: new Set(["t"]) })))).toEqual([
      ["toggleSettings", "展开设置", null],
      ["run", "运行", null],
      ["cancel", "取消", "任务不在排队 / 执行中"],
      ["regenerate", "重新生成", "还没有提交过"],
      ["delete", "删除", null],
    ]);
  });

  it("排队 / 执行中的任务：只有取消可用（删除走删除规则）", () => {
    const b = board([task("t", { last_submitted: submitted })]);
    expect(summary(menuItems({ kind: "node", nodeId: "t" }, facts({ board: b, selected: new Set(["t"]), locked: new Set(["t"]) })))).toEqual([
      ["toggleSettings", "展开设置", null],
      ["run", "运行", "任务正在排队 / 执行"],
      ["cancel", "取消", null],
      ["regenerate", "重新生成", "任务正在排队 / 执行"],
      ["delete", "删除", null],
    ]);
  });

  it("已展开的任务：该项为收起设置", () => {
    const b = board([task("t")]);
    const items = menuItems({ kind: "node", nodeId: "t" }, facts({ board: b, selected: new Set(["t"]), expanded: new Set(["t"]) }));
    expect(summary(items)[0]).toEqual(["toggleSettings", "收起设置", null]);
  });

  it("提交过的空闲任务可重新生成", () => {
    const b = board([task("t", { last_submitted: submitted })]);
    const items = menuItems({ kind: "node", nodeId: "t" }, facts({ board: b, selected: new Set(["t"]) }));
    expect(items.find((i) => i.action === "regenerate")?.disabledReason).toBeNull();
  });

  it("提示词：只有删除", () => {
    const b = board([{ id: "p", type: "prompt", pos: [0, 0], size: [240, 140], extra: {}, text: "" }]);
    expect(summary(menuItems({ kind: "node", nodeId: "p" }, facts({ board: b, selected: new Set(["p"]) })))).toEqual([["delete", "删除", null]]);
  });
});

describe("右键与选区", () => {
  it("落在未选中节点上：选区换成该节点", () => {
    expect([...selectionForMenu(new Set(["a", "b"]), "c")]).toEqual(["c"]);
  });

  it("落在选区内：保持多选（同一个 Set）", () => {
    const selected = new Set(["a", "b"]);
    expect(selectionForMenu(selected, "b")).toBe(selected);
  });

  it("多选：只给以此继续编辑与删除", () => {
    const b = board([reference("r"), result("res"), task("t")]);
    const items = menuItems({ kind: "node", nodeId: "t" }, facts({ board: b, selected: new Set(["r", "res", "t"]) }));
    expect(summary(items)).toEqual([
      ["continueEditing", "以此继续编辑", null],
      ["delete", "删除 3 个节点", null],
    ]);
  });

  it("多选时右键结果节点、选区恰含一个任务：另给加为参考图", () => {
    const b = board([result("res"), task("t")]);
    const items = menuItems({ kind: "node", nodeId: "res" }, facts({ board: b, selected: new Set(["res", "t"]) }));
    expect(summary(items)).toEqual([
      ["continueEditing", "以此继续编辑", null],
      ["addAsReference", "加为参考图", null],
      ["delete", "删除 2 个节点", null],
    ]);
  });

  it("多选里没有图片节点：只给删除", () => {
    const b = board([task("t1"), task("t2")]);
    const items = menuItems({ kind: "node", nodeId: "t1" }, facts({ board: b, selected: new Set(["t1", "t2"]) }));
    expect(summary(items)).toEqual([["delete", "删除 2 个节点", null]]);
  });
});

describe("悬浮动作条", () => {
  it("结果：放大预览与迭代动作，不含删除；置灰原因与菜单相同", () => {
    const b = board([result("res")]);
    expect(summary(actionBarItems("res", facts({ board: b })))).toEqual([
      ["preview", "放大预览", null],
      ["continueEditing", "以此继续编辑", null],
      ["addAsReference", "加为参考图", "先选一个生成任务"],
      ["generateVariant", "生成变体", "父任务已删除"],
    ]);
  });

  it("参考图：放大预览与以此继续编辑", () => {
    expect(summary(actionBarItems("r", facts({ board: board([reference("r")]) })))).toEqual([
      ["preview", "放大预览", null],
      ["continueEditing", "以此继续编辑", null],
    ]);
  });

  it("选中一个任务后悬浮未选中的结果：加为参考图可用（不改选区）", () => {
    const b = board([result("res"), task("t")]);
    const items = actionBarItems("res", facts({ board: b, selected: new Set(["t"]) }));
    expect(items.find((i) => i.action === "addAsReference")?.disabledReason).toBeNull();
  });

  it("悬浮多选内的图片节点：只含对多选有意义的动作", () => {
    const b = board([reference("r"), result("res"), task("t")]);
    expect(summary(actionBarItems("r", facts({ board: b, selected: new Set(["r", "res", "t"]) })))).toEqual([["continueEditing", "以此继续编辑", null]]);
    expect(summary(actionBarItems("res", facts({ board: b, selected: new Set(["res", "t"]) })))).toEqual([
      ["continueEditing", "以此继续编辑", null],
      ["addAsReference", "加为参考图", null],
    ]);
  });

  it("任务、提示词节点没有动作条", () => {
    const b = board([task("t"), { id: "p", type: "prompt", pos: [0, 0], size: [240, 140], extra: {}, text: "" }]);
    expect(actionBarItems("t", facts({ board: b }))).toEqual([]);
    expect(actionBarItems("p", facts({ board: b }))).toEqual([]);
  });
});

describe("连线菜单", () => {
  const withRegion = (supported: boolean) => ({
    ...BUILTIN_TABLE,
    models: BUILTIN_TABLE.models.map((m) => ({
      ...m,
      region_hint: { highlight_overlay: "unsupported" as const, marked_image: "unsupported" as const, bbox_tag: supported ? ("supported" as const) : ("unsupported" as const) },
    })),
  });
  const imageLine = edge("r", "out", "t", "image:0");
  const b = board([reference("r"), task("t")], [imageLine]);

  it("图片线在下游模型支持区域指示时另有框选修改区域", () => {
    expect(summary(menuItems({ kind: "edge", edge: imageLine }, facts({ board: b, table: withRegion(true) })))).toEqual([
      ["disconnect", "断开", null],
      ["editRegion", "框选修改区域", null],
    ]);
  });

  it("下游模型不支持时只给断开", () => {
    expect(summary(menuItems({ kind: "edge", edge: imageLine }, facts({ board: b, table: withRegion(false) })))).toEqual([["disconnect", "断开", null]]);
  });

  it("提示词线只给断开", () => {
    const line = edge("p", "out", "t", "positive");
    expect(summary(menuItems({ kind: "edge", edge: line }, facts({ board: b, table: withRegion(true) })))).toEqual([["disconnect", "断开", null]]);
  });

  it("下游任务锁定时两项置灰", () => {
    const items = menuItems({ kind: "edge", edge: imageLine }, facts({ board: b, table: withRegion(true), locked: new Set(["t"]) }));
    expect(items.map((i) => i.disabledReason)).toEqual([LOCKED_HINT, LOCKED_HINT]);
  });

  it("系统连线不给菜单", () => {
    expect(menuItems({ kind: "edge", edge: edge("t", "result", "res", "in", true) }, facts({ board: b }))).toEqual([]);
  });
});

describe("菜单位置", () => {
  const win = { width: 800, height: 600 };
  const menu = { width: 180, height: 200 };

  it("放得下时左上角落在点击处", () => {
    expect(clampMenuPosition({ x: 100, y: 120 }, menu, win)).toEqual({ x: 100, y: 120 });
  });

  it("靠右 / 靠下时推回窗口内", () => {
    expect(clampMenuPosition({ x: 750, y: 580 }, menu, win)).toEqual({ x: 620, y: 400 });
  });

  it("比窗口还大时贴左上角", () => {
    expect(clampMenuPosition({ x: 50, y: 50 }, { width: 900, height: 700 }, win)).toEqual({ x: 0, y: 0 });
  });
});
