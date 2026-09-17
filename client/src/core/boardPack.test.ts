import { describe, expect, it } from "vitest";
import { newBoard, parseBoard, serializeBoard, uniqueBoardFileName, type Board, type ReferenceNode, type ResultNode } from "./board";
import {
  PACK_FORMAT_VERSION,
  PACK_MANIFEST,
  buildExportSpec,
  buildManifest,
  checkPack,
  importSummary,
  inspectPack,
  planExport,
  type MergeUnit,
  type PackFs,
} from "./boardPack";
import { resolveFromRoot } from "./paths";

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

  it("根目录内但不在任务目录里的参考图（含写成绝对路径的）也放进导入参考图", async () => {
    const board = boardWith(reference("a", "素材/猫.png"), reference("b", abs("素材/狗.png")));
    const plan = await planExport(board, ROOT, memoryFs({ [abs("素材/猫.png")]: "aa", [abs("素材/狗.png")]: "bb" }));
    expect(plan.files).toEqual([
      { source: abs("素材/猫.png"), entry: "导入参考图/aa.png" },
      { source: abs("素材/狗.png"), entry: "导入参考图/bb.png" },
    ]);
    expect((plan.board.nodes as ReferenceNode[]).map((n) => n.path)).toEqual(["导入参考图/aa.png", "导入参考图/bb.png"]);
  });

  it("Windows 根目录外的参考图改写后，在 macOS 根目录下解析到导入参考图", async () => {
    const plan = await planExport(boardWith(reference("a", "D:\\素材\\猫.png")), ROOT, memoryFs({ "D:\\素材\\猫.png": "aa" }));
    const imported = parseBoard(serializeBoard(plan.board));
    if (imported.kind !== "ok") throw new Error(imported.kind);
    const path = (imported.board.nodes[0] as ReferenceNode).path;
    expect(resolveFromRoot("/Users/art/Pictures/UGC AI 生图工具", path)).toBe("/Users/art/Pictures/UGC AI 生图工具/导入参考图/aa.png");
  });

  it("缺图节点列出，照常导出且路径不改写", async () => {
    const board = boardWith(result("r", "20260916T010000Z-00000001"), reference("a", "D:\\素材\\没了.png"), reference("b", "素材/也没了.png"));
    const plan = await planExport(board, ROOT, memoryFs({}));
    expect(plan.missing).toEqual([
      { nodeId: "r", path: "2026-09-16/20260916T010000Z-00000001/result.png" },
      { nodeId: "a", path: "D:\\素材\\没了.png" },
      { nodeId: "b", path: "素材/也没了.png" },
    ]);
    expect(plan.taskDirs).toEqual(["2026-09-16/20260916T010000Z-00000001"]);
    expect(plan.files).toEqual([]);
    expect(plan.board).toEqual(board);
  });

  it("导出规格：清单与画板作为文本条目，任务目录与参考图原样传给壳", async () => {
    const plan = await planExport(boardWith(reference("a", "D:\\猫.png")), ROOT, memoryFs({ "D:\\猫.png": "aa" }));
    const spec = buildExportSpec("0.2.0", "千问测试.ugcboard.json", plan);
    expect(spec.texts.map((t) => t.entry)).toEqual([PACK_MANIFEST, "画板/千问测试.ugcboard.json"]);
    expect(JSON.parse(spec.texts[0].text)).toEqual({ pack_format_version: PACK_FORMAT_VERSION, app_version: "0.2.0", boards: ["画板/千问测试.ugcboard.json"] });
    expect(spec.texts[1].text).toBe(serializeBoard(plan.board));
    expect(spec.task_dirs).toEqual([]);
    expect(spec.files).toEqual(plan.files);
  });
});

describe("包清单与版本判定", () => {
  const boardText = serializeBoard(newBoard("豆包测试"));

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

describe("导入前检查包内容", () => {
  const TASK = "2026-09-16/20260916T010000Z-0000000a";
  const boardEntry = "画板/千问测试.ugcboard.json";
  const texts: Record<string, string> = { [PACK_MANIFEST]: buildManifest("0.2.0", [boardEntry]), [boardEntry]: serializeBoard(newBoard("千问测试")) };

  /** 只读被请求的文本，记录读了哪些。 */
  function reader(source: Record<string, string>) {
    const read: string[][] = [];
    return {
      read,
      readTexts: async (names: string[]) => {
        read.push(names);
        return Object.fromEntries(names.filter((n) => n in source).map((n) => [n, source[n]]));
      },
    };
  }

  it("只读清单与画板；任务目录按 task.json 比对、参考图按整文件比对", async () => {
    const entries = [PACK_MANIFEST, boardEntry, `${TASK}/task.json`, `${TASK}/result.png`, `${TASK}/layers/01.png`, "导入参考图/aa.png"];
    const r = reader(texts);
    const check = await inspectPack(entries, r.readTexts);
    expect(r.read).toEqual([[PACK_MANIFEST, boardEntry]]);
    expect(check.kind).toBe("ok");
    if (check.kind !== "ok") return;
    expect(check.boards.map((b) => b.entry)).toEqual([boardEntry]);
    expect(check.units).toEqual<MergeUnit[]>([
      { path: TASK, identity: "task.json" },
      { path: "导入参考图/aa.png", identity: null },
    ]);
  });

  it("版本更高时先于布局判定拒绝（新格式可能有新布局）", async () => {
    const newer = { ...texts, [PACK_MANIFEST]: JSON.stringify({ pack_format_version: PACK_FORMAT_VERSION + 1, app_version: "9", boards: [] }) };
    expect((await inspectPack([PACK_MANIFEST, "新目录/x.bin"], reader(newer).readTexts)).kind).toBe("newer");
  });

  it("任务目录与导入参考图以外的路径、缺 task.json 的任务目录、不安全路径判为损坏", async () => {
    const ok = [PACK_MANIFEST, boardEntry];
    for (const extra of [["素材/猫.png"], [`${TASK}/result.png`], ["导入参考图/子目录/aa.png"], [`${TASK}/../../evil.png`, `${TASK}/task.json`], ["manifest.json/x"]]) {
      const check = await inspectPack([...ok, ...extra], reader(texts).readTexts);
      expect(check.kind, extra.join()).toBe("corrupt");
    }
  });
});

describe("导入结果", () => {
  it("同名画板沿用 (2) 自动改名", () => {
    expect(uniqueBoardFileName("千问测试", ["千问测试.ugcboard.json"])).toBe("千问测试 (2).ugcboard.json");
  });

  const units: MergeUnit[] = [
    { path: "2026-09-16/a", identity: "task.json" },
    { path: "2026-09-16/b", identity: "task.json" },
    { path: "2026-09-16/c", identity: "task.json" },
    { path: "导入参考图/aa.png", identity: null },
    { path: "导入参考图/bb.png", identity: null },
  ];

  it("只按任务目录计导入与跳过数；参考图冲突也列出", () => {
    const summary = importSummary(units, [
      { path: "2026-09-16/a", outcome: "moved" },
      { path: "2026-09-16/b", outcome: "identical" },
      { path: "2026-09-16/c", outcome: "conflict" },
      { path: "导入参考图/aa.png", outcome: "identical" },
      { path: "导入参考图/bb.png", outcome: "conflict" },
    ]);
    expect(summary).toEqual({ imported: 1, skipped: 1, conflicts: ["2026-09-16/c", "导入参考图/bb.png"], message: "导入 1 个任务，跳过 1 个，2 项冲突未覆盖" });
  });

  it("无冲突时不附冲突数", () => {
    expect(importSummary(units.slice(0, 1), [{ path: "2026-09-16/a", outcome: "moved" }]).message).toBe("导入 1 个任务，跳过 0 个");
  });
});
