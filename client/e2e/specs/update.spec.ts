import { expect, test } from "@playwright/test";
import { board, boardScenario, openApp, promptNode, taskNode, edge } from "../app";
import { GW } from "../app";

const RELEASE_URL = "http://lzxsvn:3000/api/v1/repos/qinyuanj/kacha/releases/latest";
const descriptor = (version: string) => ({
  version,
  notes: "修复若干问题",
  pub_date: "2026-10-01T00:00:00Z",
  platforms: {
    "windows-x86_64": { url: `http://x/v${version}/kacha-win-setup.exe`, signature: "sig" },
    "darwin-aarch64": { url: `http://x/v${version}/kacha-mac.tar.gz`, signature: "sig" },
  },
});

test.describe("macOS 手动安装", () => {
  test.use({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36" });

  test("安装失败后的手动下载打开含首次安装 zip 的 Release 页面", async ({ page }) => {
    const releasePage = "http://x/releases/tag/v0.3.0";
    await page.route(RELEASE_URL, route => route.fulfill({ json: {
      tag_name: "v0.3.0", html_url: releasePage,
      assets: [
        { name: "updater-macos-arm64.json", browser_download_url: "http://x/v0.3.0/updater-macos-arm64.json" },
        { name: "kacha-0.3.0-macos-arm64.app.tar.gz", browser_download_url: "http://x/v0.3.0/kacha-mac.tar.gz" },
        { name: "kacha-0.3.0-macos-arm64.app.tar.gz.sig", browser_download_url: "http://x/v0.3.0/kacha-mac.tar.gz.sig" },
        { name: "kacha-0.3.0-macos-arm64.zip", browser_download_url: "http://x/v0.3.0/kacha-mac.zip" },
      ],
    } }));
    await openApp(page, boardScenario("更新", board("更新", [], []), {
      updaterDescriptor: descriptor("0.3.0"), fail: { "plugin:updater|install": "Access denied" },
    }));
    await expect(page.getByRole("button", { name: "重启并更新", exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "重启并更新", exact: true }).click();
    await expect(page.locator(".board-toolbar-right")).toContainText("Access denied");
    await page.getByRole("button", { name: "手动下载", exact: true }).click();
    const opened = await page.evaluate(() => window.__e2e.calls.filter(c => c.cmd === "plugin:opener|open_url").map(c => c.args));
    expect(opened).toEqual([expect.objectContaining({ url: releasePage })]);
  });
});

test("所选描述端点交给原生 updater，严格保存后才安装", async ({ page }) => {
  const text = board("更新", [promptNode("p1", "图"), taskNode("t1")], [edge("p1", "t1", "positive")]);
  const scn = boardScenario("更新", text, { updaterDescriptor: descriptor("0.3.0") });
  await page.route(RELEASE_URL, (route) =>
    route.fulfill({
      json: {
        tag_name: "v0.3.0",
        html_url: "http://x/releases/tag/v0.3.0",
        draft: false,
        prerelease: false,
        assets: [
          { name: "updater-win-x64.json", browser_download_url: "http://x/v0.3.0/updater-win-x64.json" },
          { name: "kacha-0.3.0-win-x64-setup.exe.sig", browser_download_url: "http://x/v0.3.0/kacha-win-setup.exe.sig" },
          { name: "kacha-0.3.0-win-x64-setup.exe", browser_download_url: "http://x/v0.3.0/kacha-win-setup.exe" },
        ],
      },
    }),
  );
  await openApp(page, scn);
  // 3 秒启动延迟后自动检查并下载
  await page.waitForTimeout(3500);
  await expect(page.locator(".topbar-update")).toContainText("重启并更新");
  // 打开设置，与顶栏读同一状态
  await page.locator("button", { hasText: "高级设置" }).click();
  await expect(page.locator(".modal")).toContainText("已就绪 0.3.0");
  await expect(page.locator(".modal")).toContainText("修复若干问题");
  const checks = await page.evaluate(() => window.__e2e.calls.filter(c => c.cmd === "check_update"));
  expect(checks).toHaveLength(1);
  expect(checks[0].args).toMatchObject({ endpoints: ["http://x/v0.3.0/updater-win-x64.json"], target: "windows-x86_64" });
  // 设置与顶栏共用受保护的安装流程
  await page.locator(".modal button.link", { hasText: "重启并更新" }).click();
  await expect(page.locator(".modal")).toContainText("正在安装更新");
  const installs = await page.evaluate(() => window.__e2e.calls.filter((c) => c.cmd === "plugin:updater|install"));
  expect(installs).toHaveLength(1);
});
