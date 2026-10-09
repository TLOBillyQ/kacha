// Issue #13：任务与保存保护下的用户主动更新重启（ADR 0016）。
// 在统一流程边界观察：假壳的内存文件 + 命令调用表即持久化结果；更新入口只经注入的安装适配器前进。
import { expect, test, type Page } from "@playwright/test";
import { board, boardScenario, edge, GW, openApp, png, promptNode, referenceNode, task, taskNode } from "../app";
import { OUTPUT_ROOT } from "../scenario";

const calls = (page: Page, cmd: string) => page.evaluate((c) => window.__e2e.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd) as Promise<Record<string, unknown>[]>;

/** 把最新 Release 指到假更新：版本号更高，带本平台描述。 */
async function withUpdate(page: Page, version = "9.9.9") {
  await page.route("**/api/v1/repos/qinyuanj/kacha/releases/latest", (route) =>
    route.fulfill({
      json: {
        tag_name: `v${version}`,
        html_url: `http://releases/v${version}`,
        draft: false,
        prerelease: false,
        assets: [
          { name: "updater-win-x64.json", browser_download_url: `http://x/${version}/updater-win-x64.json` },
          { name: `kacha-${version}-win-x64-setup.exe`, browser_download_url: `http://x/${version}/setup.exe` },
          { name: `kacha-${version}-win-x64-setup.exe.sig`, browser_download_url: `http://x/${version}/setup.exe.sig` },
        ],
      },
    }),
  );
}

const title = "更新保护";
const REF = "导入参考图/cat.png";
const scene = (partial: Parameters<typeof boardScenario>[2] = {}) =>
  boardScenario(
    title,
    board(title, [promptNode("p1", "把图1变成水彩"), referenceNode("r1", REF), taskNode("t1", { image_ports: 1 })], [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")]),
    { ...partial, files: { [`${OUTPUT_ROOT}/${REF}`]: { b64: png(64, 64) }, ...partial.files },
      updaterDescriptor: { version: "9.9.9", notes: "更新说明", pub_date: "2026-10-01T00:00:00Z",
        platforms: { "windows-x86_64": { url: "http://x/9.9.9/setup.exe", signature: "sig" } } },
    },
  );

/** 点击顶栏「重启并更新」。 */
async function clickUpdate(page: Page) {
  await page.getByRole("button", { name: "重启并更新", exact: true }).click();
}

/** 轮询假壳里某画板文件的标题。 */
async function boardTitleOnDisk(page: Page, file: string) {
  const text = await page.evaluate((p) => window.__e2e.readText(p), `${OUTPUT_ROOT}/画板/${file}.ugcboard.json`);
  return text ? (JSON.parse(text) as { title: string }).title : null;
}

test.describe("#13 任务队列阻止更新", () => {
  test("排队 / 执行中的任务阻止更新：提示「任务结束后可更新」，不保存、不安装、不取消任务", async ({ page }) => {
    await openApp(page, scene());
    await withUpdate(page);
    // 让网关挂起：任务一直执行中。
    await page.route(`${GW}/v1/images/**`, () => new Promise(() => undefined));
    await task(page, "t1").locator(".task-actions button.primary").click();
    await expect.poll(() => calls(page, "write_new_file").then((c) => c.length > 0)).toBe(true);

    await expect(page.locator(".topbar-update")).toBeVisible({ timeout: 10_000 });
    await clickUpdate(page);

    await expect(page.locator(".board-toolbar-right")).toContainText("任务结束后可更新");
    expect(await calls(page, "plugin:updater|install")).toEqual([]);
    await expect(task(page, "t1").locator(".status")).toContainText(/执行中|排队/);
  });

  test("任务结束后仍需用户再次点击：不自动重启", async ({ page }) => {
    await openApp(page, scene());
    await withUpdate(page);
    let finishTask!: () => Promise<void>;
    await page.route(`${GW}/v1/images/**`, route => { finishTask = () => route.fulfill({ status: 400, json: { error: { message: "failed" } } }); });
    await task(page, "t1").locator(".task-actions button.primary").click();
    await expect.poll(() => calls(page, "write_new_file").then(c => c.length > 0)).toBe(true);
    await expect(page.locator(".topbar-update")).toBeVisible({ timeout: 10_000 });
    await clickUpdate(page);
    await expect(page.locator(".board-toolbar-right")).toContainText("任务结束后可更新");
    await finishTask();
    await expect(task(page, "t1").locator(".status")).toContainText("失败");
    expect(await calls(page, "plugin:updater|install")).toEqual([]);
    await clickUpdate(page);
    await expect.poll(() => calls(page, "plugin:updater|install").then(c => c.length)).toBe(1);
  });
});

test.describe("#13 严格保存边界", () => {
  test("关闭画板的在途写入失败时，更新保留画板并阻止安装，修复后可重试", async ({ page }) => {
    await openApp(page, scene());
    await withUpdate(page);
    await expect(page.getByRole("button", { name: "重启并更新", exact: true })).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => {
      window.__e2e.pause("write_board");
      window.__e2e.fail.write_board = "磁盘已满";
    });
    await page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /提示词/ }).click();
    await page.locator(".tab-close").click();
    await expect.poll(() => page.evaluate(() => window.__e2e.held())).toContain("write_board");
    await clickUpdate(page);
    await expect(page.locator(".topbar-update")).toContainText("正在准备更新");
    expect(await calls(page, "plugin:updater|install")).toEqual([]);

    await page.evaluate(() => window.__e2e.release("write_board"));
    await expect(page.locator(".board-toolbar-right")).toContainText("磁盘已满");
    expect(await calls(page, "plugin:updater|install")).toEqual([]);
    expect(await calls(page, "plugin:process|restart")).toEqual([]);
    await expect(page.locator(".tab", { hasText: title })).toHaveCount(1);
    await expect(page.locator(".react-flow__node")).toHaveCount(4);

    await page.evaluate(() => delete window.__e2e.fail.write_board);
    await page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /提示词/ }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(5);
    await clickUpdate(page);
    await expect(page.locator(".topbar-update")).toContainText("正在安装更新");
    const saved = await page.evaluate((path) => JSON.parse(window.__e2e.readText(path)!), `${OUTPUT_ROOT}/画板/${title}.ugcboard.json`);
    expect(saved.nodes).toHaveLength(5);
    const ui = await page.evaluate(() => JSON.parse(window.__e2e.readText("/e2e/appdata/ui_state.json")!));
    expect(ui.open_boards).toContain(`${OUTPUT_ROOT}/画板/${title}.ugcboard.json`);
  });

  test("关闭画板的在途写入成功时，更新等待落盘后继续安装", async ({ page }) => {
    await openApp(page, scene());
    await withUpdate(page);
    await expect(page.getByRole("button", { name: "重启并更新", exact: true })).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => window.__e2e.pause("write_board"));
    await page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /提示词/ }).click();
    await page.locator(".tab-close").click();
    await expect.poll(() => page.evaluate(() => window.__e2e.held())).toContain("write_board");
    await clickUpdate(page);
    await expect(page.locator(".topbar-update")).toContainText("正在准备更新");
    expect(await calls(page, "plugin:updater|install")).toEqual([]);
    await page.evaluate(() => window.__e2e.release("write_board"));
    await expect(page.locator(".topbar-update")).toContainText("正在安装更新");
    const saved = await page.evaluate((path) => JSON.parse(window.__e2e.readText(path)!), `${OUTPUT_ROOT}/画板/${title}.ugcboard.json`);
    expect(saved.nodes).toHaveLength(4);
    expect(await calls(page, "plugin:updater|install")).toHaveLength(1);
  });

  test("未准备更新时，关闭画板仍允许保存失败后关闭", async ({ page }) => {
    await openApp(page, scene());
    await page.evaluate(() => { window.__e2e.fail.write_board = "磁盘已满"; });
    await page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /提示词/ }).click();
    await page.locator(".tab-close").click();
    await expect(page.locator(".tab")).toHaveCount(0);
    await expect.poll(() => calls(page, "write_board").then(c => c.length > 0)).toBe(true);
    expect(await calls(page, "plugin:updater|install")).toEqual([]);
  });

  test("此前保存失败的画板在更新准备时重试；仍失败则不安装并报告真实原因", async ({ page }) => {
    await openApp(page, scene());
    await page.evaluate(() => (window.__e2e.fail.write_board = "磁盘已满"));
    // 改名触发 rename + flush：rename 成功但标题写入失败 → 失败条出现。
    await page.locator(".tab", { hasText: title }).dblclick();
    await page.locator(".tab input").fill("失败重试2");
    await page.locator(".tab input").press("Enter");
    await expect(page.locator(".tab", { hasText: "失败重试2" })).toHaveCount(1);
    await expect(page.locator(".bar-error")).toContainText("未能保存到", { timeout: 10_000 });

    await withUpdate(page);
    await expect(page.locator(".topbar-update")).toBeVisible({ timeout: 10_000 });
    await clickUpdate(page);

    await expect(page.locator(".board-toolbar-right")).toContainText("保存画板失败：未能保存到");
    await expect(page.locator(".board-toolbar-right")).toContainText("磁盘已满");
    expect(await calls(page, "plugin:updater|install")).toEqual([]);
    // 失败后画板仍可编辑（保护已解除）：改名输入框能正常出现并提交。
    await page.locator(".tab", { hasText: "失败重试2" }).dblclick();
    await expect(page.locator(".tab input")).toBeVisible();
    await page.keyboard.press("Escape");
    // 修复后重试成功（真实原因解除，用户可再次更新）：轮询到磁盘上的新标题。
    await page.evaluate(() => delete window.__e2e.fail.write_board);
    await clickUpdate(page);
    await expect.poll(() => boardTitleOnDisk(page, "失败重试2"), { timeout: 10_000 }).toBe("失败重试2");
  });

  test("界面状态写入失败同样阻止安装", async ({ page }) => {
    const scn = scene();
    scn.fail = { write_ui_state: "只读文件系统" };
    await openApp(page, scn);
    await withUpdate(page);
    await expect(page.locator(".topbar-update")).toBeVisible({ timeout: 10_000 });
    await clickUpdate(page);
    await expect(page.locator(".board-toolbar-right")).toContainText("保存界面状态失败：只读文件系统");
    expect(await calls(page, "plugin:updater|install")).toEqual([]);
  });

  test("未到期的保存计时器在准备时立即落盘：双击改名后立刻点更新，新标题已写入", async ({ page }) => {
    await openApp(page, scene());
    await withUpdate(page);
    await expect(page.locator(".topbar-update")).toBeVisible({ timeout: 10_000 });
    // 改名会排程去抖保存；在去抖窗口内直接点更新。
    await page.locator(".tab", { hasText: title }).dblclick();
    await page.locator(".tab input").fill("改名后");
    await page.locator(".tab input").press("Enter");
    await clickUpdate(page);
    await expect(page.locator(".topbar-update")).toContainText("正在安装更新");
    expect(await boardTitleOnDisk(page, "改名后")).toBe("改名后");
  });
});

test.describe("#13 准备期间的保护", () => {
  test("准备失败恢复之后，之前已开始的参考图导入不能重新带入未保存内容", async ({ page }) => {
    const image = `${OUTPUT_ROOT}/导入参考图/late.png`;
    await openApp(page, scene({ files: { [image]: { b64: png(32, 32) } } }));
    await withUpdate(page);
    await expect(page.locator(".topbar-update")).toBeVisible({ timeout: 10_000 });
    await page.evaluate((p) => {
      window.__e2e.pause("inspect_image");
      window.__e2e.dialogAnswers.open.push([p]);
      window.__e2e.fail.write_ui_state = "磁盘已满";
    }, image);
    await page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /参考图/ }).click();
    await expect.poll(() => page.evaluate(() => window.__e2e.held())).toContain("inspect_image");
    await clickUpdate(page);
    await expect(page.locator(".board-toolbar-right")).toContainText("保存界面状态失败");
    await page.evaluate(async () => {
      await window.__e2e.release("inspect_image");
      await new Promise(requestAnimationFrame);
    });
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /提示词/ }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
  });

  test("普通关窗仍按既有约定吞掉保存错误并关闭", async ({ page }) => {
    await openApp(page, scene());
    await page.evaluate(() => { window.__e2e.fail.write_board = "磁盘已满"; });
    await page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /提示词/ }).click();
    await page.evaluate(() => window.__e2e.emit("tauri://close-requested", null));
    await expect.poll(() => calls(page, "plugin:window|destroy").then((x) => x.length)).toBe(1);
  });
  test("等待窗口尺寸异步查询并立即保存最新尺寸，准备期间关闭窗口被阻止", async ({ page }) => {
    await openApp(page, scene());
    await withUpdate(page);
    await expect(page.locator(".topbar-update")).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => {
      window.__e2e.pause("plugin:window|scale_factor");
      window.__e2e.emit("tauri://resize", { width: 1234, height: 789 });
    });
    await expect.poll(() => page.evaluate(() => window.__e2e.held())).toContain("plugin:window|scale_factor");
    await clickUpdate(page);
    await expect(page.getByRole("button", { name: "正在准备更新…" })).toBeVisible();
    await page.evaluate(() => window.__e2e.emit("tauri://close-requested", null));
    await page.evaluate(() => window.__e2e.release("plugin:window|scale_factor"));
    await expect(page.locator(".topbar-update")).toContainText("正在安装更新");
    const ui = await page.evaluate(() => JSON.parse(window.__e2e.readText("/e2e/appdata/ui_state.json")!));
    expect(ui.window).toEqual({ width: 1234, height: 789 });
    expect(await calls(page, "plugin:window|destroy")).toEqual([]);
  });

  test("慢写入期间忽略新建、改名、编辑和第二实例打开，严格写入结束后才能前进", async ({ page }) => {
    const extraPath = `${OUTPUT_ROOT}/画板/第二块.ugcboard.json`;
    await openApp(page, scene({ files: { [extraPath]: { text: board("第二块", [], []) } } }));
    await withUpdate(page);
    await expect(page.locator(".topbar-update")).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => window.__e2e.pause("write_board"));
    await clickUpdate(page);
    await expect.poll(() => page.evaluate(() => window.__e2e.held())).toContain("write_board");
    await page.locator(".tab-new").click();
    await page.locator(".tab").dblclick();
    await page.locator(".tab input").fill("不应保存");
    await page.locator(".tab input").press("Enter");
    await page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /提示词/ }).click();
    await page.evaluate((p) => window.__e2e.emit("second-instance", [p]), extraPath);
    expect(await calls(page, "plugin:updater|install")).toEqual([]);
    await page.evaluate(() => window.__e2e.release("write_board"));
    await expect(page.locator(".topbar-update")).toContainText("正在安装更新");
    expect(await boardTitleOnDisk(page, title)).toBe(title);
    await expect(page.locator(".tab")).toHaveCount(1);
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
  });
  test("第二实例已开始打开画板时，等待打开完成并严格保存新增标签页", async ({ page }) => {
    const extraPath = `${OUTPUT_ROOT}/画板/第二块.ugcboard.json`;
    await openApp(page, scene({ files: { [extraPath]: { text: board("第二块", [], []) } } }));
    await withUpdate(page);
    await expect(page.locator(".topbar-update")).toBeVisible({ timeout: 10_000 });
    await page.evaluate((p) => {
      window.__e2e.pause("read_board");
      window.__e2e.emit("second-instance", [p]);
    }, extraPath);
    await expect.poll(() => page.evaluate(() => window.__e2e.held())).toContain("read_board");
    await clickUpdate(page);
    await expect(page.getByRole("button", { name: "正在准备更新…" })).toBeVisible();
    await page.evaluate(() => window.__e2e.release("read_board"));
    await expect(page.locator(".topbar-update")).toContainText("正在安装更新");
    const ui = await page.evaluate(() => JSON.parse(window.__e2e.readText("/e2e/appdata/ui_state.json")!));
    expect(ui.open_boards).toContain(extraPath);
  });
  test("安装失败后恢复画板编辑与任务提交，保留就绪状态与手动下载", async ({ page }) => {
    await openApp(page, scene({ fail: { "plugin:updater|install": "Access denied" } }));
    await withUpdate(page);
    await expect(page.locator(".topbar-update")).toBeVisible({ timeout: 10_000 });
    await clickUpdate(page);
    await expect(page.locator(".board-toolbar-right")).toContainText("Access denied");
    await expect(page.locator(".board-toolbar-right").getByRole("button", { name: "手动下载" })).toBeVisible();
    await expect(page.getByRole("button", { name: "重启并更新", exact: true })).toBeEnabled();
    await page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /提示词/ }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await task(page, "t1").locator(".task-actions button.primary").click();
    await expect.poll(() => calls(page, "write_new_file").then(c => c.length > 0)).toBe(true);
  });

  test("重复点击不产生重复安装，安装阶段保持关闭与编辑保护", async ({ page }) => {
    await openApp(page, scene());
    await withUpdate(page);
    await expect(page.locator(".topbar-update")).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => window.__e2e.pause("plugin:updater|install"));
    await clickUpdate(page);
    await expect.poll(() => page.evaluate(() => window.__e2e.held())).toContain("plugin:updater|install");
    await page.locator(".topbar-update").evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
    await page.evaluate(() => window.__e2e.emit("tauri://close-requested", null));
    await page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /提示词/ }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    expect(await calls(page, "plugin:window|destroy")).toEqual([]);
    await page.evaluate(() => window.__e2e.release("plugin:updater|install"));
    await expect(page.locator(".topbar-update")).toContainText("正在安装更新");
    expect(await calls(page, "plugin:updater|install")).toHaveLength(1);
  });
});
