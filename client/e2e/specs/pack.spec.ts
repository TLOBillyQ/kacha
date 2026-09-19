// 手测清单 #9–#16：画板包导入（正常 / 版本较新 / 损坏 / 进度中取消 / 冲突 / 写画板失败）与导出（正常 / 进度中取消）。
import { expect, test, type Page } from "@playwright/test";
import { board, boardPath, boardScenario, openApp, png, promptNode, referenceNode, taskNode } from "../app";
import { OUTPUT_ROOT, type Scenario, type SeedFile } from "../scenario";

const TASK_A = "2026-09-16/20260916T010000Z-0000000a";
const TASK_B = "2026-09-16/20260916T020000Z-0000000b";
const TASK_C = "2026-09-16/20260916T030000Z-0000000c";
const PACK = "/e2e/in/a.ugcpack";
const IMG = png(8, 8);

const taskJson = (id: string, note = "") => ({ text: JSON.stringify({ task_id: id, prompt: `提示词${note}` }) });

const resultNode = (id: string, dir: string, pos: [number, number] = [800, 0]) => {
  const taskId = dir.split("/")[1];
  return {
    id, type: "result", pos, size: [220, 280], task_id: taskId, file: "result.png", path: `${dir}/result.png`, layer_count: 0,
    record: { model: "qwen-image-3.0-pro", prompt: "p", negative_prompt: "", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-09-16T01:00:00Z" },
  };
};

const manifest = (over: Record<string, unknown> = {}) => ({
  text: JSON.stringify({ pack_format_version: 1, app_version: "0.9.0", boards: ["画板/包内画板.ugcboard.json"], ...over }),
});

/** 包：清单 + 画板 + 给定任务目录（task.json + result.png）+ 一张导入参考图。 */
function pack(dirs: string[], extra: Record<string, SeedFile> = {}) {
  const packBoard = board("包内画板", [promptNode("pp", "包里的提示词"), ...dirs.map((d, i) => resultNode(`r${i}`, d, [400, i * 300]))], []);
  const entries: Record<string, SeedFile> = { "manifest.json": manifest(), "画板/包内画板.ugcboard.json": { text: packBoard } };
  for (const d of dirs) {
    entries[`${d}/task.json`] = taskJson(d.split("/")[1]);
    entries[`${d}/result.png`] = { b64: IMG };
  }
  entries["导入参考图/abc.png"] = { b64: IMG };
  return { entries: { ...entries, ...extra } };
}

const localBoard = () => board("本地", [promptNode("p1", "本地提示词"), taskNode("t1")], []);

async function start(page: Page, partial: Partial<Scenario> = {}, boardText = localBoard()) {
  const errors = await openApp(page, boardScenario("本地", boardText, partial));
  await expect(page.locator(".react-flow__node[data-id=p1]")).toBeVisible();
  return errors;
}

const e2e = async <T>(page: Page, fn: (c: Window["__e2e"]) => T) => (await page.evaluateHandle(() => window.__e2e)).evaluate(fn);
const calls = (page: Page, cmd: string) => page.evaluate((c) => window.__e2e.calls.filter((x) => x.cmd === c).map((x) => x.args as any), cmd);
const cmdOrder = (page: Page) => page.evaluate(() => window.__e2e.calls.map((x) => x.cmd).filter((c) => c.startsWith("board_pack_")));

async function pickImport(page: Page, path = PACK) {
  await page.evaluate((p) => window.__e2e.dialogAnswers.open.push(p), path);
  await page.getByRole("button", { name: "画板包 ▾" }).click();
  await page.getByRole("menuitem", { name: "导入画板包…" }).click();
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "画板包" });
const toast = (page: Page) => page.locator(".toast");

test("#9 导入正常：复位取消 → 进度 → 移入任务目录 → 写画板并在新标签页打开 → toast", async ({ page }) => {
  const errors = await start(page, { packs: { [PACK]: pack([TASK_A]) } });
  await pickImport(page);
  await expect(toast(page)).toHaveText("导入 1 个任务，跳过 0 个");
  await expect(dialog(page)).toHaveCount(0);
  // 新标签页打开并激活
  await expect(page.getByText("包内画板", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".react-flow__node[data-id=pp]")).toBeVisible();
  const state = await e2e(page, (c) => ({
    taskJson: c.exists("/e2e/out/2026-09-16/20260916T010000Z-0000000a/task.json"),
    result: c.exists("/e2e/out/2026-09-16/20260916T010000Z-0000000a/result.png"),
    ref: c.exists("/e2e/out/导入参考图/abc.png"),
    board: c.readText("/e2e/out/画板/包内画板.ugcboard.json"),
    log: c.logs.filter((l) => l.kind === "board_pack"),
  }));
  expect(state.taskJson && state.result && state.ref).toBe(true);
  expect(JSON.parse(state.board!).title).toBe("包内画板");
  expect(state.log).toEqual([expect.objectContaining({ fields: expect.objectContaining({ action: "import", result: "ok", task_dirs: 1, skipped: 0 }) })]);
  expect(await cmdOrder(page)).toEqual(["board_pack_entries", "board_pack_read_texts", "board_pack_cancel", "board_pack_import"]);
  expect((await calls(page, "board_pack_cancel"))[0]).toEqual({ cancelled: false });
  const [imp] = await calls(page, "board_pack_import");
  expect(imp.outputRoot).toBe(OUTPUT_ROOT);
  expect(imp.units).toEqual([{ path: TASK_A, identity: "task.json" }, { path: "导入参考图/abc.png", identity: null }]);
  expect(errors).toEqual([]);
});

test("#9b 导入与本地同名画板：改名写入，不覆盖本地画板", async ({ page }) => {
  const p = pack([TASK_A], { "manifest.json": manifest({ boards: ["画板/本地.ugcboard.json"] }), "画板/本地.ugcboard.json": { text: board("本地", [promptNode("pp", "包里的")], []) } });
  delete (p.entries as Record<string, SeedFile>)["画板/包内画板.ugcboard.json"];
  await start(page, { packs: { [PACK]: p } });
  const before = await e2e(page, (c) => c.readText("/e2e/out/画板/本地.ugcboard.json"));
  await pickImport(page);
  await expect(toast(page)).toHaveText("导入 1 个任务，跳过 0 个");
  const after = await e2e(page, (c) => ({ local: c.readText("/e2e/out/画板/本地.ugcboard.json"), boards: c.list("/e2e/out/画板/") }));
  expect(after.local).toBe(before);
  expect(after.boards.filter((b) => b.endsWith(".ugcboard.json"))).toHaveLength(2);
});

test("#10 包版本较新：message 弹窗「无法导入画板包」，不进进度、不写文件", async ({ page }) => {
  const p = pack([TASK_A], { "manifest.json": manifest({ pack_format_version: 2, app_version: "9.9.9" }) });
  await start(page, { packs: { [PACK]: p } });
  const before = await e2e(page, (c) => c.list("/e2e/out"));
  await pickImport(page);
  await expect.poll(() => calls(page, "plugin:dialog|message")).toHaveLength(1);
  const [msg] = await calls(page, "plugin:dialog|message");
  expect(msg.title).toBe("无法导入画板包");
  expect(msg.kind).toBe("warning");
  expect(msg.message).toContain("格式版本 2 高于本机支持的 1（由 9.9.9 导出）");
  expect(await cmdOrder(page)).toEqual(["board_pack_entries", "board_pack_read_texts"]);
  expect(await e2e(page, (c) => c.list("/e2e/out"))).toEqual(before);
  await expect(dialog(page)).toHaveCount(0);
  await expect(toast(page)).toHaveCount(0);
  expect(await e2e(page, (c) => c.logs.filter((l) => l.kind === "board_pack").map((l) => l.fields.result))).toEqual(["newer"]);
});

test("#11 包损坏：toast「无法导入画板包：…」，不进进度、不写文件", async ({ page }) => {
  const p = pack([TASK_A], { "杂项/说明.txt": { text: "x" } });
  await start(page, { packs: { [PACK]: p } });
  const before = await e2e(page, (c) => c.list("/e2e/out"));
  await pickImport(page);
  await expect(toast(page)).toHaveText("无法导入画板包：包内含无法识别的路径：杂项/说明.txt");
  expect(await cmdOrder(page)).toEqual(["board_pack_entries", "board_pack_read_texts"]);
  expect(await e2e(page, (c) => c.list("/e2e/out"))).toEqual(before);
  await expect(dialog(page)).toHaveCount(0);
});

test("#11b 包损坏：清单缺失 / 读不了包", async ({ page }) => {
  const p = pack([TASK_A]);
  delete (p.entries as Record<string, SeedFile>)["manifest.json"];
  await start(page, { packs: { [PACK]: p } });
  await pickImport(page);
  await expect(toast(page)).toHaveText("无法导入画板包：缺少 manifest.json");
  await pickImport(page, "/e2e/in/不存在.ugcpack");
  await expect(toast(page)).toContainText("无法导入画板包：无法读取画板包");
});

test("#12 导入进度中取消：进度条随事件更新 → 取消 → toast，不写画板", async ({ page }) => {
  await start(page, { packs: { [PACK]: pack([TASK_A]) }, hold: ["board_pack_import"] });
  await pickImport(page);
  await expect(dialog(page)).toContainText("正在导入画板包：a.ugcpack");
  await expect(dialog(page)).toContainText("准备中…");
  await expect.poll(() => e2e(page, (c) => c.held())).toEqual(["board_pack_import"]);
  await page.evaluate(() => window.__e2e.emit("board-pack-progress", { done: 512 * 1024, total: 1024 * 1024 }));
  await expect(dialog(page)).toContainText("512 KB / 1.0 MB");
  await expect(dialog(page).locator("progress")).toHaveAttribute("value", String(512 * 1024));
  // 进度中点背景不关闭
  await page.mouse.click(5, 500);
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "取消" }).click();
  await expect(toast(page)).toHaveText("已取消导入；已移入的任务目录保留");
  await expect(dialog(page)).toHaveCount(0);
  expect(await calls(page, "board_pack_cancel")).toEqual([{ cancelled: false }, { cancelled: true }]);
  expect(await calls(page, "write_board")).toEqual([]);
  expect(await e2e(page, (c) => c.exists("/e2e/out/画板/包内画板.ugcboard.json"))).toBe(false);
  expect(await e2e(page, (c) => c.logs.filter((l) => l.kind === "board_pack").map((l) => l.fields.result))).toEqual(["cancelled"]);
});

test("#13 导入冲突：一致的跳过、不一致的不覆盖并列出，新的照常移入，画板照常写", async ({ page }) => {
  const localA = taskJson("20260916T010000Z-0000000a", "（本机改过）");
  await start(page, {
    packs: { [PACK]: pack([TASK_A, TASK_B, TASK_C]) },
    files: {
      [`${OUTPUT_ROOT}/${TASK_A}/task.json`]: localA,
      [`${OUTPUT_ROOT}/${TASK_B}/task.json`]: taskJson("20260916T020000Z-0000000b"),
      [boardPath("本地")]: { text: localBoard() },
    },
  });
  await pickImport(page);
  await expect(dialog(page)).toContainText("导入 1 个任务，跳过 1 个，1 项冲突未覆盖");
  await expect(dialog(page).locator("ul.error-list li")).toHaveText([TASK_A]);
  const state = await e2e(page, (c) => ({
    a: c.readText("/e2e/out/2026-09-16/20260916T010000Z-0000000a/task.json"),
    aResult: c.exists("/e2e/out/2026-09-16/20260916T010000Z-0000000a/result.png"),
    c: c.exists("/e2e/out/2026-09-16/20260916T030000Z-0000000c/task.json"),
    board: c.exists("/e2e/out/画板/包内画板.ugcboard.json"),
  }));
  expect(state).toEqual({ a: localA.text, aResult: false, c: true, board: true });
  await dialog(page).getByRole("button", { name: "知道了" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator(".react-flow__node[data-id=pp]")).toBeVisible();
});

test("#14 导入后写画板失败：任务目录已导入，弹窗说明写画板失败", async ({ page }) => {
  await start(page, { packs: { [PACK]: pack([TASK_A]) } });
  await page.evaluate(() => (window.__e2e.fail.write_board = "磁盘已满"));
  await pickImport(page);
  await expect(dialog(page)).toContainText("导入 1 个任务，跳过 0 个");
  await expect(dialog(page)).toContainText("任务目录已导入，但写画板失败：磁盘已满");
  expect(await e2e(page, (c) => c.exists("/e2e/out/2026-09-16/20260916T010000Z-0000000a/task.json"))).toBe(true);
  expect(await e2e(page, (c) => c.logs.filter((l) => l.kind === "board_pack").map((l) => l.fields.result))).toEqual(["board_write_failed"]);
  await dialog(page).getByRole("button", { name: "知道了" }).click();
  await expect(dialog(page)).toHaveCount(0);
});

const exportBoard = (refPath: string) =>
  board("本地", [promptNode("p1", "本地提示词"), taskNode("t1"), referenceNode("ref", refPath), resultNode("r0", TASK_A)], []);

async function pickExport(page: Page) {
  await page.getByRole("button", { name: "画板包 ▾" }).click();
  await page.getByRole("menuitem", { name: "导出画板包…" }).click();
}

test("#15 导出：确认弹窗 → save 对话框 → board_pack_export 参数 → toast", async ({ page }) => {
  const files = { [`${OUTPUT_ROOT}/${TASK_A}/result.png`]: { b64: IMG }, [`${OUTPUT_ROOT}/${TASK_A}/task.json`]: taskJson("a"), "/e2e/elsewhere/ref.png": { b64: IMG } };
  const errors = await start(page, { files }, exportBoard("/e2e/elsewhere/ref.png"));
  await pickExport(page);
  await expect(dialog(page)).toContainText("导出画板包：本地.ugcboard.json");
  await expect(dialog(page)).toContainText("将打包画板与它引用的 1 个任务目录、1 张参考图。");
  await expect(dialog(page)).toContainText("包含完整提示词与任务记录，不脱敏");
  await page.evaluate(() => window.__e2e.dialogAnswers.save.push("/e2e/exp/给同事"));
  await dialog(page).getByRole("button", { name: "选择位置并导出…" }).click();
  await expect(toast(page)).toHaveText("已导出画板包到 /e2e/exp/给同事.ugcpack");
  await expect(dialog(page)).toHaveCount(0);
  const [save] = await calls(page, "plugin:dialog|save");
  expect(save.options.defaultPath).toBe("本地.ugcpack");
  const [exp] = await calls(page, "board_pack_export");
  expect(exp.outputRoot).toBe(OUTPUT_ROOT);
  expect(exp.target).toBe("/e2e/exp/给同事.ugcpack");
  expect(exp.spec.task_dirs).toEqual([TASK_A]);
  expect(exp.spec.files).toEqual([{ source: "/e2e/elsewhere/ref.png", entry: expect.stringMatching(/^导入参考图\/[0-9a-f]{64}\.png$/) }]);
  const texts = Object.fromEntries(exp.spec.texts.map((t: { entry: string; text: string }) => [t.entry, t.text]));
  expect(JSON.parse(texts["manifest.json"])).toEqual({ pack_format_version: 1, app_version: "0.0.0-e2e", boards: ["画板/本地.ugcboard.json"] });
  const packed = JSON.parse(texts["画板/本地.ugcboard.json"]);
  expect(packed.nodes.find((n: { id: string }) => n.id === "ref").path).toBe(exp.spec.files[0].entry);
  expect(await calls(page, "board_pack_cancel")).toEqual([{ cancelled: false }]);
  expect(await e2e(page, (c) => c.logs.filter((l) => l.kind === "board_pack").map((l) => l.fields.result))).toEqual(["ok"]);
  expect(errors).toEqual([]);
});

test("#15b 导出：缺图列出并改为「仍然导出…」；save 取消则什么都不做", async ({ page }) => {
  await start(page, {}, exportBoard("/e2e/elsewhere/丢了.png"));
  await pickExport(page);
  await expect(dialog(page)).toContainText("以下 2 张图片缺失");
  await expect(dialog(page).locator("ul.error-list li")).toHaveText([`/e2e/elsewhere/丢了.png`, `${TASK_A}/result.png`]);
  await dialog(page).getByRole("button", { name: "仍然导出…" }).click();
  await expect.poll(() => calls(page, "plugin:dialog|save")).toHaveLength(1);
  await expect(dialog(page)).toBeVisible();
  expect(await calls(page, "board_pack_export")).toEqual([]);
  await dialog(page).getByRole("button", { name: "取消" }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test("#16 导出进度中取消：toast「已取消导出画板包」，不留文件", async ({ page }) => {
  const files = { [`${OUTPUT_ROOT}/${TASK_A}/result.png`]: { b64: IMG }, "/e2e/elsewhere/ref.png": { b64: IMG } };
  await start(page, { files, hold: ["board_pack_export"] }, exportBoard("/e2e/elsewhere/ref.png"));
  await pickExport(page);
  await page.evaluate(() => window.__e2e.dialogAnswers.save.push("/e2e/exp/x.ugcpack"));
  await dialog(page).getByRole("button", { name: "选择位置并导出…" }).click();
  await expect(dialog(page)).toContainText("正在导出画板包：本地");
  await expect.poll(() => e2e(page, (c) => c.held())).toEqual(["board_pack_export"]);
  await page.evaluate(() => window.__e2e.emit("board-pack-progress", { done: 100, total: 3 * 1024 * 1024 }));
  await expect(dialog(page)).toContainText("0 KB / 3.0 MB");
  await dialog(page).getByRole("button", { name: "取消" }).click();
  await expect(toast(page)).toHaveText("已取消导出画板包");
  await expect(dialog(page)).toHaveCount(0);
  expect(await calls(page, "board_pack_cancel")).toEqual([{ cancelled: false }, { cancelled: true }]);
  expect(await e2e(page, (c) => c.exists("/e2e/exp/x.ugcpack"))).toBe(false);
  expect(await e2e(page, (c) => c.logs.filter((l) => l.kind === "board_pack").map((l) => l.fields.result))).toEqual(["cancelled"]);
});
