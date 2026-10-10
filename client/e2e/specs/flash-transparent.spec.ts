import { expect, test } from "@playwright/test";
import { board, boardScenario, edge, GW, openApp, png, promptNode, referenceNode, task, taskNode } from "../app";
import { OUTPUT_ROOT } from "../scenario";

const FLASH = "doubao-seedream-5-0-flash-260915";
const REF = "refs/alpha.png";
const records = (page: import("@playwright/test").Page) => page.evaluate(root => window.__e2e.list(root).filter(p => p.endsWith("/task.json")).map(p => JSON.parse(window.__e2e.readText(p)!)), OUTPUT_ROOT);

async function setup(page: import("@playwright/test").Page, alpha = true, region = false) {
  const text = board("透明", [promptNode("p", "把图1 改成红色"), referenceNode("r", REF), taskNode("t", { model: FLASH, image_ports: 1 })], [edge("p", "t", "positive"), edge("r", "t", "image:0", region ? { region: { rects: [[0, 0, 0.5, 0.5]], render: "highlight_overlay" } } : {})]);
  const errors = await openApp(page, boardScenario("透明", text, { files: { [`${OUTPUT_ROOT}/${REF}`]: { b64: png(32, 32, { alpha }) } } }));
  await task(page, "t").getByRole("button", { name: "展开" }).click();
  return errors;
}

test("透明开关到生成、保存和历史重新生成，PNG/JPEG 控件一致", async ({ page }) => {
  const errors = await setup(page);
  const bodies: Record<string, any>[] = [];
  await page.route(`${GW}/v1/images/generations`, route => { bodies.push(JSON.parse(route.request().postData()!)); return route.fulfill({ json: { data: [{ b64_json: png(32, 32, { alpha: true }) }] } }); });
  const toggle = task(page, "t").getByRole("checkbox", { name: /透明背景/ });
  await expect(toggle).toBeEnabled();
  await toggle.check();
  await task(page, "t").getByRole("combobox", { name: "输出格式" }).selectOption("jpeg");
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect(page.locator(".toast")).toContainText("透明背景输出必须为 PNG");
  expect(bodies).toHaveLength(0);
  await task(page, "t").getByRole("combobox", { name: "输出格式" }).selectOption("png");
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
  expect(bodies[0]).toMatchObject({ background: "transparent", output_format: "png", model: FLASH });
  expect(bodies[0].image).toHaveLength(1);
  expect((await records(page))[0]).toMatchObject({ transparent_background: true, output_options: { output_format: "png" } });
  await toggle.uncheck();
  await task(page, "t").getByRole("combobox", { name: "输出格式" }).selectOption("jpeg");
  await task(page, "t").locator(".node-title").click({ button: "right" });
  await page.getByRole("menuitem", { name: "重新生成", exact: true }).click();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(2);
  expect(bodies[1]).toMatchObject({ background: "transparent", output_format: "png", image: bodies[0].image });
  await page.screenshot({ path: "test-results/flash-transparent.png" });
  expect(errors).toEqual([]);
});

for (const mode of ["opaque", "overlay"] as const) test(`透明开关拒绝 ${mode} 输入`, async ({ page }) => {
  await setup(page, mode !== "opaque", mode === "overlay");
  const toggle = task(page, "t").getByRole("checkbox", { name: /透明背景/ });
  await expect(toggle).toBeDisabled();
  await expect(task(page, "t")).toContainText(mode === "opaque" ? "该图不带透明通道" : "需要恰好一张实际参考图");
});
