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

test("Issue #15 用户手动选择 Flash，设置 JPEG/水印并运行普通任务", async ({ page }) => {
  const text = board("Flash", [promptNode("p1", "一只猫"), taskNode("t1")], [edge("p1", "t1", "positive")]);
  const flash = "doubao-seedream-5-0-flash-260915";
  const errors = await openApp(page, boardScenario("Flash", text, { modelsCache: JSON.stringify({ base_url: GW, model_ids: ["qwen-image-3.0-pro", flash], fetched_at: new Date().toISOString() }) }));
  const bodies: Record<string, any>[] = [];
  await page.route(`${GW}/v1/images/generations`, (route) => {
    bodies.push(JSON.parse(route.request().postData()!));
    return route.fulfill({ json: { data: [{ b64_json: RESULT_PNG }] } });
  });
  await expand(page, "t1");
  await task(page, "t1").getByRole("combobox", { name: "模型", exact: true }).selectOption(flash);
  await task(page, "t1").getByRole("combobox", { name: "分辨率档" }).selectOption("2K");
  await task(page, "t1").getByRole("combobox", { name: "输出格式" }).selectOption("jpeg");
  await task(page, "t1").getByRole("checkbox", { name: "水印" }).check();
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({ model: flash, size: "2048x2048", output_format: "jpeg", watermark: true, response_format: "url", optimize_prompt_options: { mode: "standard" } });
  expect(Object.keys(bodies[0]).sort()).toEqual(["model", "optimize_prompt_options", "output_format", "prompt", "response_format", "size", "watermark"]);
  await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
  const record = JSON.parse((await e2eText(page, (await taskRecords(page))[0]))!);
  expect(record.output_options).toEqual({ output_format: "jpeg", response_format: "url", watermark: true });
  expect(errors).toEqual([]);
});

test.describe("Issue #1 单图默认引用与多图点击插入引导", () => {
  const openSingleImage = async (page: Page, prompt: string, files: Record<string, { b64: string }> = { [`${OUTPUT_ROOT}/${REF}`]: { b64: png(1024, 1024) } }, edges: unknown[] = [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")]) => {
    const text = board("单图", [promptNode("p1", prompt), referenceNode("r1", REF), taskNode("t1", { image_ports: 1 })], edges);
    const errors = await openApp(page, boardScenario("单图", text, { files }));
    return errors;
  };

  test("单图省略图1：提交发送确认补写与参考图，无未引用警告；用户提示词原文不变", async ({ page }) => {
    const errors = await openSingleImage(page, "把衣服改成红色");
    const bodies = await captureGeneration(page);
    await task(page, "t1").locator(".task-actions button.primary").click();
    await expect(page.getByRole("dialog", { name: "确认运行" })).toHaveCount(0);
    await expect.poll(() => bodies.length).toBe(1);
    const record = JSON.parse((await e2eText(page, (await taskRecords(page))[0]))!);
    const body = bodies[0];
    expect(record.send_text).toContain("本次提供一张参考图，编号为图1。请依据图1的视觉内容执行下方用户指令；指令中省略编号的图片指代均指图1。");
    expect(record.send_text).toContain("用户指令：\n把衣服改成红色");
    expect(record.prompt).toBe("把衣服改成红色");
    expect(body.prompt).toBe(record.send_text);
    expect(body.input.messages[0].content.filter((c: { image?: string }) => c.image)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("单图风格参考：按指定用途使用图1；显式 @图2 仍硬阻断", async ({ page }) => {
    const errors = await openSingleImage(page, "参考这张图的风格画一座城堡");
    await openMenu(page, "t1", "查看发送文本");
    const shown = (await page.getByRole("dialog", { name: "查看发送文本" }).locator("pre.send-text").first().textContent())!;
    expect(shown).toContain("用户指定参考用途时，按指定用途使用图1。用户要求修改图片时，以图1为编辑基础");
    expect(shown).toContain("用户指令：\n参考这张图的风格画一座城堡");
    await page.getByRole("button", { name: "关闭" }).click();
    expect(errors).toEqual([]);

    const out = board("越界", [promptNode("p1", "按@图2 改"), referenceNode("r1", REF), taskNode("t1", { image_ports: 1 })], [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")]);
    await openApp(page, boardScenario("越界", out, { files: { [`${OUTPUT_ROOT}/${REF}`]: { b64: png(1024, 1024) } } }));
    await task(page, "t1").locator(".task-actions button.primary").click();
    await expect(page.getByRole("dialog", { name: "确认运行" })).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText("无法运行：提示词引用了图2，但只接了 1 张参考图");
  });

  test("单图带区域：单图补写与区域说明共同生效；叠加图不产生未引用警告", async ({ page }) => {
    await openSingleImage(page, "把区域1 改成红色", { [`${OUTPUT_ROOT}/${REF}`]: { b64: png(1024, 1024) } }, [
      edge("p1", "t1", "positive"),
      edge("r1", "t1", "image:0", { region: { rects: [[0.1, 0.1, 0.5, 0.5]], render: "highlight_overlay" } }),
    ]);
    await task(page, "t1").getByRole("button", { name: "展开" }).click();
    await expect(task(page, "t1").locator(".warn-list")).toHaveCount(0);
    await expect(task(page, "t1").locator(".port-unreferenced")).toHaveCount(0);
    await openMenu(page, "t1", "查看发送文本");
    const shown = (await page.getByRole("dialog", { name: "查看发送文本" }).locator("pre.send-text").first().textContent())!;
    expect(shown).toContain("本次提供一张参考图，编号为图1。");
    expect(shown).toContain("用户指令：\n把紫色区域 改成红色");
    expect(shown).toContain("图2 是图1 的标注版，紫色半透明高亮标出的是要修改的区域");
  });

  test("提示词下方按任务分组展示缩略图，光标处点击插入；共享提示词分组说明与编辑选择保留", async ({ page }) => {
    const ref2 = "导入参考图/dog.png";
    const text = board(
      "共享",
      [promptNode("p1", "把", [0, 0]), referenceNode("r1", REF), referenceNode("r2", ref2, [0, 400]), taskNode("t1", { image_ports: 2 }, [450, 0]), taskNode("t2", { image_ports: 1 }, [450, 430])],
      [edge("p1", "t1", "positive"), edge("p1", "t2", "positive"), edge("r1", "t1", "image:0"), edge("r2", "t1", "image:1"), edge("r2", "t2", "image:0")],
    );
    const files = { [`${OUTPUT_ROOT}/${REF}`]: { b64: png(1024, 1024, { rgb: [200, 30, 30] }) }, [`${OUTPUT_ROOT}/${ref2}`]: { b64: png(1024, 1024, { rgb: [30, 30, 220] }) } };
    const errors = await openApp(page, boardScenario("共享", text, { files }));
    const prompt = page.locator('.react-flow__node[data-id="p1"]');
    await expect(prompt.getByText("此提示词供多个任务使用，图片编号按各任务的连接分别解释。")).toBeVisible();
    const groups = prompt.locator(".reference-guide-task");
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0)).toContainText("qwen-image-3.0-pro");
    await expect(groups.nth(0).getByText("点击参考图，将引用插入提示词。")).toBeVisible();
    await expect(groups.nth(0).getByRole("button", { name: /图1/ })).toBeVisible();
    await expect(groups.nth(0).getByRole("button", { name: /图2/ })).toBeVisible();
    await expect(groups.nth(1).getByRole("button", { name: /图1/ })).toBeVisible();
    await expect(prompt.locator(".reference-guide-thumb img")).toHaveCount(3);

    const textarea = prompt.locator("textarea");
    await textarea.click();
    await textarea.evaluate((el) => ((el as HTMLTextAreaElement).setSelectionRange(2, 2)));
    await groups.nth(0).getByRole("button", { name: /图2/ }).click();
    await expect(textarea).toHaveValue("把@图2");
    await expect.poll(async () => textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(4);
    await expect(groups.nth(0)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("多图未引用警告包含插入引用与描述用途的引导；叠加图不作为可点击参考图", async ({ page }) => {
    const ref2 = "导入参考图/dog.png";
    const text = board(
      "多图",
      [promptNode("p1", "把图1 调亮"), referenceNode("r1", REF), referenceNode("r2", ref2, [0, 400]), taskNode("t1", { image_ports: 2, transparent_background: true })],
      [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0"), edge("r2", "t1", "image:1", { region: { rects: [[0, 0, 0.5, 0.5]], render: "highlight_overlay" } })],
    );
    const files = { [`${OUTPUT_ROOT}/${REF}`]: { b64: png(1024, 1024) }, [`${OUTPUT_ROOT}/${ref2}`]: { b64: png(1024, 1024) } };
    await openApp(page, boardScenario("多图", text, { files }));
    await task(page, "t1").locator(".node-task").hover();
    await task(page, "t1").getByRole("button", { name: "展开" }).click();
    await expect(task(page, "t1").locator(".error-list")).toContainText("模型不支持透明背景");
    const guide = page.locator('.react-flow__node[data-id="p1"] .reference-guide-task');
    await expect(guide.getByRole("button")).toHaveCount(2);
    await expect(guide.getByRole("button", { name: /图2/ }).locator(".reference-guide-rect")).toHaveCount(1);
  });

  test("重新生成按当前单图规则重算：请求、展示与任务记录一致", async ({ page }) => {
    const errors = await openSingleImage(page, "把衣服改成红色");
    const bodies = await captureGeneration(page);
    await task(page, "t1").locator(".task-actions button.primary").click();
    await expect.poll(() => bodies.length).toBe(1);
    await openMenu(page, "t1", "重新生成");
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1].prompt).toBe(bodies[0].prompt);
    await openMenu(page, "t1", "查看发送文本");
    const shown = (await page.getByRole("dialog", { name: "查看发送文本" }).locator("pre.send-text").first().textContent())!;
    expect(shown).toBe(bodies[1].prompt);
    const records = await taskRecords(page);
    expect(records.length).toBe(2);
    const texts = await Promise.all(records.map((p) => e2eText(page, p).then((t) => JSON.parse(t!).send_text)));
    expect(new Set(texts).size).toBe(1);
    expect(errors).toEqual([]);
  });
});

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
