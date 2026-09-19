import { describe, expect, it } from "vitest";
import type { FetchLike } from "./gateway";
import { checkForUpdate, compareVersions, detectPlatform, parseLatestRelease, parseVersion, RELEASES_PAGE_URL } from "./update";

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `http://lzxsvn:3000/qinyuanj/kacha/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  assets: [
    { name: "SHA256SUMS", browser_download_url: `http://x/${tag}/SHA256SUMS` },
    { name: `kacha-${tag.slice(1)}-win-x64.zip`, browser_download_url: `http://x/${tag}/win.zip` },
    { name: `kacha-${tag.slice(1)}-macos-arm64.zip`, browser_download_url: `http://x/${tag}/mac.zip` },
  ],
  ...extra,
});

const fetchWith = (status: number, body: string): FetchLike => async () => ({
  status,
  headers: { get: () => null },
  text: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0),
});

describe("版本号比较", () => {
  it("解析 x.y.z 与 vx.y.z", () => {
    expect(parseVersion("0.2.0")?.parts).toEqual([0, 2, 0]);
    expect(parseVersion("v1.10.3")?.parts).toEqual([1, 10, 3]);
    expect(parseVersion("1.0.0-beta.1")?.pre).toBe("beta.1");
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
  });

  it("按数值比较，不按字符串", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "v0.2.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.2.1")).toBeLessThan(0);
  });

  it("预发布版本比同号正式版旧", () => {
    expect(compareVersions("0.3.0-rc.1", "0.3.0")).toBeLessThan(0);
    expect(compareVersions("0.3.0", "0.3.0-rc.1")).toBeGreaterThan(0);
  });

  it("无法解析时抛错", () => {
    expect(() => compareVersions("abc", "0.1.0")).toThrow();
  });
});

describe("平台识别", () => {
  it("Windows / macOS / 其他", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("win-x64");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos-arm64");
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("other");
  });
});

describe("解析 Gitea 最新 Release", () => {
  it("取版本号、页面与本平台附件", () => {
    const info = parseLatestRelease(release("v0.3.0"), "macos-arm64");
    expect(info).toEqual({ version: "0.3.0", pageUrl: "http://lzxsvn:3000/qinyuanj/kacha/releases/tag/v0.3.0", downloadUrl: "http://x/v0.3.0/mac.zip" });
    expect(parseLatestRelease(release("v0.3.0"), "win-x64")?.downloadUrl).toBe("http://x/v0.3.0/win.zip");
  });

  it("本平台附件缺失或平台未知时只给页面", () => {
    const noWin = release("v0.3.0", { assets: [{ name: "kacha-0.3.0-macos-arm64.zip", browser_download_url: "http://x/mac.zip" }] });
    expect(parseLatestRelease(noWin, "win-x64")?.downloadUrl).toBeNull();
    expect(parseLatestRelease(release("v0.3.0"), "other")?.downloadUrl).toBeNull();
  });

  it("html_url 缺失时退回发布列表页", () => {
    expect(parseLatestRelease(release("v0.3.0", { html_url: undefined }), "other")?.pageUrl).toBe(RELEASES_PAGE_URL);
  });

  it("草稿、预发布、tag 不是版本号、形态不对都返回 null", () => {
    expect(parseLatestRelease(release("v0.3.0", { draft: true }), "win-x64")).toBeNull();
    expect(parseLatestRelease(release("v0.3.0", { prerelease: true }), "win-x64")).toBeNull();
    expect(parseLatestRelease(release("nightly"), "win-x64")).toBeNull();
    expect(parseLatestRelease(null, "win-x64")).toBeNull();
    expect(parseLatestRelease("v0.3.0", "win-x64")).toBeNull();
  });
});

describe("检查更新", () => {
  it("远端更新时给出下载入口", async () => {
    const r = await checkForUpdate("0.2.0", "win-x64", fetchWith(200, JSON.stringify(release("v0.2.1"))));
    expect(r.status).toBe("available");
    if (r.status === "available") expect(r.release.downloadUrl).toBe("http://x/v0.2.1/win.zip");
  });

  it("远端相同或更旧时为最新", async () => {
    expect((await checkForUpdate("0.2.0", "win-x64", fetchWith(200, JSON.stringify(release("v0.2.0"))))).status).toBe("latest");
    expect((await checkForUpdate("0.3.0", "win-x64", fetchWith(200, JSON.stringify(release("v0.2.9"))))).status).toBe("latest");
  });

  it("还没有任何 Release（404）视为最新", async () => {
    expect((await checkForUpdate("0.2.0", "win-x64", fetchWith(404, "not found"))).status).toBe("latest");
  });

  it("网络失败、非 2xx、非 JSON、当前版本不合法都归为 error", async () => {
    const failing: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await checkForUpdate("0.2.0", "win-x64", failing)).toEqual({ status: "error", message: "无法连接发布服务器：ECONNREFUSED" });
    expect((await checkForUpdate("0.2.0", "win-x64", fetchWith(500, ""))).status).toBe("error");
    expect((await checkForUpdate("0.2.0", "win-x64", fetchWith(200, "<html>"))).status).toBe("error");
    expect((await checkForUpdate("dev", "win-x64", fetchWith(200, JSON.stringify(release("v0.2.1"))))).status).toBe("error");
  });
});
