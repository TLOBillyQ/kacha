import { describe, expect, it } from "vitest";
import type { Board, BoardNode, ResultNode, TaskNode } from "./board";
import { addResultNode, placeResult, RESULT_NODE_SIZE, type NewResult } from "./layout";

function task(id: string, pos: [number, number], size: [number, number] = [280, 260]): TaskNode {
  return {
    id,
    type: "task",
    pos,
    size,
    extra: {},
    model: "qwen-image-3.0-pro",
    size_spec: { tier: "1K", ratio: "1:1", width: null, height: null },
    image_ports: 0,
    layer_decomposition: false,
    transparent_background: false,
    last_submitted: null,
  };
}

function box(id: string, pos: [number, number], size: [number, number]): BoardNode {
  return { id, type: "prompt", pos, size, text: "", extra: {} };
}

function board(nodes: BoardNode[]): Board {
  return { format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges: [], extra: {} };
}

const result = (taskId: string, id = "r"): NewResult => ({
  id,
  taskId,
  submittedTaskId: `task-${id}`,
  file: "result.png",
  path: `2026-09-16/task-${id}/result.png`,
  record: { model: "qwen-image-3.0-pro", prompt: "猫", negative_prompt: "", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-09-16T09:15:00.000Z" },
});

describe("结果列落位", () => {
  it("第一个结果：任务节点右侧，与任务顶部对齐", () => {
    const b = board([task("t", [100, 200])]);
    expect(placeResult(b, "t")).toEqual([100 + 280 + 60, 200]);
  });

  it("同一任务的结果自上而下累积", () => {
    let b = board([task("t", [0, 0])]);
    b = addResultNode(b, result("t", "r1"));
    b = addResultNode(b, result("t", "r2"));
    const [r1, r2] = b.nodes.filter((n): n is ResultNode => n.type === "result");
    expect(r1.pos).toEqual([340, 0]);
    expect(r2.pos).toEqual([340, RESULT_NODE_SIZE[1] + 24]);
  });

  it("用户挪走了旧结果：从该任务最下面的结果之后继续，不回填", () => {
    let b = board([task("t", [0, 0])]);
    b = addResultNode(b, result("t", "r1"));
    b = { ...b, nodes: b.nodes.map((n) => (n.id === "r1" ? { ...n, pos: [340, 1000] as [number, number] } : n)) };
    b = addResultNode(b, result("t", "r2"));
    expect(b.nodes.find((n) => n.id === "r2")!.type === "result" && (b.nodes.find((n) => n.id === "r2") as ResultNode).pos).toEqual([340, 1000 + RESULT_NODE_SIZE[1] + 24]);
  });

  it("只找就近空位：被别的节点占住就往下让，不推开别人", () => {
    const blocker = box("other", [400, -50], [200, 300]);
    const b = board([task("t", [0, 0]), blocker]);
    expect(placeResult(b, "t")).toEqual([340, 250 + 24]);
    const after = addResultNode(b, result("t"));
    expect(after.nodes.find((n) => n.id === "other")).toEqual(blocker);
  });

  it("加系统连线 task.result → result.in，结果节点带记录子集与相对路径", () => {
    const b = addResultNode(board([task("t", [0, 0])]), result("t"));
    expect(b.edges).toEqual([{ from: ["t", "result"], to: ["r", "in"], source_layer: null, region: null, system: true, extra: {} }]);
    expect(b.nodes[1]).toMatchObject({ type: "result", task_id: "task-r", file: "result.png", path: "2026-09-16/task-r/result.png", layer_count: 0, size: RESULT_NODE_SIZE });
  });

  it("任务节点已被删除时不加结果节点", () => {
    const b = board([box("p", [0, 0], [10, 10])]);
    expect(addResultNode(b, result("t"))).toBe(b);
  });
});
