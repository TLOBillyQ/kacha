import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOARD_FORMAT_VERSION,
  DEFAULT_BOARD_TITLE,
  boardFileName,
  newBoard,
  openBoard,
  parseBoard,
  serializeBoard,
  uniqueBoardFileName,
  type Board,
} from "./board";

const sample = (): Board => ({
  format_version: 1,
  title: "角色设定",
  viewport: { zoom: 1, x: 0, y: 0 },
  nodes: [
    { id: "11111111-1111-4111-8111-111111111111", type: "prompt", pos: [0, 0], size: [240, 120], text: "一只猫", extra: {} },
    {
      id: "22222222-2222-4222-8222-222222222222",
      type: "reference",
      pos: [0, 200],
      size: [200, 220],
      path: "D:/素材/猫.png",
      sha256: "ab".repeat(32),
      display_name: "猫.png",
      extra: {},
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      type: "task",
      pos: [400, 0],
      size: [300, 320],
      model: "qwen-image-3.0-pro",
      size_spec: { tier: "2K", ratio: "1:1", width: null, height: null },
      image_ports: 1,
      layer_decomposition: false,
      transparent_background: false,
      last_submitted: null,
      extra: {},
    },
  ],
  edges: [
    { from: ["11111111-1111-4111-8111-111111111111", "out"], to: ["33333333-3333-4333-8333-333333333333", "positive"], source_layer: null, region: null, system: false, extra: {} },
    { from: ["22222222-2222-4222-8222-222222222222", "out"], to: ["33333333-3333-4333-8333-333333333333", "image:0"], source_layer: null, region: null, system: false, extra: {} },
  ],
  extra: {},
});

describe("画板文件写出", () => {
  it("UTF-8 缩进 JSON，顶层 format_version 1，连线无 id，不含选中/运行状态", () => {
    const text = serializeBoard(sample());
    expect(text).toContain('\n  "format_version": 1');
    expect(text).toContain("一只猫");
    const raw = JSON.parse(text);
    expect(Object.keys(raw)).toEqual(["format_version", "title", "viewport", "nodes", "edges"]);
    expect(raw.edges[0]).toEqual({
      from: ["11111111-1111-4111-8111-111111111111", "out"],
      to: ["33333333-3333-4333-8333-333333333333", "positive"],
      source_layer: null,
      region: null,
    });
    expect(text).not.toMatch(/"selected"|"status"|"undo"|"id": "[^"]*",\s*"from"/);
  });

  it("系统连线写 system: true", () => {
    const board = sample();
    board.edges.push({ from: ["33333333-3333-4333-8333-333333333333", "result"], to: ["r", "in"], source_layer: null, region: null, system: true, extra: {} });
    const raw = JSON.parse(serializeBoard(board));
    expect(raw.edges[2]).toEqual({ from: ["33333333-3333-4333-8333-333333333333", "result"], to: ["r", "in"], system: true });
  });

  it("读写往返保持一致", () => {
    const board = sample();
    const parsed = parseBoard(serializeBoard(board));
    expect(parsed).toEqual({ kind: "ok", board });
  });
});

describe("画板级最近模型 last_model", () => {
  it("有值才写出，读入往返保持；缺省为 null", () => {
    expect(JSON.parse(serializeBoard(sample()))).not.toHaveProperty("last_model");
    const withModel = { ...sample(), last_model: "qwen-image-3.0" };
    const text = serializeBoard(withModel);
    expect(JSON.parse(text).last_model).toBe("qwen-image-3.0");
    const parsed = parseBoard(text);
    expect(parsed.kind === "ok" && parsed.board.last_model).toBe("qwen-image-3.0");
    const plain = parseBoard(serializeBoard(sample()));
    expect(plain.kind === "ok" && (plain.board.last_model ?? null)).toBe(null);
    expect(parseBoard(JSON.stringify({ ...JSON.parse(text), last_model: 3 })).kind).toBe("corrupt");
  });
});

describe("画板文件读入", () => {
  it("未知字段读写保留（顶层、节点、连线）", () => {
    const raw = JSON.parse(serializeBoard(sample()));
    raw.future_top = { a: 1 };
    raw.nodes[0].color = "red";
    raw.edges[0].note = "x";
    const parsed = parseBoard(JSON.stringify(raw));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    const again = JSON.parse(serializeBoard(parsed.board));
    expect(again.future_top).toEqual({ a: 1 });
    expect(again.nodes[0].color).toBe("red");
    expect(again.edges[0].note).toBe("x");
  });

  it("未知类型节点整条保留", () => {
    const raw = JSON.parse(serializeBoard(sample()));
    raw.nodes.push({ id: "u", type: "sticky", pos: [1, 2], size: [3, 4], body: "hi" });
    const parsed = parseBoard(JSON.stringify(raw));
    if (parsed.kind !== "ok") throw new Error(parsed.kind);
    expect(JSON.parse(serializeBoard(parsed.board)).nodes[3]).toEqual({ id: "u", type: "sticky", pos: [1, 2], size: [3, 4], body: "hi" });
  });

  it("更新版本拒绝打开", () => {
    const raw = JSON.parse(serializeBoard(sample()));
    raw.format_version = BOARD_FORMAT_VERSION + 1;
    expect(parseBoard(JSON.stringify(raw))).toEqual({ kind: "newer", version: BOARD_FORMAT_VERSION + 1 });
  });

  it("非 JSON 或结构不对视为损坏", () => {
    expect(parseBoard("{oops").kind).toBe("corrupt");
    expect(parseBoard('{"format_version": 1}').kind).toBe("corrupt");
    expect(parseBoard('{"format_version": "1", "title": "", "nodes": [], "edges": []}').kind).toBe("corrupt");
  });

  it("手写夹具画板含结果节点可读入", () => {
    const text = readFileSync(new URL("../../fixtures/output-root/画板/结果节点夹具.ugcboard.json", import.meta.url), "utf8");
    const parsed = parseBoard(text);
    if (parsed.kind !== "ok") throw new Error(parsed.kind);
    const result = parsed.board.nodes.find((n) => n.type === "result");
    expect(result).toMatchObject({ type: "result", file: "result.png", record: { model: "qwen-image-3.0-pro" } });
  });
});

describe("主文件损坏回退 .bak", () => {
  const good = serializeBoard(sample());

  it("主文件完好直接用", () => {
    expect(openBoard(good, "{bad")).toMatchObject({ kind: "ok", recoveredFromBak: false });
  });

  it("主文件损坏且 .bak 完好 → 用 .bak 并标记", () => {
    expect(openBoard("{bad", good)).toMatchObject({ kind: "ok", recoveredFromBak: true });
  });

  it("主文件缺失但 .bak 在 → 回退", () => {
    expect(openBoard(null, good)).toMatchObject({ kind: "ok", recoveredFromBak: true });
  });

  it("都坏 → 损坏", () => {
    expect(openBoard("{bad", null).kind).toBe("corrupt");
  });

  it("主文件是更新版本 → 拒开，不回退 .bak", () => {
    const newer = good.replace('"format_version": 1', '"format_version": 99');
    expect(openBoard(newer, good)).toEqual({ kind: "newer", version: 99 });
  });
});

describe("文件名由标题派生", () => {
  it("去掉非法字符与首尾空白、结尾点", () => {
    expect(boardFileName('角色/设定:<v2>?*"|\\ ')).toBe("角色设定v2.ugcboard.json");
    expect(boardFileName("草稿..")).toBe("草稿.ugcboard.json");
  });

  it("去完为空时用默认标题；Windows 保留名加下划线", () => {
    expect(boardFileName("///")).toBe(`${DEFAULT_BOARD_TITLE}.ugcboard.json`);
    expect(boardFileName("con")).toBe("con_.ugcboard.json");
  });

  it("重名加 (2)、(3)，大小写不敏感，排除自身", () => {
    expect(uniqueBoardFileName("未命名画板", [])).toBe("未命名画板.ugcboard.json");
    expect(uniqueBoardFileName("未命名画板", ["未命名画板.ugcboard.json"])).toBe("未命名画板 (2).ugcboard.json");
    expect(uniqueBoardFileName("Cat", ["cat.ugcboard.json", "Cat (2).ugcboard.json"])).toBe("Cat (3).ugcboard.json");
    expect(uniqueBoardFileName("Cat", ["Cat.ugcboard.json"], "Cat.ugcboard.json")).toBe("Cat.ugcboard.json");
  });

  it("新建画板默认标题「未命名画板」", () => {
    expect(newBoard().title).toBe("未命名画板");
    expect(newBoard().nodes).toEqual([]);
  });
});
