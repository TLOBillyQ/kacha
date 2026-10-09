// 假壳的初始状态：spec 在 Node 侧拼好，经 page.addInitScript 交给页面里的 harness。
// 字节一律 base64，便于跨 Node / 浏览器序列化。

export type SeedFile = { text: string } | { b64: string };

export interface ScenarioPack {
  /** 包内条目名 → 内容（文本或 base64 字节）。 */
  entries: Record<string, SeedFile>;
}

export interface Scenario {
  outputRoot: string;
  appDataDir: string;
  /** 绝对路径 → 内容。 */
  files: Record<string, SeedFile>;
  settings: string | null;
  modelsCache: string | null;
  capabilityOverride: string | null;
  uiState: string | null;
  secret: string | null;
  /** 凭据库不可用：对应命令 reject。 */
  secretBroken: { get?: boolean; set?: boolean };
  /** 画板包：包路径 → 条目。 */
  packs: Record<string, ScenarioPack>;
  /** 挂起这些命令，直到 board_pack_cancel(true) 才以「已取消」reject。 */
  hold: string[];
  /** 命令 → 固定 reject 的错误文案。 */
  fail: Record<string, string>;
  /** updater 描述（e2e 注入）：非空时 plugin:updater|check 返回 Update。 */
  updaterDescriptor: { version: string; notes: string; pub_date: string; platforms: Record<string, { url: string; signature: string }> } | null;
}

export const OUTPUT_ROOT = "/e2e/out";
export const APP_DATA = "/e2e/appdata";

export function scenario(partial: Partial<Scenario> = {}): Scenario {
  return {
    outputRoot: OUTPUT_ROOT,
    appDataDir: APP_DATA,
    files: {},
    settings: null,
    modelsCache: null,
    capabilityOverride: null,
    uiState: null,
    secret: null,
    secretBroken: {},
    packs: {},
    hold: [],
    fail: {},
    updaterDescriptor: null,
    ...partial,
  };
}
