import { describe, expect, it } from "vitest";
import { newBoard, parseBoard, serializeBoard, uniqueBoardFileName, type Board, type ReferenceNode, type ResultNode } from "./board";
import {
  PACK_CANCELLED,
  PACK_FORMAT_VERSION,
  PACK_MANIFEST,
  buildExportSpec,
  buildManifest,
  checkPack,
  importPack,
  importSummary,
  inspectPack,
  planExport,
  runCancellable,
  type MergeUnit,
  type PackFs,
  type PackIo,
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

  /** Flash 结果：两层，其中 02 的图层文件不在磁盘上。 */
  const flashResult = (id: string, taskId: string, date = "2026-09-16"): ResultNode => {
    const node = result(id, taskId, date);
    node.record.model = "doubao-seedream-5-0-flash-260915";
    node.layer_count = 2;
    node.record.layers = [
      { file: "layers/01.png", z_index: 1, bounding_box: { absolute: [0, 0, 100, 50], normalized: [0, 0, 500, 500] }, name: "主体" },
      { file: "layers/02.png", z_index: 2, bounding_box: { absolute: [10, 10, 60, 40], normalized: [50, 100, 300, 400] }, description: "阴影" },
    ];
    return node;
  };

  it("Flash 结果的图层文件缺失：逐个列入缺图清单，任务目录照常带上", async () => {
    const taskId = "20260916T010000Z-00000001";
    const board = boardWith(flashResult("r", taskId));
    const files = {
      [abs(`2026-09-16/${taskId}/result.png`)]: "",
      [abs(`2026-09-16/${taskId}/layers/01.png`)]: "",
    };
    const plan = await planExport(board, ROOT, memoryFs(files));
    expect(plan.taskDirs).toEqual([`2026-09-16/${taskId}`]);
    expect(plan.missing).toEqual([{ nodeId: "r", path: `2026-09-16/${taskId}/layers/02.png` }]);
  });

  it("包往返：图层记录与来源图层连线经序列化 / 解析原样保留", async () => {
    const taskId = "20260916T010000Z-00000001";
    const res = flashResult("r", taskId);
    const board: Board = {
      ...boardWith(res),
      edges: [{ from: ["r", "out"], to: ["t", "image:0"], source_layer: 2, region: null, system: false, extra: {} }],
    };
    const files = Object.fromEntries(["result.png", "layers/01.png", "layers/02.png"].map((f) => [abs(`2026-09-16/${taskId}/${f}`), ""]));
    const plan = await planExport(board, ROOT, memoryFs(files));
    expect(plan.missing).toEqual([]);
    const parsed = parseBoard(serializeBoard(plan.board));
    if (parsed.kind !== "ok") throw new Error(parsed.kind);
    const node = parsed.board.nodes[0] as ResultNode;
    expect(node.record.layers).toEqual(res.record.layers);
    expect(node.layer_count).toBe(2);
    expect(parsed.board.edges[0]).toMatchObject({ source_layer: 2 });
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

describe("可取消的画板包命令", () => {
  it("先复位取消标记，复位之后才进入进度阶段，再跑命令", async () => {
    const steps: string[] = [];
    const io = { cancel: async (cancelled: boolean) => void steps.push(`cancel(${cancelled})`) };
    const outcome = await runCancellable(io, (stage) => steps.push(stage), async () => {
      steps.push("run");
      return 7;
    });
    expect(outcome).toEqual({ ok: true, value: 7 });
    expect(steps).toEqual(["cancel(false)", "progress", "run"]);
  });

  it("命令以取消标记 reject 归为 cancelled，其他错误归为 failed", async () => {
    const io = { cancel: async () => undefined };
    expect(await runCancellable(io, () => undefined, () => Promise.reject(PACK_CANCELLED))).toEqual({ ok: false, result: "cancelled", error: PACK_CANCELLED });
    expect(await runCancellable(io, () => undefined, () => Promise.reject(new Error("磁盘已满")))).toEqual({ ok: false, result: "failed", error: "磁盘已满" });
  });
});

describe("导入画板包", () => {
  const PACK = "D:\\下载\\千问测试.ugcpack";
  const TASK = "2026-09-16/20260916T010000Z-0000000a";
  const SECRET = "机密提示词：橘猫";
  const boardA = "画板/甲.ugcboard.json";
  const boardB = "画板/乙.ugcboard.json";
  const withPrompt = (name: string): Board => ({
    ...newBoard(name),
    nodes: [{ ...base, id: "p", type: "prompt", text: SECRET }],
  });
  const goodPack: Record<string, string> = {
    [PACK_MANIFEST]: buildManifest("0.2.0", [boardA, boardB]),
    [boardA]: serializeBoard(withPrompt("甲")),
    [boardB]: serializeBoard(withPrompt("乙")),
    [`${TASK}/task.json`]: "{}",
    [`${TASK}/result.png`]: "",
  };

  /** 内存包命令：记录移入的合并单元；failAfterMove 让导入移完第一个单元后以该错误 reject。 */
  function memoryPackIo(pack: Record<string, string>, opts: { failAfterMove?: unknown } = {}) {
    const moved: string[] = [];
    const steps: string[] = [];
    const io: PackIo = {
      cancel: async (cancelled) => void steps.push(`cancel(${cancelled})`),
      entries: async () => Object.keys(pack),
      readTexts: async (_pack, names) => Object.fromEntries(names.filter((n) => n in pack).map((n) => [n, pack[n]])),
      importUnits: async (_pack, _root, units) => {
        steps.push("import");
        for (const unit of units) {
          moved.push(unit.path);
          if (opts.failAfterMove !== undefined) throw opts.failAfterMove;
        }
        return { outcomes: units.map((u) => ({ path: u.path, outcome: "moved" as const })), bytes: 1234 };
      },
    };
    return { io, moved, steps };
  }

  function run(io: PackIo, addBoard: (board: Board) => Promise<string> = async (b) => `${ROOT}\\画板\\${b.title}.ugcboard.json`) {
    const logs: Record<string, unknown>[] = [];
    const added: string[] = [];
    const stages: string[] = [];
    const outcome = importPack(io, {
      packPath: PACK,
      outputRoot: ROOT,
      addBoard: async (board) => {
        added.push(board.title);
        return addBoard(board);
      },
      onStage: (stage) => stages.push(stage),
      log: (kind, fields) => void logs.push({ kind, ...fields }),
    });
    return { outcome, logs, added, stages };
  }

  it("包版本更高：不写任何文件，不进入进度，日志记 newer", async () => {
    const newer = { ...goodPack, [PACK_MANIFEST]: JSON.stringify({ pack_format_version: PACK_FORMAT_VERSION + 1, app_version: "9", boards: [] }) };
    const { io, moved, steps } = memoryPackIo(newer);
    const r = run(io);
    expect(await r.outcome).toMatchObject({ kind: "newer" });
    expect(moved).toEqual([]);
    expect(steps).toEqual([]);
    expect(r.added).toEqual([]);
    expect(r.stages).toEqual([]);
    expect(r.logs).toEqual([{ kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", result: "newer" }]);
  });

  it("包损坏（布局不合法或读不了条目）：不写任何文件，日志记 corrupt", async () => {
    const { io, moved } = memoryPackIo({ ...goodPack, "素材/猫.png": "" });
    const r = run(io);
    expect(await r.outcome).toMatchObject({ kind: "corrupt", reason: expect.stringContaining("素材/猫.png") });
    expect(moved).toEqual([]);
    expect(r.added).toEqual([]);

    const broken = memoryPackIo(goodPack);
    broken.io.entries = async () => {
      throw new Error("不是 zip");
    };
    const r2 = run(broken.io);
    expect(await r2.outcome).toEqual({ kind: "corrupt", reason: "不是 zip" });
    expect(r2.logs).toEqual([{ kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", result: "corrupt" }]);
  });

  it("导入中取消：返回 cancelled，已移入的任务目录保留，不写画板", async () => {
    const { io, moved } = memoryPackIo(goodPack, { failAfterMove: PACK_CANCELLED });
    const r = run(io);
    expect(await r.outcome).toEqual({ kind: "cancelled" });
    expect(moved).toEqual([TASK]);
    expect(r.added).toEqual([]);
    expect(r.logs).toEqual([{ kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", board_file: "甲.ugcboard.json, 乙.ugcboard.json", result: "cancelled" }]);
  });

  it("导入命令失败：返回 failed 与报错原文，日志只记类别", async () => {
    const { io } = memoryPackIo(goodPack, { failAfterMove: new Error(`磁盘已满 ${SECRET}`) });
    const r = run(io);
    expect(await r.outcome).toEqual({ kind: "failed", error: `磁盘已满 ${SECRET}` });
    expect(r.logs).toEqual([{ kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", board_file: "甲.ugcboard.json, 乙.ugcboard.json", result: "failed" }]);
  });

  it("成功：先复位取消再进入进度再导入，逐个写画板，日志记计数与实际写入的文件名", async () => {
    const { io, steps } = memoryPackIo(goodPack);
    const r = run(io, async (b) => `${ROOT}\\画板\\${b.title} (2).ugcboard.json`);
    const outcome = await r.outcome;
    expect(steps).toEqual(["cancel(false)", "import"]);
    expect(r.stages).toEqual(["progress"]);
    expect(r.added).toEqual(["甲", "乙"]);
    expect(outcome).toEqual({
      kind: "done",
      summary: { imported: 1, skipped: 0, conflicts: [], message: "导入 1 个任务，跳过 0 个" },
      written: ["甲 (2).ugcboard.json", "乙 (2).ugcboard.json"],
      writeError: null,
    });
    expect(r.logs).toEqual([
      { kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", task_dirs: 1, skipped: 0, conflicts: 0, bytes: 1234, board_file: "甲 (2).ugcboard.json, 乙 (2).ugcboard.json", result: "ok" },
    ]);
  });

  it("第 2 个画板写失败：第 1 个保留、第一个失败即停、writeError 有值、日志记 board_write_failed", async () => {
    const { io } = memoryPackIo(goodPack);
    const r = run(io, async (b) => {
      if (b.title === "乙") throw new Error(`画板目录只读 ${SECRET}`);
      return `${ROOT}\\画板\\${b.title}.ugcboard.json`;
    });
    expect(await r.outcome).toMatchObject({ kind: "done", written: ["甲.ugcboard.json"], writeError: `画板目录只读 ${SECRET}` });
    expect(r.logs).toEqual([
      { kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", task_dirs: 1, skipped: 0, conflicts: 0, bytes: 1234, board_file: "甲.ugcboard.json, 乙.ugcboard.json", result: "board_write_failed" },
    ]);
  });

  it("日志不含提示词与报错原文：只有类别、文件名与计数", async () => {
    const cases = [memoryPackIo(goodPack).io, memoryPackIo(goodPack, { failAfterMove: new Error(SECRET) }).io];
    const logs: Record<string, unknown>[] = [];
    for (const io of cases) {
      const r = run(io, async () => {
        throw new Error(SECRET);
      });
      await r.outcome;
      logs.push(...r.logs);
    }
    expect(logs.length).toBeGreaterThan(0);
    for (const entry of logs) {
      expect(JSON.stringify(entry)).not.toContain("橘猫");
      for (const [key, value] of Object.entries(entry)) {
        expect(["kind", "action", "pack_file", "board_file", "result", "task_dirs", "skipped", "conflicts", "bytes"]).toContain(key);
        expect(typeof value === "number" || typeof value === "string").toBe(true);
      }
    }
  });
});
