import { expect, test } from "@playwright/test";
import { board, boardScenario, edge, GW, openApp, png, promptNode, referenceNode, task, taskNode } from "../app";
import { OUTPUT_ROOT } from "../scenario";

const FLASH = "doubao-seedream-5-0-flash-260915";
const REGION = { rects: [[0, 0, 1, 1]], render: "highlight_overlay" };
const files = {
  [`${OUTPUT_ROOT}/refs/a.png`]: { b64: png(1024, 1024, { rgb: [180, 20, 30] }) },
  [`${OUTPUT_ROOT}/refs/b.png`]: { b64: png(1024, 1024, { rgb: [20, 30, 180] }) },
};

for (const prompt of ["把图2 的区域2复制到图1 的区域1，其余保持不变", "Copy region 2 of Image 2 to region 1 of Image 1, keep the rest unchanged"]) {
  test(`Flash UI选择坐标表达，跨图发送文本/端口/记录/载荷一致：${prompt}`, async ({ page }) => {
    const text = board("区域", [promptNode("p", prompt), referenceNode("a", "refs/a.png"), referenceNode("b", "refs/b.png"), taskNode("t", { model: FLASH, image_ports: 2 })], [edge("p", "t", "positive"), edge("a", "t", "image:0", { region: REGION }), edge("b", "t", "image:1", { region: REGION })]);
    const errors = await openApp(page, boardScenario("区域", text, { files }));
    const bodies: any[] = [];
    await page.route(`${GW}/v1/images/generations`, route => { bodies.push(JSON.parse(route.request().postData()!)); return route.fulfill({ json: { data: [{ b64_json: png(1024, 1024) }] } }); });
    await task(page, "t").getByRole("button", { name: "展开" }).click();
    await expect(task(page, "t").locator(".port-overlay")).toHaveCount(2);
    for (const [i, mode] of ["bbox", "point"].entries()) {
      await task(page, "t").locator("button.port-region").nth(i).click();
      await page.getByRole("combobox", { name: "区域表达" }).selectOption(mode);
      if (i === 0 && prompt.startsWith("把")) {
        await page.screenshot({ path: "test-results/region-controls-desktop.png" });
        await page.setViewportSize({ width: 1000, height: 700 });
        await page.screenshot({ path: "test-results/region-controls-minimum.png" });
        await page.setViewportSize({ width: 1600, height: 1000 });
      }
      await page.getByRole("button", { name: "保存区域", exact: true }).click();
    }
    await expect(task(page, "t").locator(".port-overlay")).toHaveCount(0);
    await task(page, "t").locator(".node-title").click({ button: "right" });
    await page.getByRole("menuitem", { name: "查看发送文本" }).click();
    const shown = await page.getByRole("dialog", { name: "查看发送文本" }).locator("pre.send-text").first().textContent();
    expect(shown).toContain("图1 <bbox>0 0 999 999</bbox>");
    expect(shown).toContain("图2 <point>500 500</point>");
    expect(shown).not.toContain("Image ");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await task(page, "t").locator(".task-actions button.primary").click();
    const confirm = page.getByRole("dialog", { name: "确认运行" });
    if (await confirm.count()) await confirm.getByRole("button", { name: "确认运行", exact: true }).click();
    await expect.poll(() => bodies.length).toBe(1);
    await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
    const record = await page.evaluate((root) => {
      const path = window.__e2e.list(root).find(p => p.endsWith("/task.json"))!;
      return JSON.parse(window.__e2e.readText(path)!);
    }, OUTPUT_ROOT);
    expect(bodies[0].prompt).toBe(shown);
    expect(record.send_text).toBe(shown);
    expect(record.prompt).toBe(prompt);
    expect(record.references.map((r: any) => [r.region.render, r.region.coordinate_kind, r.region.source_port])).toEqual([["bbox_tag", "bbox", 1], ["bbox_tag", "point", 2]]);
    expect(bodies[0].image).toHaveLength(2);
    expect(record.references).toHaveLength(2);
    expect(errors).toEqual([]);
  });
}

test("Flash 两张图各带叠加区域，发送四图按原图/叠加图顺序且英文引用换算", async ({ page }) => {
  const prompt = "Copy region 2 of Image 2 into region 1 of Image 1";
  const text = board("叠加", [promptNode("p", prompt), referenceNode("a", "refs/a.png"), referenceNode("b", "refs/b.png"), taskNode("t", { model: FLASH, image_ports: 2 })], [edge("p", "t", "positive"), edge("a", "t", "image:0", { region: REGION }), edge("b", "t", "image:1", { region: REGION })]);
  await openApp(page, boardScenario("叠加", text, { files }));
  const bodies: any[] = [];
  await page.route(`${GW}/v1/images/generations`, route => { bodies.push(JSON.parse(route.request().postData()!)); return route.fulfill({ json: { data: [{ b64_json: png(1024, 1024) }] } }); });
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].image).toHaveLength(4);
  expect(bodies[0].image[0]).toBe(`data:image/png;base64,${files[`${OUTPUT_ROOT}/refs/a.png`].b64}`);
  expect(bodies[0].image[2]).toBe(`data:image/png;base64,${files[`${OUTPUT_ROOT}/refs/b.png`].b64}`);
  expect(bodies[0].prompt).toContain("图2 is an annotated copy of 图1");
  expect(bodies[0].prompt).toContain("图4 is an annotated copy of 图3");
  expect(bodies[0].prompt).toContain("the yellow region of 图3");
});

test("Flash 展开后11张参考图明确拒绝，保留全部端口", async ({ page }) => {
  const refs = Array.from({ length: 9 }, (_, i) => referenceNode(`r${i}`, "refs/a.png"));
  const text = board("超限", [promptNode("p", "图1保持不变"), ...refs, taskNode("t", { model: FLASH, image_ports: 9 })], [edge("p", "t", "positive"), ...refs.map((r, i) => edge(r.id, "t", `image:${i}`, { region: i < 2 ? REGION : null }))]);
  await openApp(page, boardScenario("超限", text, { files }));
  await task(page, "t").getByRole("button", { name: "展开" }).click();
  await expect(task(page, "t").locator(".port-overlay")).toHaveCount(2);
  await expect(task(page, "t")).toContainText("参考图 11 张超出模型上限 10 张");
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect(page.locator(".toast")).toContainText("参考图 11 张超出模型上限 10 张");
});
