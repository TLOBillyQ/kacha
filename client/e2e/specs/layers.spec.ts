// Synthetic assets generated from the official flat-response/bbox example contract.
// These tests exercise client behavior only, never a real gateway or visual model quality.
import { expect, test } from "@playwright/test";
import { board, boardPath, boardScenario, edge, GW, openApp, png, referenceNode, task, taskNode } from "../app";
import { OUTPUT_ROOT, scenario } from "../scenario";

const FLASH = "doubao-seedream-5-0-flash-260915";
const bbox = { absolute: [100, 200, 400, 600], normalized: [100, 200, 400, 600] };
const base = png(1000, 1000);
const layer = png(72, 96, { alpha: true, rgb: [210, 80, 42] });

test("single image → optional prompt → bbox preview → save → reopen from taskDir true source", async ({ page }) => {
  const title = "官方契约合成图层";
  const text = board(title, [referenceNode("r", "refs/synthetic.png"), taskNode("t", { model: FLASH, image_ports: 1 })], [edge("r", "t", "image:0")]);
  const errors = await openApp(page, boardScenario(title, text, { files: { [`${OUTPUT_ROOT}/refs/synthetic.png`]: { b64: base } } }));
  const bodies: any[] = [];
  await page.route(`${GW}/v1/images/generations`, (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: { data: [{ z_index: 1, b64_json: layer, bounding_box: bbox, name: "合成主体", description: "官方契约合成资产，非网关实测" }, { z_index: 0, b64_json: base }] } });
  });
  await task(page, "t").getByRole("button", { name: "展开", exact: true }).click();
  await task(page, "t").getByRole("checkbox", { name: "拆分图层" }).check();
  await expect(task(page, "t").getByRole("combobox", { name: "图层尺寸" })).toHaveValue("auto");
  await expect(task(page, "t").getByRole("combobox", { name: "宽高比", exact: true })).toHaveCount(0);
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ layer_decomposition: true, size: "auto" });
  expect(bodies[0]).not.toHaveProperty("prompt");
  const metadata = await page.evaluate((root) => {
    const path = window.__e2e.list(root).find((p) => p.endsWith("/layers.json"))!;
    return JSON.parse(window.__e2e.readText(path)!);
  }, OUTPUT_ROOT);
  expect(metadata.layers[0]).toMatchObject({ bounding_box: bbox, name: "合成主体" });
  await expect.poll(async () => JSON.parse((await page.evaluate((p) => window.__e2e.readText(p), boardPath(title)))!).nodes.some((n: any) => n.type === "result")).toBe(true);
  // Corrupt the redundant board copy; task directory remains authoritative after reopening.
  await page.evaluate((p) => {
    const raw = JSON.parse(window.__e2e.readText(p)!);
    raw.nodes.find((n: any) => n.type === "result").record.layers = [];
    window.__e2e.writeText(p, JSON.stringify(raw));
  }, boardPath(title));
  await page.locator(".tab", { hasText: title }).locator(".tab-close").click();
  await expect(page.locator(".tab", { hasText: title })).toHaveCount(0);
  await page.evaluate((p) => window.__e2e.emit("second-instance", [p]), boardPath(title));
  const result = page.locator(".react-flow__node-result");
  await expect(result).toHaveCount(1);
  await result.locator("img").first().dblclick();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".layer-list")).toContainText("合成主体");
  await dialog.locator(".layer-list input[type=checkbox]").check();
  const overlay = dialog.locator(".preview-layer");
  await expect(overlay).toHaveCSS("position", "absolute");
  const dimensions = await overlay.evaluate((el) => {
    const image = el.getBoundingClientRect(), canvas = el.parentElement!.getBoundingClientRect();
    return { left: (image.left - canvas.left) / canvas.width, top: (image.top - canvas.top) / canvas.height, width: image.width / canvas.width, height: image.height / canvas.height };
  });
  expect(dimensions.left).toBeCloseTo(0.1, 2);
  expect(dimensions.top).toBeCloseTo(0.2, 2);
  expect(dimensions.width).toBeCloseTo(0.3, 2);
  expect(dimensions.height).toBeCloseTo(0.4, 2);
  await page.evaluate(() => window.__e2e.dialogAnswers.open.push("/e2e/export"));
  await dialog.getByRole("button", { name: "保存全部图层 + layers.json", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__e2e.readText("/e2e/export/layers.json"))).not.toBeNull();
  const exported = await page.evaluate(() => JSON.parse(window.__e2e.readText("/e2e/export/layers.json")!));
  expect(exported.layers[0]).toMatchObject({ bounding_box: bbox, name: "合成主体", description: "官方契约合成资产，非网关实测" });
  await page.screenshot({ path: "test-results/layers-preview.png" });
  expect(errors).toEqual([]);
});

// 图层元数据损坏必须按真实原因提示，不能误报「找不到画板文件」或静默跳过。
const TASK_ID = "20261010T000000Z-abcdef01";
const TASK_DIR = `${OUTPUT_ROOT}/2026-10-10/${TASK_ID}`;
const CORRUPT_TITLE = "损坏图层画板";
const corruptBoard = () =>
  board(
    CORRUPT_TITLE,
    [
      {
        id: "res",
        type: "result",
        pos: [0, 0],
        size: [200, 200],
        task_id: TASK_ID,
        file: "result.png",
        path: `2026-10-10/${TASK_ID}/result.png`,
        layer_count: 1,
        record: { model: FLASH, prompt: "", negative_prompt: "", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, submitted_at: "", layers: [{ file: "layers/01.png", z_index: 1, bounding_box: bbox }] },
      },
    ],
    [],
  );
const corruptFiles = { [`${TASK_DIR}/result.png`]: { b64: base }, [`${TASK_DIR}/layers.json`]: { text: "{损坏" } };

test("layers.json 损坏：打开画板报真实原因，不误报找不到画板文件", async ({ page }) => {
  const errors = await openApp(page, boardScenario(CORRUPT_TITLE, corruptBoard(), { uiState: null, files: corruptFiles }));
  await expect(page.locator(".tab")).toHaveCount(1);
  await page.evaluate((p) => window.__e2e.emit("second-instance", [p]), boardPath(CORRUPT_TITLE));
  await expect(page.locator(".toast")).toContainText("图层元数据损坏");
  await expect(page.locator(".toast")).not.toContainText("找不到画板文件");
  await expect(page.locator(".tab", { hasText: CORRUPT_TITLE })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("layers.json 损坏：启动恢复不静默跳过，提示真实原因", async ({ page }) => {
  const errors = await openApp(page, boardScenario(CORRUPT_TITLE, corruptBoard(), { files: corruptFiles }));
  await expect(page.locator(".toast")).toContainText("图层元数据损坏");
  await expect(page.locator(".tab", { hasText: CORRUPT_TITLE })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("画板文件确实不存在时仍报找不到画板文件", async ({ page }) => {
  const errors = await openApp(page, scenario({ settings: null }));
  await expect(page.locator(".tab")).toHaveCount(1);
  await page.evaluate((root) => window.__e2e.emit("second-instance", [`${root}/画板/不存在.ugcboard.json`]), OUTPUT_ROOT);
  await expect(page.locator(".toast")).toContainText("找不到画板文件");
  expect(errors).toEqual([]);
});
