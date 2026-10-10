// issue #20：Flash 图层导出（底图 + 独立 alpha 图层 + 完整元数据 layers.json）、画板包往返后按任务目录真源还原图层、
// 来源图层继续创作（实际发送图层字节、谱系指向产出处）、缺图层文件 / 无效身份明确阻断、旧结果兼容。
import { expect, test, type Page } from "@playwright/test";
import { board, boardPath, boardScenario, edge, GW, openApp, png, promptNode, task, taskNode } from "../app";
import { OUTPUT_ROOT, scenario, type Scenario, type SeedFile } from "../scenario";

const FLASH = "doubao-seedream-5-0-flash-260915";
const TASK_ID = "20260916T010000Z-0000000a";
const DIR = `2026-09-16/${TASK_ID}`;
const BASE = png(64, 64);
const L1 = png(64, 64, { alpha: true, rgb: [255, 0, 0] });
const L2 = png(64, 64, { alpha: true, rgb: [0, 255, 0] });
const BOX1 = { absolute: [0, 0, 64, 64], normalized: [0, 0, 1000, 1000] };
const BOX2 = { absolute: [8, 8, 40, 40], normalized: [125, 125, 625, 625] };

/** 任务目录真源 layers.json：底图身份 + 两层完整元数据。 */
const layersJson = () =>
  JSON.stringify({
    base: { z_index: 0, name: "合成底图", description: "底图说明" },
    layers: [
      { file: "layers/01.png", z_index: 1, bounding_box: BOX1, name: "主体", description: "红色层" },
      { file: "layers/02.png", z_index: 2, bounding_box: BOX2, name: "点缀", description: "绿色层" },
    ],
  });

/** Flash 结果节点：画板里只留最小记录（无图层副本），靠打开时按真源还原。 */
const flashResult = (id: string, pos: [number, number] = [800, 0]) => ({
  id, type: "result", pos, size: [220, 280], task_id: TASK_ID, file: "result.png", path: `${DIR}/result.png`, layer_count: 0,
  record: { model: FLASH, prompt: "p", negative_prompt: "", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-09-16T01:00:00Z" },
});

const taskFiles = (withLayer2 = true): Record<string, SeedFile> => ({
  [`${OUTPUT_ROOT}/${DIR}/task.json`]: { text: JSON.stringify({ task_id: TASK_ID, model: FLASH, prompt: "p", size: { width: 64, height: 64 }, references: [] }) },
  [`${OUTPUT_ROOT}/${DIR}/result.png`]: { b64: BASE },
  [`${OUTPUT_ROOT}/${DIR}/layers.json`]: { text: layersJson() },
  [`${OUTPUT_ROOT}/${DIR}/layers/01.png`]: { b64: L1 },
  ...(withLayer2 ? { [`${OUTPUT_ROOT}/${DIR}/layers/02.png`]: { b64: L2 } } : {}),
});

const e2e = async <T>(page: Page, fn: (c: Window["__e2e"]) => T) => (await page.evaluateHandle(() => window.__e2e)).evaluate(fn);
const calls = (page: Page, cmd: string) => page.evaluate((c) => window.__e2e.calls.filter((x) => x.cmd === c).map((x) => x.args as any), cmd);

/** 双击结果节点缩略图打开预览。 */
async function openPreview(page: Page, nodeId: string) {
  await page.locator(`.react-flow__node[data-id="${nodeId}"] img.thumb`).dblclick();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("图层导出：底图 + layers/ 子目录图层 + 完整元数据 layers.json（真源含底图与名称 / 描述）", async ({ page }) => {
  const errors = await openApp(page, boardScenario("图层", board("图层", [flashResult("res")], []), { files: taskFiles() }));
  await openPreview(page, "res");
  // 侧栏露出两层（打开时已按 layers.json 真源还原）。
  await expect(page.getByRole("dialog").locator(".layer-list li")).toHaveCount(2);
  await page.evaluate(() => window.__e2e.dialogAnswers.open.push("/e2e/exp/layers-out"));
  await page.getByRole("button", { name: "保存全部图层 + layers.json" }).click();
  await expect(page.locator(".toast")).toHaveText("已保存底图、2 个图层与 layers.json");
  const out = await e2e(page, (c) => ({
    files: c.list("/e2e/exp/layers-out/"),
    json: c.readText("/e2e/exp/layers-out/layers.json"),
  }));
  expect(out.files).toEqual(["/e2e/exp/layers-out/layers.json", "/e2e/exp/layers-out/layers/01.png", "/e2e/exp/layers-out/layers/02.png", "/e2e/exp/layers-out/result.png"]);
  expect(JSON.parse(out.json!)).toEqual({
    base: { z_index: 0, name: "合成底图", description: "底图说明", file: "result.png" },
    layers: [
      { file: "layers/01.png", z_index: 1, bounding_box: BOX1, name: "主体", description: "红色层" },
      { file: "layers/02.png", z_index: 2, bounding_box: BOX2, name: "点缀", description: "绿色层" },
    ],
  });
  expect(errors).toEqual([]);
});

test("画板包往返：导出 → 导入 → 重开按真源还原图层 → 来源图层继续创作发真实图层字节、谱系指向产出处", async ({ page }) => {
  // —— 导出（画板里结果节点不带图层副本，导出前打开时已还原）——
  await openApp(page, boardScenario("本地", board("本地", [flashResult("res")], []), { files: taskFiles() }));
  await page.getByRole("button", { name: "画板包 ▾" }).click();
  await page.getByRole("menuitem", { name: "导出画板包…" }).click();
  const dialog = page.getByRole("dialog", { name: "画板包" });
  await expect(dialog).toContainText("将打包画板与它引用的 1 个任务目录");
  await page.evaluate(() => window.__e2e.dialogAnswers.save.push("/e2e/exp/rt"));
  await dialog.getByRole("button", { name: "选择位置并导出…" }).click();
  await expect(page.locator(".toast")).toHaveText("已导出画板包到 /e2e/exp/rt.ugcpack");

  // —— 从假壳里取回导出规格，组装成另一台机器上的包文件 ——
  const specText = await e2e(page, (c) => c.readText("/e2e/exp/rt.ugcpack"));
  const spec = JSON.parse(specText!) as { texts: { entry: string; text: string }[]; task_dirs: string[]; files: { source: string; entry: string }[] };
  expect(spec.task_dirs).toEqual([DIR]);
  const blobs = await page.evaluate(
    async ({ dirs, root }) => {
      const out: Record<string, string> = {};
      const paths = dirs.flatMap((d) => window.__e2e.list(`${root}/${d}/`));
      for (const p of paths) {
        const buf = (await (window.__TAURI_INTERNALS__ as { invoke: (cmd: string, args: unknown) => Promise<ArrayBuffer> }).invoke("read_file_bytes", { path: p })) as ArrayBuffer;
        out[p] = btoa([...new Uint8Array(buf)].map((b) => String.fromCharCode(b)).join(""));
      }
      return out;
    },
    { dirs: spec.task_dirs, root: OUTPUT_ROOT },
  );
  const entries: Record<string, SeedFile> = {};
  for (const t of spec.texts) entries[t.entry] = { text: t.text };
  for (const [abs, b64] of Object.entries(blobs)) entries[abs.slice(OUTPUT_ROOT.length + 1)] = { b64 };
  // 包内图层文件齐全
  expect(Object.keys(entries).sort()).toEqual(expect.arrayContaining([`${DIR}/layers.json`, `${DIR}/layers/01.png`, `${DIR}/layers/02.png`, `${DIR}/result.png`, `${DIR}/task.json`]));
  // 篡改包内画板：去掉图层副本，证明导入重开是按任务目录真源还原的。
  const boardEntry = Object.keys(entries).find((k) => k.endsWith(".ugcboard.json"))!;
  const doc = JSON.parse((entries[boardEntry] as { text: string }).text);
  for (const n of doc.nodes) if (n.type === "result") { n.layer_count = 0; delete n.record.layers; }
  entries[boardEntry] = { text: JSON.stringify(doc, null, 2) };

  // —— 另一台机器：空输出根目录导入 ——
  const fresh: Scenario = boardScenario("空", board("空", [], []), { packs: { "/e2e/in/rt.ugcpack": { entries } } });
  await openApp(page, fresh);
  await page.evaluate(() => window.__e2e.dialogAnswers.open.push("/e2e/in/rt.ugcpack"));
  await page.getByRole("button", { name: "画板包 ▾" }).click();
  await page.getByRole("menuitem", { name: "导入画板包…" }).click();
  await expect(page.locator(".toast")).toHaveText("导入 1 个任务，跳过 0 个");
  await openPreview(page, "res");
  await expect(page.getByRole("dialog").locator(".layer-list li")).toHaveCount(2);

  // —— 来源图层继续创作：选图层2，新任务发出的是图层2的真实字节 ——
  const bodies: Record<string, any>[] = [];
  await page.route(`${GW}/v1/images/generations`, (route) => {
    bodies.push(JSON.parse(route.request().postData()!));
    return route.fulfill({ json: { data: [{ b64_json: png(64, 64) }] } });
  });
  await page.getByRole("dialog").getByRole("combobox").selectOption("2");
  await page.getByRole("dialog").getByRole("button", { name: "以此继续编辑" }).click();
  // 预览弹窗不自动关：关掉它再操作画布。
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const prompt = page.locator(".react-flow__node-prompt textarea");
  await prompt.fill("把图层2 变成蓝色");
  const newTask = page.locator(".react-flow__node-task");
  await expect(newTask).toHaveCount(1);
  // 连线带来源图层身份（等自动保存落盘后从画板文件确认）
  await expect.poll(async () => {
    const texts = await e2e(page, (c) => c.list("/e2e/out/画板/").filter((p) => p.endsWith(".ugcboard.json") && !p.endsWith(".bak")).map((p) => c.readText(p)));
    return texts.some((t) => t && (JSON.parse(t).edges as { source_layer?: number }[]).some((e) => e.source_layer === 2));
  }).toBe(true);
  await newTask.locator(".task-actions button.primary").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].image).toEqual([`data:image/png;base64,${L2}`]);
  // 谱系：task.json 记录的参考图来源指向产出结果的图层2
  const recordTexts = await e2e(page, (c) => c.list("/e2e/out").filter((p) => p.endsWith("/task.json") && !p.includes("20260916T010000Z-0000000a")).map((p) => c.readText(p)));
  expect(recordTexts).toHaveLength(1);
  const record = JSON.parse(recordTexts[0]!);
  expect(record.references[0].source).toEqual({ kind: "result", task_id: TASK_ID, file: "result.png", source_layer: 2 });
});

test("缺图层文件 / 无效来源图层身份：明确阻断运行，不回落底图、不发送请求", async ({ page }) => {
  const mk = (sourceLayer: number) =>
    board("阻断", [promptNode("p1", "改一改"), flashResult("res", [0, 300]), taskNode("t1", { model: FLASH, image_ports: 1 })], [
      edge("p1", "t1", "positive"),
      edge("res", "t1", "image:0", { source_layer: sourceLayer }),
    ]);
  // 缺 layers/02.png，连线接图层2
  await openApp(page, boardScenario("阻断", mk(2), { files: taskFiles(false) }));
  await task(page, "t1").getByRole("button", { name: "展开" }).click();
  await expect(task(page, "t1")).toContainText("图1 图片缺失：result.png 图层2");
  const bodies: Record<string, any>[] = [];
  await page.route(`${GW}/v1/images/generations`, (route) => {
    bodies.push(JSON.parse(route.request().postData()!));
    return route.fulfill({ json: { data: [{ b64_json: png(64, 64) }] } });
  });
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect(page.locator(".toast")).toContainText("无法运行");
  expect(bodies).toHaveLength(0);

  // 图层身份越界（只有 2 层接图层5）：明确报无效身份
  await openApp(page, boardScenario("阻断", mk(5), { files: taskFiles() }));
  await task(page, "t1").getByRole("button", { name: "展开" }).click();
  await expect(task(page, "t1")).toContainText("图1 来源图层无效：result.png 图层5");
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect(page.locator(".toast")).toContainText("无法运行");
  expect(bodies).toHaveLength(0);
});

test("旧结果兼容：无 layers.json、旧版四元数组 bbox 的 Flash 结果照常打开、预览与导出", async ({ page }) => {
  const legacy = {
    ...flashResult("res"),
    layer_count: 1,
    record: { ...flashResult("res").record, layers: [{ file: "layers/01.png", z_index: 1, bounding_box: [0, 0, 64, 64] }] },
  };
  const files: Record<string, SeedFile> = {
    [`${OUTPUT_ROOT}/${DIR}/task.json`]: taskFiles()[`${OUTPUT_ROOT}/${DIR}/task.json`],
    [`${OUTPUT_ROOT}/${DIR}/result.png`]: { b64: BASE },
    [`${OUTPUT_ROOT}/${DIR}/layers/01.png`]: { b64: L1 },
  };
  const errors = await openApp(page, boardScenario("旧", board("旧", [legacy], []), { files }));
  await openPreview(page, "res");
  await expect(page.getByRole("dialog").locator(".layer-list li")).toHaveCount(1);
  await page.evaluate(() => window.__e2e.dialogAnswers.open.push("/e2e/exp/legacy"));
  await page.getByRole("button", { name: "保存全部图层 + layers.json" }).click();
  await expect(page.locator(".toast")).toHaveText("已保存底图、1 个图层与 layers.json");
  const json = JSON.parse((await e2e(page, (c) => c.readText("/e2e/exp/legacy/layers.json")))!);
  // 旧 bbox 形状原样带出；底图身份补上实际写出的文件名
  expect(json).toEqual({ base: { file: "result.png", z_index: 0 }, layers: [{ file: "layers/01.png", z_index: 1, bounding_box: [0, 0, 64, 64] }] });
  expect(errors).toEqual([]);
});
