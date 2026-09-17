import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, PromptNode, ResultNode, TaskNode } from "./board";
import { countLabel, emptyHistory, HISTORY_LIMIT, MERGE_PAUSE_MS, mergeSystemState, nodeEditChange, recordChange, redo, redoLabel, undo, undoLabel, type History } from "./history";

const SPEC = { tier: "1K", ratio: "1:1", width: null, height: null };
const NONE: ReadonlySet<string> = new Set();

function task(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    type: "task",
    pos: [0, 0],
    size: [280, 260],
    extra: {},
    model: "qwen-image-3.0-pro",
    size_spec: SPEC,
    image_ports: 0,
    layer_decomposition: false,
    transparent_background: false,
    last_submitted: null,
    ...patch,
  };
}

function prompt(id: string, text = ""): PromptNode {
  return { id, type: "prompt", pos: [0, 0], size: [240, 140], extra: {}, text };
}

function result(id: string, pos: [number, number] = [400, 0]): ResultNode {
  return {
    id,
    type: "result",
    pos,
    size: [220, 300],
    extra: {},
    task_id: `task-${id}`,
    file: "result.png",
    path: `2026-09-17/task-${id}/result.png`,
    layer_count: 0,
    record: { model: "qwen-image-3.0-pro", prompt: "", negative_prompt: "", size_spec: SPEC, submitted_at: "" },
  };
}

const edge = (from: [string, string], to: [string, string]): BoardEdge => ({ from, to, source_layer: null, region: null, system: false, extra: {} });
const systemEdge = (taskId: string, resultId: string): BoardEdge => ({ from: [taskId, "result"], to: [resultId, "in"], source_layer: null, region: null, system: true, extra: {} });

function board(nodes: BoardNode[], edges: BoardEdge[] = []): Board {
  return { format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

const ids = (b: Board) => b.nodes.map((n) => n.id);

/** 依次记录若干用户步：每步把画板换成下一个。 */
function play(boards: Board[], labels: string[]): History {
  let h = emptyHistory();
  labels.forEach((label, i) => (h = recordChange(h, boards[i], { label }, i * 1000)));
  return h;
}

describe("快照栈", () => {
  it("用户步压入变更前的画板，撤销回到它并可重做", () => {
    const b0 = board([]);
    const b1 = board([prompt("p")]);
    const h = recordChange(emptyHistory(), b0, { label: "新建提示词" }, 0);
    expect(undoLabel(h)).toBe("新建提示词");
    expect(redoLabel(h)).toBeNull();

    const undone = undo(h, b1, NONE)!;
    expect(undone.board.nodes).toEqual([]);
    expect(undoLabel(undone.history)).toBeNull();
    expect(redoLabel(undone.history)).toBe("新建提示词");

    const redone = redo(undone.history, undone.board, NONE)!;
    expect(ids(redone.board)).toEqual(["p"]);
    expect(undoLabel(redone.history)).toBe("新建提示词");
  });

  it("无可撤 / 可重做时返回 null", () => {
    expect(undo(emptyHistory(), board([]), NONE)).toBeNull();
    expect(redo(emptyHistory(), board([]), NONE)).toBeNull();
  });

  it("新的用户步清空重做栈", () => {
    const h = play([board([]), board([prompt("a")])], ["一", "二"]);
    const undone = undo(h, board([prompt("a"), prompt("b")]), NONE)!;
    const next = recordChange(undone.history, undone.board, { label: "三" }, 99_000);
    expect(redoLabel(next)).toBeNull();
    expect(undoLabel(next)).toBe("三");
  });

  it("系统写入不产生撤销步、不清空重做栈", () => {
    const h = play([board([])], ["一"]);
    const undone = undo(h, board([prompt("a")]), NONE)!;
    for (const change of ["system", "view"] as const) {
      const after = recordChange(undone.history, undone.board, change, 5000);
      expect(after).toEqual(undone.history);
    }
  });

  it(`上限 ${HISTORY_LIMIT} 步，丢最早的`, () => {
    let h = emptyHistory();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h = recordChange(h, board([prompt(`p${i}`)]), { label: `步${i}` }, i * 1000);
    expect(h.undo).toHaveLength(HISTORY_LIMIT);
    expect(h.undo[0].label).toBe("步5");
  });

  it("重做栈同样受上限约束", () => {
    let h = emptyHistory();
    for (let i = 0; i < HISTORY_LIMIT; i++) h = recordChange(h, board([]), { label: `步${i}` }, i * 1000);
    let current = board([]);
    for (let i = 0; i < HISTORY_LIMIT; i++) {
      const r = undo(h, current, NONE)!;
      h = r.history;
      current = r.board;
    }
    expect(h.redo).toHaveLength(HISTORY_LIMIT);
    expect(undo(h, current, NONE)).toBeNull();
  });
});

describe("步合并", () => {
  it("同一合并键无时间窗：一次拖动的多次位置更新合为一步，保留拖动前的快照", () => {
    const b0 = board([prompt("a")]);
    let h = recordChange(emptyHistory(), b0, { label: "移动 1 个节点", merge: { key: "drag:1" } }, 0);
    h = recordChange(h, board([{ ...prompt("a"), pos: [5, 5] }]), { label: "移动 1 个节点", merge: { key: "drag:1" } }, 60_000);
    expect(h.undo).toHaveLength(1);
    expect(h.undo[0].board).toBe(b0);
  });

  it("连续输入停顿不超过时间窗合为一步，超过另起一步", () => {
    const merge = { key: "text:p", windowMs: 500 };
    let h = recordChange(emptyHistory(), board([prompt("p", "")]), { label: "编辑提示词", merge }, 0);
    h = recordChange(h, board([prompt("p", "猫")]), { label: "编辑提示词", merge }, 400);
    h = recordChange(h, board([prompt("p", "猫咪")]), { label: "编辑提示词", merge }, 800);
    expect(h.undo).toHaveLength(1);
    h = recordChange(h, board([prompt("p", "猫咪在")]), { label: "编辑提示词", merge }, 1301);
    expect(h.undo).toHaveLength(2);
  });

  it("不同合并键、无合并键或中间撤销过都会另起一步", () => {
    const merge = { key: "nudge", windowMs: 500 };
    let h = recordChange(emptyHistory(), board([]), { label: "微移", merge }, 0);
    h = recordChange(h, board([]), { label: "编辑提示词", merge: { key: "text:p", windowMs: 500 } }, 100);
    h = recordChange(h, board([]), { label: "微移", merge }, 200);
    h = recordChange(h, board([]), { label: "删除 1 个节点" }, 300);
    h = recordChange(h, board([]), { label: "删除 1 个节点" }, 301);
    expect(h.undo).toHaveLength(5);

    const undone = undo(h, board([]), NONE)!;
    const after = recordChange(undone.history, undone.board, { label: "微移", merge }, 350);
    const again = recordChange(after, board([]), { label: "微移", merge }, 400);
    expect(again.undo).toHaveLength(after.undo.length);
    expect(after.undo).toHaveLength(undone.history.undo.length + 1);
  });

  it("合并后的步描述取最后一次", () => {
    const merge = { key: "k" };
    let h = recordChange(emptyHistory(), board([]), { label: "一", merge }, 0);
    h = recordChange(h, board([]), { label: "二", merge }, 10);
    expect(h.undo).toHaveLength(1);
    expect(undoLabel(h)).toBe("二");
  });

  it("系统写入不打断正在合并的输入", () => {
    const merge = { key: "text:p", windowMs: 500 };
    let h = recordChange(emptyHistory(), board([]), { label: "编辑提示词", merge }, 0);
    h = recordChange(h, board([]), "system", 200);
    h = recordChange(h, board([]), { label: "编辑提示词", merge }, 400);
    expect(h.undo).toHaveLength(1);
  });
});

describe("撤销时合并系统状态", () => {
  it("晚于快照产出的结果节点及其系统连线保留", () => {
    const target = board([task("t")]);
    const current = board([task("t", { pos: [50, 50] }), result("r")], [systemEdge("t", "r")]);
    const merged = mergeSystemState(target, current, NONE);
    expect(ids(merged)).toEqual(["t", "r"]);
    expect(merged.nodes[0]).toMatchObject({ pos: [0, 0] });
    expect(merged.edges).toEqual([systemEdge("t", "r")]);
  });

  it("父任务不在快照中的结果节点随之消失", () => {
    const target = board([]);
    const current = board([task("t"), result("r")], [systemEdge("t", "r")]);
    const merged = mergeSystemState(target, current, NONE);
    expect(merged.nodes).toEqual([]);
    expect(merged.edges).toEqual([]);
  });

  it("快照里已有的结果节点按快照（撤销对它的移动）；用户粘贴出的结果节点不算系统产出", () => {
    const target = board([task("t"), result("r", [400, 0])], [systemEdge("t", "r")]);
    const current = board([task("t"), result("r", [900, 900]), result("copy")], [systemEdge("t", "r")]);
    const merged = mergeSystemState(target, current, NONE);
    expect(ids(merged)).toEqual(["t", "r"]);
    expect(merged.nodes[1]).toMatchObject({ pos: [400, 0] });
    expect(merged.edges).toEqual([systemEdge("t", "r")]);
  });

  it("任务的提交记录按当前状态", () => {
    const submitted = { task_id: "task-1" };
    const target = board([task("t", { model: "旧模型" })]);
    const current = board([task("t", { model: "新模型", last_submitted: submitted })]);
    expect(mergeSystemState(target, current, NONE).nodes[0]).toMatchObject({ model: "旧模型", last_submitted: submitted });
  });

  it("锁定任务按当前状态保留参数与输入连线，位置仍按快照", () => {
    const target = board([task("t", { pos: [0, 0], model: "旧模型" }), prompt("old"), prompt("new")], [edge(["old", "out"], ["t", "positive"])]);
    const current = board(
      [task("t", { pos: [300, 300], model: "新模型", image_ports: 1 }), prompt("old"), prompt("new")],
      [edge(["new", "out"], ["t", "positive"])],
    );
    const merged = mergeSystemState(target, current, new Set(["t"]));
    expect(merged.nodes[0]).toMatchObject({ model: "新模型", image_ports: 1, pos: [0, 0] });
    expect(merged.edges).toEqual([edge(["new", "out"], ["t", "positive"])]);
  });

  it("快照里没有的锁定任务连同其输入源节点一起保留", () => {
    const target = board([]);
    const current = board([prompt("p"), task("t"), result("r")], [edge(["p", "out"], ["t", "positive"]), systemEdge("t", "r")]);
    const merged = mergeSystemState(target, current, new Set(["t"]));
    expect(ids(merged).sort()).toEqual(["p", "r", "t"]);
    expect(merged.edges).toHaveLength(2);
  });

  it("未锁定任务的输入连线按快照", () => {
    const target = board([task("t"), prompt("a"), prompt("b")], [edge(["a", "out"], ["t", "positive"])]);
    const current = board([task("t"), prompt("a"), prompt("b")], [edge(["b", "out"], ["t", "positive"])]);
    expect(mergeSystemState(target, current, NONE).edges).toEqual([edge(["a", "out"], ["t", "positive"])]);
  });

  it("视口与标题按当前状态", () => {
    const target = { ...board([]), title: "旧", viewport: { zoom: 1, x: 0, y: 0 } };
    const current = { ...board([]), title: "新", viewport: { zoom: 2, x: 5, y: 6 } };
    expect(mergeSystemState(target, current, NONE)).toMatchObject({ title: "新", viewport: { zoom: 2, x: 5, y: 6 } });
  });

  it("撤销与重做都走合并：撤销前出的图重做后仍在", () => {
    const b0 = board([task("t")]);
    const b1 = board([task("t"), prompt("p")]);
    const h = recordChange(emptyHistory(), b0, { label: "新建提示词" }, 0);
    const withResult = board([...b1.nodes, result("r")], [systemEdge("t", "r")]);
    const undone = undo(h, withResult, NONE)!;
    expect(ids(undone.board)).toEqual(["t", "r"]);
    const late = board([...undone.board.nodes, result("r2")], [...undone.board.edges, systemEdge("t", "r2")]);
    const redone = redo(undone.history, late, NONE)!;
    expect(ids(redone.board)).toEqual(["t", "p", "r", "r2"]);
  });
});

describe("用户删除的结果节点", () => {
  it("撤销删除后重做：结果节点仍按删除（它早于重做快照产出，不算晚到）", () => {
    const withResult = board([task("t"), result("r")], [systemEdge("t", "r")]);
    const deleted = board([task("t")]);
    const h = recordChange(emptyHistory(), withResult, { label: "删除 1 个节点" }, 0);
    const undone = undo(h, deleted, NONE)!;
    expect(ids(undone.board)).toEqual(["t", "r"]);
    const redone = redo(undone.history, undone.board, NONE)!;
    expect(ids(redone.board)).toEqual(["t"]);
    expect(redone.board.edges).toEqual([]);
  });

  it("删除后再撤销更早的步：删掉的结果节点不回来", () => {
    const b0 = board([task("t")]);
    const withResult = board([task("t"), result("r"), prompt("p")], [systemEdge("t", "r")]);
    let h = recordChange(emptyHistory(), b0, { label: "新建提示词" }, 0);
    h = recordChange(h, withResult, { label: "删除 1 个节点" }, 1000);
    const deleted = board([task("t"), prompt("p")]);
    const once = undo(h, deleted, NONE)!;
    const twice = undo(once.history, once.board, NONE)!;
    expect(ids(twice.board)).toEqual(["t", "r"]);
  });
});

describe("步描述", () => {
  it("按数量生成文案", () => {
    expect(countLabel("删除", 3, "个节点")).toBe("删除 3 个节点");
  });
});

describe("节点字段编辑的步描述", () => {
  it("提示词文本按节点合并连续输入", () => {
    expect(nodeEditChange("p", { text: "猫" })).toEqual({ label: "编辑提示词", merge: { key: "text:p", windowMs: MERGE_PAUSE_MS } });
  });

  it("单个开关字段用对应描述", () => {
    expect(nodeEditChange("t", { layer_decomposition: true })).toEqual({ label: "切换图层拆分" });
  });

  it("多个字段各自描述相同时沿用，不同或含未知字段时退为「修改节点」且不合并", () => {
    expect(nodeEditChange("t", { size_spec: {}, layer_decomposition: true })).toEqual({ label: "修改节点" });
    expect(nodeEditChange("p", { text: "猫", pos: [0, 0] })).toEqual({ label: "修改节点" });
    expect(nodeEditChange("t", { transparent_background: true, extra: {} })).toEqual({ label: "修改节点" });
  });
});
