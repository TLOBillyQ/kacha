import { expect, test } from "@playwright/test";
import { board, boardScenario, edge, GW, openApp, png, promptNode, task, taskNode } from "../app";
import { OUTPUT_ROOT } from "../scenario";

const FLASH = "doubao-seedream-5-0-flash-260915";
const LITE = "doubao-seedream-5-0-lite-260128";
const ID = "20260916T091500Z-deadbeef";
const DIR = `2026-09-16/${ID}`;
const size = { tier: "3K", ratio: "1:1", width: null, height: null };
const record = { task_id: ID, submitted_at: "2026-09-16T09:15:00Z", workflow: "text_to_image", model: LITE, capability_format_version: 1, capability_table_sha256: "a".repeat(64), prompt: "旧猫", negative_prompt: "", send_text: "旧猫", size_spec: size, size: { width: 3072, height: 3072 }, layer_decomposition: false, transparent_background: false, references: [] };
const last = { task_id: ID, model: LITE, prompt: "旧猫", negative_prompt: "", size_spec: size, images: [], layer_decomposition: false, transparent_background: false };
const oldBoard = () => board("旧Lite", [promptNode("p", "一只猫"), taskNode("t", { model: LITE, size_spec: size, last_submitted: last }), { id: "r", type: "result", pos: [850, 0], size: [200, 220], task_id: ID, file: "result.png", path: `${DIR}/result.png`, layer_count: 0, record: { model: LITE, prompt: "旧猫", negative_prompt: "", size_spec: size, submitted_at: record.submitted_at } }], [edge("p", "t", "positive"), edge("t", "r", "in", { system: true, from: ["t", "result"] })]);
const files = { [`${OUTPUT_ROOT}/${DIR}/task.json`]: { text: JSON.stringify(record) }, [`${OUTPUT_ROOT}/${DIR}/result.png`]: { b64: png(1024, 1024) } };
const toast = (page: Parameters<typeof task>[0]) => page.locator(".toast");

for (const imported of [false, true]) test(`Lite ${imported ? "画板包导入" : "普通打开"}：阻止所有历史入口，手动切换只创建新 Flash 任务`, async ({ page }) => {
  const text = oldBoard();
  const packPath = "/e2e/in/old.ugcpack";
  const scn = imported ? boardScenario("本地", board("本地", [promptNode("local", "本地")], []), { packs: { [packPath]: { entries: { "manifest.json": { text: JSON.stringify({ pack_format_version: 1, app_version: "0.3.0", boards: ["画板/旧Lite.ugcboard.json"] }) }, "画板/旧Lite.ugcboard.json": { text }, [`${DIR}/task.json`]: files[`${OUTPUT_ROOT}/${DIR}/task.json`], [`${DIR}/result.png`]: files[`${OUTPUT_ROOT}/${DIR}/result.png`] } } } }) : boardScenario("旧Lite", text, { files });
  const errors = await openApp(page, scn);
  if (imported) {
    await page.evaluate((path) => window.__e2e.dialogAnswers.open.push(path), packPath);
    await page.getByRole("button", { name: "画板包 ▾" }).click();
    await page.getByRole("menuitem", { name: "导入画板包…" }).click();
  }
  await expect(task(page, "t")).toBeVisible();
  const bodies: Record<string, unknown>[] = [];
  await page.route(`${GW}/v1/images/generations`, (route) => {
    bodies.push(JSON.parse(route.request().postData()!));
    return route.fulfill({ json: { data: [{ b64_json: png(1024, 1024) }] } });
  });
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect(toast(page)).toContainText("Lite 已停用，请切换到 Flash");
  await task(page, "t").getByRole("button", { name: "展开" }).click();
  const select = task(page, "t").getByRole("combobox", { name: "模型", exact: true });
  await expect(select).toHaveValue(LITE);
  await expect(select.locator(`option[value='${LITE}']`)).toBeDisabled();
  await task(page, "r").locator(".node-title").click({ button: "right" });
  await page.getByRole("menuitem", { name: "以此继续编辑", exact: true }).click();
  await expect(page.locator(".react-flow__node-task").filter({ hasText: "Lite（已停用" })).toHaveCount(2);
  await select.selectOption(FLASH);
  // 3K remains invalid, requiring the user's explicit adjustment.
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect(toast(page)).toContainText("生成尺寸不在模型尺寸表内");
  expect(bodies).toHaveLength(0);
  await task(page, "t").getByRole("combobox", { name: "分辨率档" }).selectOption("2K");
  await task(page, "t").locator(".node-title").click({ button: "right" });
  await page.getByRole("menuitem", { name: "重新生成", exact: true }).click();
  await expect(toast(page)).toContainText("Lite 已停用，请切换到 Flash");
  await task(page, "r").locator(".node-title").click({ button: "right" });
  await page.getByRole("menuitem", { name: "生成变体", exact: true }).click();
  await expect(toast(page)).toContainText("Lite 已停用，请切换到 Flash");
  expect(bodies).toHaveLength(0);
  await task(page, "r").locator(".node-title").click({ button: "right" });
  await page.getByRole("menuitem", { name: "以此继续编辑", exact: true }).click();
  const continued = page.locator(".react-flow__node-task").filter({ hasText: "Lite（已停用" }).last();
  await expect(continued).toBeVisible();
  await page.screenshot({ path: `test-results/retirement-${imported ? "import" : "open"}.png` });
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({ model: FLASH, size: "2048x2048" });
  const saved = await page.evaluate((root) => window.__e2e.list(root).filter((p) => p.endsWith("/task.json")).map((p) => window.__e2e.readText(p)), OUTPUT_ROOT);
  expect(saved).toContain(JSON.stringify(record));
  expect(saved.map((s) => JSON.parse(s!)).filter((r) => r.model === FLASH)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("缺 Flash 缓存先刷新，失败明确不可用，用户可显式选择其它模型", async ({ page }) => {
  await openApp(page, boardScenario("缺Flash", board("缺Flash", [promptNode("p", "猫")], []), { modelsCache: JSON.stringify({ base_url: GW, fetched_at: "old", model_ids: ["qwen-image-3.0"] }) }));
  await page.route(`${GW}/v1/models`, (route) => route.fulfill({ status: 500, body: "unavailable" }));
  await page.reload();
  const select = page.getByRole("combobox", { name: "新建任务模型" });
  await expect(select).toHaveValue(FLASH);
  await expect(select.locator("option:checked")).toHaveText("Flash 不可用，请刷新模型列表");
  await select.selectOption("qwen-image-3.0");
  await expect(select).toHaveValue("qwen-image-3.0");
  expect(await select.locator(`option[value='${LITE}']`).count()).toBe(0);
  await page.screenshot({ path: "test-results/retirement-missing-flash.png" });
});
