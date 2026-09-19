// 手测清单 #17–#26 中与任务状态、设置、重新定位相关的验收（见 docs/research/playwright-e2e-feasibility.md 第 5 节）。
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { board, boardPath, boardScenario, edge, GW, openApp, png, promptNode, referenceNode, task, taskNode } from "../app";
import { OUTPUT_ROOT } from "../scenario";
import type { E2eControl } from "../harness";

const e2e = <T>(page: Page, fn: (c: E2eControl) => T) => page.evaluate(`(${fn.toString()})(window.__e2e)`) as Promise<T>;
const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => window.__e2e.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd) as Promise<Record<string, unknown>[]>;
const sha256 = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
const toast = (page: Page) => page.locator(".toast");

test.describe("#17 / #18 运行前判定", () => {
  test("#17 参考图文件缺失：节点标红，运行提示「无法运行：…图片缺失」", async ({ page }) => {
    const text = board(
      "缺图",
      [promptNode("p1", "把图1变成水彩"), referenceNode("r1", "导入参考图/不存在.png"), taskNode("t1", { image_ports: 1 })],
      [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")],
    );
    await openApp(page, boardScenario("缺图", text));
    await expect(task(page, "r1")).toContainText("图片缺失");
    await expect(task(page, "t1").locator(".node-task")).toHaveClass(/node-error/);
    await task(page, "t1").locator(".task-actions button.primary").click();
    await expect(toast(page)).toContainText("无法运行：图1 图片缺失");
    expect(await calls(page, "write_new_file")).toEqual([]);
  });

  test("#18 透明背景 + 源图不带透明通道：节点标红，运行被拦", async ({ page }) => {
    const opaque = png(64, 64);
    const text = board(
      "透明",
      [
        promptNode("p1", "抠出主体"),
        referenceNode("r1", "导入参考图/opaque.png"),
        taskNode("t1", { model: "doubao-seedream-5-0-pro-260628", image_ports: 1, transparent_background: true }),
      ],
      [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")],
    );
    await openApp(page, boardScenario("透明", text, { files: { [`${OUTPUT_ROOT}/导入参考图/opaque.png`]: { b64: opaque } } }));
    await expect(task(page, "t1").locator(".node-task")).toHaveClass(/node-error/);
    await task(page, "t1").locator(".task-actions button.primary").click();
    await expect(toast(page)).toContainText("无法运行：");
    await expect(toast(page)).toContainText("透明通道");
    expect(await calls(page, "write_new_file")).toEqual([]);
  });

  test("#18 对照：源图带透明通道时不因透明通道被拦", async ({ page }) => {
    const alpha = png(64, 64, { alpha: true });
    const text = board(
      "透明ok",
      [
        promptNode("p1", "抠出主体"),
        referenceNode("r1", "导入参考图/alpha.png"),
        taskNode("t1", { model: "doubao-seedream-5-0-pro-260628", image_ports: 1, transparent_background: true }),
      ],
      [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")],
    );
    await openApp(page, boardScenario("透明ok", text, { files: { [`${OUTPUT_ROOT}/导入参考图/alpha.png`]: { b64: alpha } } }));
    await expect(task(page, "r1").locator("img.thumb")).toBeVisible();
    await expect(task(page, "t1").locator(".node-task")).not.toHaveClass(/node-error/);
    await expect(task(page, "t1")).not.toContainText("透明通道");
  });
});

test.describe("#19 / #20 重开画板后的已存状态", () => {
  const ids = { failed: "20260915T010101Z-aaaa0001", cancelled: "20260915T010102Z-aaaa0002", interrupted: "20260915T010103Z-aaaa0003" };
  const outcome = (id: string, record: object) => ({ [`${OUTPUT_ROOT}/2026-09-15/${id}/outcome.json`]: { text: JSON.stringify(record) } });
  const title = "已存状态";
  const text = board(
    title,
    [
      taskNode("tf", { last_submitted: { task_id: ids.failed } }, [0, 0]),
      taskNode("tc", { last_submitted: { task_id: ids.cancelled } }, [400, 0]),
      taskNode("ti", { last_submitted: { task_id: ids.interrupted } }, [800, 0]),
    ],
    [],
  );
  const scn = () =>
    boardScenario(title, text, {
      files: { ...outcome(ids.failed, { outcome: "failed", label: "鉴权失败" }), ...outcome(ids.cancelled, { outcome: "cancelled", gateway_may_continue: false }) },
    });
  const interruptedLogs = (page: Page) =>
    e2e(page, (c) => c.logs.filter((l) => l.kind === "task" && (l.fields as { to_status?: string }).to_status === "interrupted").map((l) => l.fields));

  const expectBadges = async (page: Page) => {
    await expect(task(page, "tf").locator(".status-failed")).toHaveText("失败 · 鉴权失败");
    await expect(task(page, "tc").locator(".status")).toHaveText("已取消");
    await expect(task(page, "ti").locator(".status")).toHaveText("已中断");
  };
  const reopen = async (page: Page) => {
    await page.locator(".tab", { hasText: title }).locator(".tab-close").click();
    await expect(page.locator(".tab", { hasText: title })).toHaveCount(0);
    await page.evaluate((p) => window.__e2e.emit("second-instance", [p]), boardPath(title));
    await expect(page.locator(".tab", { hasText: title })).toHaveCount(1);
  };

  test("#19 启动与关掉再打开后都显示 失败 / 已取消 / 已中断", async ({ page }) => {
    await openApp(page, scn());
    await expectBadges(page);
    await reopen(page);
    await expectBadges(page);
  });

  test("#20 已中断的日志只记一次（反复关开画板）", async ({ page }) => {
    await openApp(page, scn());
    await expectBadges(page);
    for (let i = 0; i < 3; i++) {
      await reopen(page);
      await expectBadges(page);
    }
    const logs = await interruptedLogs(page);
    expect(logs).toEqual([{ task_id: ids.interrupted, board_file: expect.any(String), task_node_id: "ti", from_status: "running", to_status: "interrupted" }]);
  });
});

test.describe("#21–#24 高级设置", () => {
  const title = "设置";
  const openSettings = async (page: Page) => {
    await page.getByRole("button", { name: "⚙ 高级设置" }).click();
    const dialog = page.getByRole("dialog", { name: "高级设置" });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  const keyInput = (dialog: ReturnType<Page["getByRole"]>) => dialog.locator("label.form-row", { hasText: "API 密钥" }).locator("input");

  test("#21 保存密钥：UI 调用 secret_set（真 Keychain 仍需手测）", async ({ page }) => {
    await openApp(page, boardScenario(title, board(title, [], []), { secret: null }));
    const dialog = await openSettings(page);
    await keyInput(dialog).fill("sk-new-key");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await calls(page, "secret_set")).toEqual([{ key: "sk-new-key" }]);
    const reopened = await openSettings(page);
    await expect(reopened.locator(".notice", { hasText: "系统凭据库不可用" })).toHaveCount(0);
  });

  test("#22 测试连接：成功显示模型数，失败显示错误并回落缓存", async ({ page }) => {
    await openApp(page, boardScenario(title, board(title, [], [])));
    const dialog = await openSettings(page);
    const testButton = dialog.getByRole("button", { name: "测试连接并刷新模型" });
    await testButton.click();
    await expect(dialog.locator(".ok-text")).toHaveText("连接成功，网关提供 4 个模型");
    await expect(dialog).toContainText("模型列表：已从网关获取");

    await page.route(`${GW}/v1/models`, (route) => route.fulfill({ status: 401, json: { error: { message: "invalid key" } } }));
    await testButton.click();
    const error = dialog.locator(".form-row", { hasText: "连接测试" }).locator(".form-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("401");
    await expect(dialog).toContainText("模型列表：离线，使用缓存");
  });

  test("#23 settings.json 由更新版本写入：提示、只存密钥、不覆盖文件", async ({ page }) => {
    const newer = JSON.stringify({ format_version: 99, base_url: GW, future_field: true });
    // 更新版本的文件按默认设置运行，默认网关地址不可达：一律 404。
    await page.route("http://lzxsvn:3001/**", (route) => route.fulfill({ status: 404, body: "" }));
    await openApp(page, boardScenario(title, board(title, [], []), { settings: newer }));
    const dialog = await openSettings(page);
    await expect(dialog.locator(".notice", { hasText: "更新版本" })).toContainText("由更新版本的工具写入（format_version 99）");
    await keyInput(dialog).fill("sk-only-key");
    await dialog.getByRole("button", { name: "仅保存密钥" }).click();
    await expect(dialog).toBeHidden();
    expect(await calls(page, "secret_set")).toEqual([{ key: "sk-only-key" }]);
    expect(await calls(page, "write_settings")).toEqual([]);
    expect(await e2e(page, (c) => c.readText("/e2e/appdata/settings.json"))).toBe(newer);
  });

  test("#24 凭据库不可用：保存后显示「密钥未持久化」提示", async ({ page }) => {
    await openApp(page, boardScenario(title, board(title, [], []), { secret: null, secretBroken: { set: true } }));
    const dialog = await openSettings(page);
    await keyInput(dialog).fill("sk-session");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toBeHidden();
    const reopened = await openSettings(page);
    await expect(reopened.locator(".notice", { hasText: "系统凭据库不可用" })).toHaveText("系统凭据库不可用：密钥未持久化，重启需重填。");
    await expect(keyInput(reopened)).toHaveValue("sk-session");
  });
});

test.describe("#25 / #26 重新定位参考图", () => {
  const image = png(48, 48, { rgb: [200, 60, 60] });
  const title = "重定位";
  const scn = (extraFiles: Record<string, { b64: string }>) => {
    const ref = { ...referenceNode("r1", "导入参考图/原图.png"), sha256: sha256(image) };
    return boardScenario(title, board(title, [ref], []), { files: extraFiles });
  };
  const savedRefPath = (page: Page) =>
    e2e(page, (c) => {
      const text = c.readText("/e2e/out/画板/重定位.ugcboard.json");
      return text ? (JSON.parse(text).nodes.find((n: { id: string }) => n.id === "r1")?.path as string) : null;
    });

  test("#25 自动查找：按 sha256 在输出根目录内找回并恢复显示", async ({ page }) => {
    await openApp(page, scn({ [`${OUTPUT_ROOT}/2026-09-10/20260910T000000Z-bbbb0001/reference-1.png`]: { b64: image } }));
    const node = task(page, "r1");
    await expect(node).toContainText("图片缺失");
    await node.getByRole("button", { name: "重新定位" }).click();
    await expect(node.locator("img.thumb")).toBeVisible();
    await expect(node).not.toContainText("图片缺失");
    await expect.poll(() => savedRefPath(page)).toBe("2026-09-10/20260910T000000Z-bbbb0001/reference-1.png");
  });

  test("#25 自动查找找不到：提示改为手动选择", async ({ page }) => {
    await openApp(page, scn({}));
    const node = task(page, "r1");
    await node.getByRole("button", { name: "重新定位" }).click();
    await expect(toast(page)).toContainText("在输出根目录内没有找到 原图.png，可改为手动选择文件");
  });

  test("#26 手动选择：对话框返回的路径写回节点", async ({ page }) => {
    const picked = "/e2e/elsewhere/手选.png";
    await openApp(page, scn({ [picked]: { b64: image } }));
    await page.evaluate((p) => window.__e2e.dialogAnswers.open.push(p), picked);
    const node = task(page, "r1");
    await expect(node).toContainText("图片缺失");
    await node.getByRole("button", { name: "选文件…" }).click();
    await expect(node.locator("img.thumb")).toBeVisible();
    await expect.poll(() => savedRefPath(page)).toBe(picked);
  });
});
