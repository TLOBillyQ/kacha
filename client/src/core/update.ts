// 检查更新：向 Gitea 询问最新 Release，比当前版本新时给出下载入口。
// 只提示、不下载、不替换文件；分发渠道与附件命名见 ADR 0007。
// HTTP 由调用方注入（壳里是 tauri-plugin-http 的 fetch，测试里是夹具）。

import type { FetchLike } from "./gateway";

export const RELEASES_PAGE_URL = "http://lzxsvn:3000/qinyuanj/kacha/releases";
export const LATEST_RELEASE_API_URL = "http://lzxsvn:3000/api/v1/repos/qinyuanj/kacha/releases/latest";

export type Platform = "win-x64" | "macos-arm64" | "other";

export interface ReleaseInfo {
  /** 去掉 tag 前缀 v 后的版本号。 */
  version: string;
  /** Release 页面；没有对应平台附件时打开这里。 */
  pageUrl: string;
  /** 对应平台的压缩包直链；附件缺失时为 null。 */
  downloadUrl: string | null;
}

export type UpdateCheck =
  | { status: "available"; release: ReleaseInfo }
  | { status: "latest" }
  | { status: "error"; message: string };

// ---- updater 描述协议（#12）：静态 JSON 端点，见 ADR-0016 / issue #3 ----

/** 官方 updater 的目标名：与 Rust updater 的 target 常量一致。 */
export const UPDATE_TARGETS: Record<Exclude<Platform, "other">, string> = {
  "win-x64": "windows-x86_64",
  "macos-arm64": "darwin-aarch64",
};

/** 每个平台独立的静态描述文件名，随 Release 附件发布。 */
export const UPDATER_DESCRIPTOR_NAMES: Record<Exclude<Platform, "other">, string> = {
  "win-x64": "updater-win-x64.json",
  "macos-arm64": "updater-macos-arm64.json",
};

export const updaterDescriptorName = (platform: Exclude<Platform, "other">) => UPDATER_DESCRIPTOR_NAMES[platform];

/** 选中一个可交给官方 updater 的 Release：定位静态描述、更新包直链与目标名。 */
export interface SelectedUpdate {
  version: string;
  pageUrl: string;
  descriptorUrl: string;
  packageUrl: string;
  target: string;
}

/** 描述文件本平台条目解析结果。 */
export interface DescriptorEntry {
  version: string;
  notes: string;
  url: string;
  signature: string;
}

/** 按 userAgent 判断平台；识别不出时不挑附件，只给 Release 页面。 */
export function detectPlatform(userAgent: string): Platform {
  if (/windows/i.test(userAgent)) return "win-x64";
  if (/mac os|macintosh/i.test(userAgent)) return "macos-arm64";
  return "other";
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/;

/** 解析 x.y.z / vx.y.z；带预发布后缀也接受，其余形态返回 null。 */
export function parseVersion(text: string): { parts: [number, number, number]; pre: string | null } | null {
  const m = VERSION_RE.exec(text.trim());
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** 比较版本：负数 a 旧、0 相同、正数 a 新。带预发布后缀的比同号正式版旧。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`无法比较版本：${a} 与 ${b}`);
  for (let i = 0; i < 3; i++) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] - pb.parts[i];
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

interface GiteaAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

/** 解析 Gitea `/releases/latest` 返回体；草稿 / 预发布 / 形态不对时返回 null。 */
export function parseLatestRelease(json: unknown, platform: Platform): ReleaseInfo | null {
  if (!json || typeof json !== "object") return null;
  const r = json as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (typeof r.tag_name !== "string" || !parseVersion(r.tag_name)) return null;
  if (r.draft === true || r.prerelease === true) return null;
  const version = r.tag_name.trim().replace(/^v/, "");
  const pageUrl = typeof r.html_url === "string" && r.html_url ? r.html_url : RELEASES_PAGE_URL;
  const expected = `kacha-${version}-${platform}.zip`;
  const assets = Array.isArray(r.assets) ? (r.assets as GiteaAsset[]) : [];
  const hit = platform === "other" ? undefined : assets.find((a) => a.name === expected && typeof a.browser_download_url === "string");
  return { version, pageUrl, downloadUrl: hit ? (hit.browser_download_url as string) : null };
}

/** 询问 Gitea 并与当前版本比较；网络或解析失败归为 error，由调用方决定是否打扰用户。 */
export async function checkForUpdate(currentVersion: string, platform: Platform, fetch: FetchLike, apiUrl = LATEST_RELEASE_API_URL): Promise<UpdateCheck> {
  let body: string;
  let status: number;
  try {
    const res = await fetch(apiUrl, { method: "GET", headers: { Accept: "application/json" } });
    status = res.status;
    body = await res.text();
  } catch (e) {
    return { status: "error", message: `无法连接发布服务器：${e instanceof Error ? e.message : String(e)}` };
  }
  if (status === 404) return { status: "latest" };
  if (status < 200 || status >= 300) return { status: "error", message: `发布服务器返回 HTTP ${status}` };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { status: "error", message: "发布服务器返回的不是 JSON" };
  }
  const release = parseLatestRelease(json, platform);
  if (!release) return { status: "error", message: "无法识别最新发布信息" };
  if (!parseVersion(currentVersion)) return { status: "error", message: `当前版本号无法识别：${currentVersion}` };
  return compareVersions(release.version, currentVersion) > 0 ? { status: "available", release } : { status: "latest" };
}

/** 更新包附件名：windows 安装器 / macOS 更新包。 */
export function updaterPackageName(version: string, platform: Exclude<Platform, "other">): string {
  return platform === "win-x64" ? `kacha-${version}-win-x64-setup.exe` : `kacha-${version}-macos-arm64.app.tar.gz`;
}

/** 从 Gitea Release 选择本平台完整 updater 描述；缺描述或缺更新包都返回 null（发布不完整）。 */
export function selectUpdateRelease(json: unknown, platform: Platform): SelectedUpdate | null {
  if (platform === "other" || !json || typeof json !== "object") return null;
  const r = json as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (typeof r.tag_name !== "string" || !/^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(r.tag_name.trim())) return null;
  if (r.draft === true || r.prerelease === true) return null;
  const version = r.tag_name.trim().replace(/^v/, "");
  const assets = Array.isArray(r.assets) ? (r.assets as GiteaAsset[]) : [];
  const byName = (name: string) => assets.find((a) => a.name === name && typeof a.browser_download_url === "string");
  const descriptor = byName(updaterDescriptorName(platform));
  const pkg = byName(updaterPackageName(version, platform));
  if (!descriptor || !pkg || !byName(`${updaterPackageName(version, platform)}.sig`)) return null;
  return {
    version,
    pageUrl: typeof r.html_url === "string" && r.html_url ? r.html_url : RELEASES_PAGE_URL,
    descriptorUrl: descriptor.browser_download_url as string,
    packageUrl: pkg.browser_download_url as string,
    target: UPDATE_TARGETS[platform],
  };
}

/** 校验静态描述：版本须与所选 Release 一致，本平台条目须指向所选更新包且带签名。 */
export function parseUpdaterDescriptor(json: unknown, selected: SelectedUpdate): DescriptorEntry | null {
  if (!json || typeof json !== "object") return null;
  const d = json as { version?: unknown; notes?: unknown; platforms?: unknown };
  if (d.version !== selected.version) return null;
  const platforms = (d.platforms ?? null) as Record<string, unknown> | null;
  const entry = platforms?.[selected.target] as { url?: unknown; signature?: unknown } | undefined;
  if (!entry || typeof entry !== "object") return null;
  if (entry.url !== selected.packageUrl) return null;
  if (typeof entry.signature !== "string" || !entry.signature.trim()) return null;
  return { version: selected.version, notes: typeof d.notes === "string" ? d.notes : "", url: entry.url as string, signature: entry.signature };
}
