// 手测清单 #1–#8：任务节点相关（发送文本三方一致、模型不可用、标红 / 未就绪、黄色提示、透明背景开关、无法运行 toast、重新生成旧任务）。
import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { board, boardScenario, edge, GW, openApp, png, promptNode, referenceNode, task, taskNode } from "../app";
import { OUTPUT_ROOT } from "../scenario";

const builtin = JSON.parse(readFileSync(new URL("../../src/core/capabilities.builtin.json", import.meta.url), "utf8"));
const fixture = (name: string) => readFileSync(new URL(`../../src/core/__fixtures__/${name}`, import.meta.url), "utf8");

/** 能力表覆盖：按 model_id 整条替换内置模型。 */
function override(modelId: string, patch: (m: Record<string, any>) => void) {
  const model = structuredClone(builtin.models.find((m: { model_id: string }) => m.model_id === modelId));
  patch(model);
  return JSON.stringify({ format_version: builtin.format_version, models: [model] });
}

const RESULT_PNG = png(64, 64);

/** 截获生成请求（edits / generations），回一张 base64 结果图。 */
async function captureGeneration(page: Page) {
  const bodies: Record<string, any>[] = [];
  await page.route(`${GW}/v1/images/**`, (route: Route) => {
    bodies.push(JSON.parse(route.request().postData() ?? "{}"));
    return route.fulfill({ json: { metadata: { output: { choices: [{ message: { content: [{ image: RESULT_PNG }] } }] } } } });
  });
  return bodies;
}

const e2eList = (page: Page, prefix: string) => page.evaluate((p) => window.__e2e.list(p), prefix);
const e2eText = (page: Page, path: string) => page.evaluate((p) => window.__e2e.readText(p), path);
const taskRecords = async (page: Page) => (await e2eList(page, OUTPUT_ROOT)).filter((p) => p.endsWith("/task.json"));

async function openMenu(page: Page, nodeId: string, label: string) {
  await task(page, nodeId).locator(".node-title").click({ button: "right" });
  await page.getByRole("menuitem", { name: label }).click();
}

async function expand(page: Page, nodeId: string) {
  await task(page, nodeId).getByRole("button", { name: "展开" }).click();
}

const toolbarRun = (page: Page) => page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /运行/ });
const REF = "导入参考图/cat.png";

test("#1 带区域的图片编辑：查看发送文本、task.json 的 send_text、请求文本三者一致", async ({ page }) => {
  const text = board(
    "区域",
    [promptNode("p1", "把图1里的猫换成狗"), referenceNode("r1", REF), taskNode("t1", { image_ports: 1 })],
    [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0", { region: { rects: [[0.1, 0.1, 0.5, 0.5]], render: "highlight_overlay" } })],
  );
  const errors = await openApp(page, boardScenario("区域", text, { files: { [`${OUTPUT_ROOT}/${REF}`]: { b64: png(1024, 1024) } } }));
  const bodies = await captureGeneration(page);

  await openMenu(page, "t1", "查看发送文本");
  const dialog = page.getByRole("dialog", { name: "查看发送文本" });
  const shown = (await dialog.locator("pre.send-text").first().textContent())!;
  expect(shown).toContain("把图1里的猫换成狗");
  expect(shown).toContain("高亮");
  await dialog.getByRole("button", { name: "关闭" }).click();

  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect.poll(() => bodies.length).toBe(1);
  await expect.poll(async () => (await taskRecords(page)).length).toBe(1);
  const record = JSON.parse((await e2eText(page, (await taskRecords(page))[0]))!);
  const body = bodies[0];
  const content = body.input.messages[0].content as Record<string, string>[];

  expect(record.send_text).toBe(shown);
  expect(body.prompt).toBe(shown);
  expect(content.at(-1)!.text).toBe(shown);
  // 叠加图紧随原图：2 张参考图 + 文本。
  expect(content.filter((c) => c.image).length).toBe(2);
  expect(errors).toEqual([]);
});

test("#2 模型不在能力表内：二次确认与查看发送文本显示「模型不可用，无法生成发送文本」", async ({ page }) => {
  const text = board(
    "下架",
    [promptNode("p1", "一只猫"), taskNode("gone", { model: "retired-model" }), promptNode("p2", "一只狗", [0, 500]), taskNode("ok", {}, [400, 500])],
    [edge("p1", "gone", "positive"), edge("p2", "ok", "positive")],
  );
  await openApp(page, boardScenario("下架", text));

  await toolbarRun(page).click();
  const confirm = page.getByRole("dialog", { name: "确认运行" });
  const bad = confirm.locator("li.confirm-bad");
  await expect(bad).toHaveCount(1);
  await bad.getByRole("button", { name: "展开完整发送文本" }).click();
  await expect(bad.locator("pre.send-text")).toHaveText("模型不可用，无法生成发送文本");
  await expect(bad.locator("input[type=checkbox]")).toBeDisabled();
  await confirm.getByRole("button", { name: "取消" }).click();

  await openMenu(page, "gone", "查看发送文本");
  await expect(page.getByRole("dialog", { name: "查看发送文本" }).locator("pre.send-text")).toHaveText("模型不可用，无法生成发送文本");
});

test("#3 新建空任务不标红（未就绪）", async ({ page }) => {
  await openApp(page, boardScenario("空", board("空", [], [])));
  await page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /生成任务/ }).click();
  const node = page.locator(".node-task");
  await expect(node).toHaveCount(1);
  await expect(node).not.toHaveClass(/node-error/);
  // 新建的任务可能已展开；未展开时点开，看原因列表是「未就绪」样式而不是错误样式。
  if (await node.getByRole("button", { name: "展开" }).count()) await node.getByRole("button", { name: "展开" }).click();
  await expect(node.locator("ul.hint-list")).toBeVisible();
  await expect(node.locator("ul.error-list")).toHaveCount(0);
});

test("#4 选请求形态未接入的模型：节点标红并列出原因", async ({ page }) => {
  const text = board("形态", [promptNode("p1", "一只猫"), taskNode("t1")], [edge("p1", "t1", "positive")]);
  await openApp(page, boardScenario("形态", text, { capabilityOverride: override("qwen-image-3.0", (m) => (m.request_shape = "future_shape")) }));
  await expand(page, "t1");
  await expect(task(page, "t1").locator(".node-task")).not.toHaveClass(/node-error/);
  await task(page, "t1").getByLabel("模型", { exact: true }).selectOption("qwen-image-3.0");
  await expect(task(page, "t1").locator(".node-task")).toHaveClass(/node-error/);
  await expect(task(page, "t1").locator("ul.error-list")).toContainText("请求形态尚未接入");
});

test("#5 英文提示词 + 参考图 + 英文序号未验证：黄色提示，不标红，运行进二次确认", async ({ page }) => {
  const text = board(
    "英文",
    [promptNode("p1", "Replace the cat in image 1 with a dog"), referenceNode("r1", REF), taskNode("t1", { image_ports: 1 })],
    [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")],
  );
  await openApp(
    page,
    boardScenario("英文", text, {
      files: { [`${OUTPUT_ROOT}/${REF}`]: { b64: png(1024, 1024) } },
      capabilityOverride: override("qwen-image-3.0-pro", (m) => (m.reference_phrasing.en_verified = "untested")),
    }),
  );
  await expand(page, "t1");
  const node = task(page, "t1");
  await expect(node.locator("ul.warn-list")).toContainText("该模型英文序号未验证");
  await expect(node.locator(".node-task")).not.toHaveClass(/node-error/);
  await node.locator(".task-actions button.primary").click();
  const confirm = page.getByRole("dialog", { name: "确认运行" });
  await expect(confirm.locator("ul.warn-list")).toContainText("该模型英文序号未验证");
  await expect(confirm.getByRole("button", { name: "运行 1 个任务" })).toBeEnabled();
});

test.describe("#6 透明背景开关", () => {
  const SEEDREAM = "doubao-seedream-5-0-pro-260628";
  const OPAQUE = "导入参考图/opaque.png";
  const ALPHA = "导入参考图/alpha.png";
  const files = { [`${OUTPUT_ROOT}/${OPAQUE}`]: { b64: png(1024, 1024) }, [`${OUTPUT_ROOT}/${ALPHA}`]: { b64: png(1024, 1024, { alpha: true }) } };

  async function open(page: Page, refs: string[], over: Record<string, unknown> = {}) {
    const nodes = [promptNode("p1", "一只猫"), ...refs.map((r, i) => referenceNode(`r${i}`, r, [0, 200 + i * 220])), taskNode("t1", { model: SEEDREAM, image_ports: refs.length, ...over })];
    const edges = [edge("p1", "t1", "positive"), ...refs.map((_, i) => edge(`r${i}`, "t1", `image:${i}`))];
    await openApp(page, boardScenario("透明", board("透明", nodes, edges), { files }));
    await expand(page, "t1");
    const label = task(page, "t1").locator(".toggles label", { hasText: "透明背景" });
    return { label, box: label.locator("input[type=checkbox]"), node: task(page, "t1").locator(".node-task") };
  }

  test("0 条图片线：置灰并提示", async ({ page }) => {
    const { label, box } = await open(page, []);
    await expect(box).toBeDisabled();
    await expect(label).toHaveClass(/disabled/);
    await expect(label).toContainText("需要恰好一条图片线");
  });

  test("2 条图片线：置灰并提示", async ({ page }) => {
    const { label, box } = await open(page, [ALPHA, ALPHA]);
    await expect(box).toBeDisabled();
    await expect(label).toContainText("需要恰好一条图片线");
  });

  test("源图无透明通道：置灰并提示", async ({ page }) => {
    const { label, box } = await open(page, [OPAQUE]);
    await expect(label).toContainText("该图不带透明通道");
    await expect(box).toBeDisabled();
  });

  test("源图有透明通道：可打开，不标红", async ({ page }) => {
    const { label, box, node } = await open(page, [ALPHA]);
    await expect(box).toBeEnabled();
    await expect(label).not.toHaveClass(/disabled/);
    await box.check();
    await expect(box).toBeChecked();
    await expect(node).not.toHaveClass(/node-error/);
  });

  test("打开后条件变坏：保留打开、仍可关、标红列原因", async ({ page }) => {
    const { box, node } = await open(page, [OPAQUE], { transparent_background: true });
    await expect(box).toBeChecked();
    await expect(box).toBeEnabled();
    await expect(node).toHaveClass(/node-error/);
    await expect(node.locator("ul.error-list")).toContainText("该图不带透明通道");
  });
});

test("#7 单个标红任务点运行：toast「无法运行：…」", async ({ page }) => {
  const text = board("标红", [promptNode("p1", "一只猫"), taskNode("t1", { model: "retired-model" })], [edge("p1", "t1", "positive")]);
  await openApp(page, boardScenario("标红", text));
  await toolbarRun(page).click();
  await expect(page.locator(".toast")).toHaveText("无法运行：模型 retired-model 不在能力表内");
});

test.describe("#8 旧任务「重新生成」", () => {
  for (const name of ["pre-113.task.json", "pre-116.task.json"]) {
    test(name, async ({ page }) => {
      const old = JSON.parse(fixture(name));
      const dir = `${OUTPUT_ROOT}/2026-09-16/${old.task_id}`;
      const snapshot = png(1024, 1024);
      const files = Object.fromEntries([[`${dir}/task.json`, { text: fixture(name) }], ...old.references.map((r: { file: string }) => [`${dir}/${r.file}`, { b64: snapshot }])]);
      const text = board(
        "重生成",
        [promptNode("p1", old.prompt), taskNode("t1", { image_ports: 2, last_submitted: { task_id: old.task_id } })],
        [edge("p1", "t1", "positive")],
      );
      const errors = await openApp(page, boardScenario("重生成", text, { files }));
      const bodies = await captureGeneration(page);

      await openMenu(page, "t1", "重新生成");
      await expect.poll(() => bodies.length).toBe(1);
      await expect.poll(async () => (await taskRecords(page)).length).toBe(2);
      const fresh = (await taskRecords(page)).find((p) => !p.includes(old.task_id))!;
      const record = JSON.parse((await e2eText(page, fresh))!);
      const body = bodies[0];
      expect(body.prompt).toBe(record.send_text);
      expect(body.input.messages[0].content.at(-1).text).toBe(record.send_text);
      // 快照原样重发：3 张（含叠加图）。
      expect(body.input.messages[0].content.filter((c: { image?: string }) => c.image).length).toBe(3);
      expect(record.prompt).toBe(old.prompt);
      // pre-116 已是新口径：按当前规则重算应与旧 send_text 相同。
      if (name === "pre-116.task.json") expect(record.send_text).toBe(old.send_text);
      await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
      expect(errors).toEqual([]);
    });
  }
});
