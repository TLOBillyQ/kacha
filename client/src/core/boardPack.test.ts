import { describe, expect, it } from "vitest";
import { newBoard, serializeBoard, uniqueBoardFileName, type Board, type ReferenceNode, type ResultNode } from "./board";
import {
  PACK_FORMAT_VERSION,
  buildManifest,
  checkPack,
  importSummary,
  packBoardEntry,
  planExport,
  type PackFs,
} from "./boardPack";

const ROOT = "C:\\Users\\Lzx_8\\Pictures\\UGC AI 生图工具";

const base = { pos: [0, 0] as [number, number], size: [200, 200] as [number, number], extra: {} };

const result = (id: string, taskId: string, date = "2026-09-16"): ResultNode => ({
  ...base,
  id,
  type: "result",
  task_id: taskId,
  file: "result.png",
  path: `${date}/${taskId}/result.png`,
  layer_count: 0,
  record: { model: "qwen-image", prompt: "猫", negative_prompt: "", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-09-16T00:00:00Z" },
});

const reference = (id: string, path: string, sha = "old"): ReferenceNode => ({ ...base, id, type: "reference", path, sha256: sha, display_name: path.split(/[\\/]/).pop()! });

const boardWith = (...nodes: Board["nodes"]): Board => ({ ...newBoard("千问测试"), nodes });

/** 内存文件系统：绝对路径 → sha256。 */
function memoryFs(files: Record<string, string>): PackFs {
  return {
    isFile: async (p) => p in files,
    sha256: async (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
  };
}

const abs = (rel: string) => `${ROOT}\\${rel.replace(/\//g, "\\")}`;

describe("导出计划", () => {
  it("带上结果节点直接引用的任务目录（去重、排序），不改结果路径", async () => {
    const board = boardWith(result("r1", "20260916T010000Z-00000002"), result("r2", "20260916T010000Z-00000001"), result("r3", "20260916T010000Z-00000001"));
    const plan = await planExport(board, ROOT, memoryFs({ [abs("2026-09-16/20260916T010000Z-00000001/result.png")]: "", [abs("2026-09-16/20260916T010000Z-00000002/result.png")]: "" }));
    expect(plan.taskDirs).toEqual(["2026-09-16/20260916T010000Z-00000001", "2026-09-16/20260916T010000Z-00000002"]);
    expect(plan.files).toEqual([]);
    expect(plan.missing).toEqual([]);
    expect(plan.board).toEqual(board);
  });

  it("根目录内指向任务目录的参考图带上该任务目录", async () => {
    const board = boardWith(reference("a", "2026-09-17/20260917T010000Z-0000000a/result.png"));
    const plan = await planExport(board, ROOT, memoryFs({ [abs("2026-09-17/20260917T010000Z-0000000a/result.png")]: "x" }));
    expect(plan.taskDirs).toEqual(["2026-09-17/20260917T010000Z-0000000a"]);
    expect(plan.board.nodes[0]).toEqual(board.nodes[0]);
  });

  it("根目录内其他位置的参考图按原相对路径带上", async () => {
    const board = boardWith(reference("a", "素材/猫.png"));
    const plan = await planExport(board, ROOT, memoryFs({ [abs("素材/猫.png")]: "x" }));
    expect(plan.files).toEqual([{ source: abs("素材/猫.png"), entry: "素材/猫.png" }]);
    expect(plan.taskDirs).toEqual([]);
  });

  it("根目录外参考图按 sha256 去重放进导入参考图，画板路径改写为相对路径", async () => {
    const board = boardWith(reference("a", "D:\\素材\\猫.PNG"), reference("b", "E:\\别处\\同一只猫.png"), reference("c", "D:\\素材\\狗.jpg"));
    const plan = await planExport(board, ROOT, memoryFs({ "D:\\素材\\猫.PNG": "aa", "E:\\别处\\同一只猫.png": "aa", "D:\\素材\\狗.jpg": "bb" }));
    expect(plan.files).toEqual([
      { source: "D:\\素材\\猫.PNG", entry: "导入参考图/aa.png" },
      { source: "D:\\素材\\狗.jpg", entry: "导入参考图/bb.jpg" },
    ]);
    const refs = plan.board.nodes as ReferenceNode[];
    expect(refs.map((n) => [n.path, n.sha256, n.display_name])).toEqual([
      ["导入参考图/aa.png", "aa", "猫.PNG"],
      ["导入参考图/aa.png", "aa", "同一只猫.png"],
      ["导入参考图/bb.jpg", "bb", "狗.jpg"],
    ]);
    // 原画板不被改动。
    expect((board.nodes[0] as ReferenceNode).path).toBe("D:\\素材\\猫.PNG");
  });

  it("写成绝对路径但位于根目录内的参考图按相对路径处理", async () => {
    const board = boardWith(reference("a", abs("素材/猫.png")));
    const plan = await planExport(board, ROOT, memoryFs({ [abs("素材/猫.png")]: "x" }));
    expect(plan.files).toEqual([{ source: abs("素材/猫.png"), entry: "素材/猫.png" }]);
    expect((plan.board.nodes[0] as ReferenceNode).path).toBe("素材/猫.png");
  });

  it("缺图节点列出，照常导出且路径不改写", async () => {
    const board = boardWith(result("r", "20260916T010000Z-00000001"), reference("a", "D:\\素材\\没了.png"));
    const plan = await planExport(board, ROOT, memoryFs({}));
    expect(plan.missing).toEqual([
      { nodeId: "r", path: "2026-09-16/20260916T010000Z-00000001/result.png" },
      { nodeId: "a", path: "D:\\素材\\没了.png" },
    ]);
    expect(plan.taskDirs).toEqual(["2026-09-16/20260916T010000Z-00000001"]);
    expect(plan.files).toEqual([]);
    expect(plan.board).toEqual(board);
  });
});

describe("包清单与版本判定", () => {
  const boardText = serializeBoard(newBoard("豆包测试"));

  it("清单记包格式版本、应用版本与画板列表；画板放在画板目录下", () => {
    const entry = packBoardEntry("豆包测试.ugcboard.json");
    expect(entry).toBe("画板/豆包测试.ugcboard.json");
    expect(JSON.parse(buildManifest("0.2.0", [entry]))).toEqual({ pack_format_version: PACK_FORMAT_VERSION, app_version: "0.2.0", boards: [entry] });
  });

  it("版本不高于本机时通过，返回解析后的画板", () => {
    const manifest = buildManifest("0.2.0", ["画板/豆包测试.ugcboard.json"]);
    const check = checkPack(manifest, { "画板/豆包测试.ugcboard.json": boardText });
    expect(check.kind).toBe("ok");
    if (check.kind === "ok") expect(check.boards.map((b) => b.board.title)).toEqual(["豆包测试"]);
  });

  it("包格式版本更高时拒绝并提示升级", () => {
    const manifest = JSON.stringify({ pack_format_version: PACK_FORMAT_VERSION + 1, app_version: "9.0.0", boards: [] });
    const check = checkPack(manifest, {});
    expect(check).toEqual({ kind: "newer", message: expect.stringContaining("升级") });
  });

  it("包内画板 format_version 更高时拒绝", () => {
    const manifest = buildManifest("0.2.0", ["画板/a.ugcboard.json"]);
    const newer = JSON.stringify({ ...JSON.parse(boardText), format_version: 99 });
    expect(checkPack(manifest, { "画板/a.ugcboard.json": newer }).kind).toBe("newer");
  });

  it("清单缺失 / 损坏、画板缺失或损坏时判为损坏", () => {
    expect(checkPack(null, {}).kind).toBe("corrupt");
    expect(checkPack("{", {}).kind).toBe("corrupt");
    expect(checkPack(JSON.stringify({ pack_format_version: 1, boards: [] }), {}).kind).toBe("corrupt");
    expect(checkPack(buildManifest("0.2.0", ["画板/a.ugcboard.json"]), {}).kind).toBe("corrupt");
    expect(checkPack(buildManifest("0.2.0", ["画板/a.ugcboard.json"]), { "画板/a.ugcboard.json": "{" }).kind).toBe("corrupt");
  });
});

describe("导入结果", () => {
  it("同名画板沿用 (2) 自动改名", () => {
    expect(uniqueBoardFileName("千问测试", ["千问测试.ugcboard.json"])).toBe("千问测试 (2).ugcboard.json");
  });

  it("提示导入与跳过数，有冲突时列出", () => {
    expect(importSummary({ imported: 14, skipped: 0, conflicts: [] })).toEqual({ message: "导入 14 个任务，跳过 0 个", conflicts: [] });
    expect(importSummary({ imported: 0, skipped: 3, conflicts: ["2026-09-16/x"] })).toEqual({
      message: "导入 0 个任务，跳过 3 个，1 项冲突未覆盖",
      conflicts: ["2026-09-16/x"],
    });
  });
});
