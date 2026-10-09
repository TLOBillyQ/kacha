// e2e 假壳：在应用脚本运行前装好 window.__TAURI_INTERNALS__，按 src-tauri/src/lib.rs 的命令表用内存文件系统实现，
// 再加载真正的 src/main.tsx。spec 经 window.__e2e 预置、观察与驱动（见 e2e/app.ts）。
// 与 Rust 契约的对应：命令名与参数见 shell/ipc.ts；取消文案 = board_pack.rs 的 CANCELLED（core/boardPack.ts 的 PACK_CANCELLED）。
import { PACK_CANCELLED } from "../src/core/boardPack";
import type { Scenario, SeedFile } from "./scenario";

declare global {
  interface Window {
    __E2E_SCENARIO__?: Scenario;
    __e2e: E2eControl;
    __TAURI_INTERNALS__: Record<string, unknown>;
  }
}

export interface Call {
  cmd: string;
  args: unknown;
}

export interface E2eControl {
  calls: Call[];
  logs: { kind: string; fields: Record<string, unknown> }[];
  /** 对话框应答队列：open / save 返回路径（null = 用户取消），message 返回按钮标签。 */
  dialogAnswers: Record<"open" | "save" | "message", unknown[]>;
  readText(path: string): string | null;
  exists(path: string): boolean;
  list(prefix: string): string[];
  writeText(path: string, text: string): void;
  remove(path: string): void;
  emit(event: string, payload: unknown): void;
  /** 当前挂起的命令名。 */
  held(): string[];
  pause(cmd: string): void;
  release(cmd: string): void;
  fail: Record<string, string>;
  secret: string | null;
}

const scn = window.__E2E_SCENARIO__;
if (!scn) throw new Error("缺少 __E2E_SCENARIO__：spec 须先 addInitScript 预置场景");

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const enc = new TextEncoder();
const dec = new TextDecoder();
const toBytes = (f: SeedFile) => ("text" in f ? enc.encode(f.text) : b64ToBytes(f.b64));

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const files = new Map<string, Uint8Array>();
for (const [p, f] of Object.entries(scn.files)) files.set(norm(p), toBytes(f));

const appData = (name: string) => `${norm(scn.appDataDir)}/${name}`;
const seedAppData = (name: string, text: string | null) => text !== null && files.set(appData(name), enc.encode(text));
seedAppData("settings.json", scn.settings);
seedAppData("models_cache.json", scn.modelsCache);
seedAppData("capabilities.override.json", scn.capabilityOverride);
seedAppData("ui_state.json", scn.uiState);

const readText = (p: string) => {
  const b = files.get(norm(p));
  return b ? dec.decode(b) : null;
};
const need = (p: string) => {
  const b = files.get(norm(p));
  if (!b) throw `文件不存在：${p}`;
  return b;
};
const dirOf = (p: string) => norm(p).slice(0, norm(p).lastIndexOf("/"));
const baseOf = (p: string) => norm(p).slice(norm(p).lastIndexOf("/") + 1);

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 只认 PNG：宽高在 IHDR，透明通道看颜色类型（4 灰度+α / 6 RGBA）。与 image_info.rs 同口径的最小子集。 */
async function inspectImage(path: string) {
  const b = need(path);
  const sig = [0x89, 0x50, 0x4e, 0x47];
  if (!sig.every((v, i) => b[i] === v)) throw `无法识别的图片格式：${path}`;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const colorType = b[25];
  return { sha256: await sha256(b), bytes: b.length, width: view.getUint32(16), height: view.getUint32(20), format: "png", has_alpha: colorType === 4 || colorType === 6 };
}

// ---- 事件 ----
const callbacks = new Map<number, (data: unknown) => void>();
let nextCallback = 1;
const listeners = new Map<string, Set<number>>();
let nextEventId = 1;
const listenerIds = new Map<number, { event: string; handler: number }>();

function emit(event: string, payload: unknown) {
  for (const handler of listeners.get(event) ?? []) callbacks.get(handler)?.({ event, id: 0, payload });
}

// ---- 挂起与取消（画板包） ----
let cancelled = false;
const holds = new Map<string, () => void>();
const paused = new Set<string>();
const pausedCalls = new Map<string, (() => void)[]>();
function holdable<T>(cmd: string, work: () => Promise<T> | T): Promise<T> {
  if (!scn!.hold.includes(cmd)) return Promise.resolve(work());
  return new Promise<T>((resolve, reject) => {
    const check = () => {
      if (cancelled) {
        holds.delete(cmd);
        reject(PACK_CANCELLED);
      }
    };
    holds.set(cmd, check);
    void resolve;
  });
}

// ---- 对话框 ----
const control: E2eControl = {
  calls: [],
  logs: [],
  dialogAnswers: { open: [], save: [], message: [] },
  readText,
  exists: (p) => files.has(norm(p)),
  list: (prefix) => [...files.keys()].filter((k) => k.startsWith(norm(prefix))).sort(),
  writeText: (p, text) => void files.set(norm(p), enc.encode(text)),
  remove: (p) => void files.delete(norm(p)),
  emit,
  held: () => [...holds.keys(), ...pausedCalls.keys()],
  pause: (cmd) => void paused.add(cmd),
  release: (cmd) => {
    paused.delete(cmd);
    for (const resolve of pausedCalls.get(cmd) ?? []) resolve();
    pausedCalls.delete(cmd);
  },
  fail: { ...scn.fail },
  secret: scn.secret,
};
window.__e2e = control;

function answer(kind: "open" | "save" | "message", fallback: unknown) {
  const queue = control.dialogAnswers[kind];
  return queue.length ? queue.shift() : fallback;
}

// ---- 命令表 ----
type Args = Record<string, any>;
const commands: Record<string, (a: Args, options?: { headers?: Record<string, string> }, raw?: unknown) => unknown> = {
  app_paths: () => ({ default_output_root: scn.outputRoot, app_data_dir: scn.appDataDir }),
  startup_args: () => [],
  read_board: (a) => ({ main: readText(a.path), bak: readText(`${a.path}.bak`) }),
  write_board: (a) => {
    const current = readText(a.path);
    if (current !== null) files.set(norm(`${a.path}.bak`), enc.encode(current));
    files.set(norm(a.path), enc.encode(a.text));
  },
  rename_board: (a) => {
    if (files.has(norm(a.to))) throw `目标已存在：${a.to}`;
    files.set(norm(a.to), need(a.from));
    files.delete(norm(a.from));
  },
  list_board_names: (a) =>
    [...files.keys()].filter((k) => dirOf(k) === norm(a.dir) && k.endsWith(".ugcboard.json")).map(baseOf),
  read_ui_state: () => readText(appData("ui_state.json")),
  write_ui_state: (a) => void files.set(appData("ui_state.json"), enc.encode(a.text)),
  read_capability_override: () => readText(appData("capabilities.override.json")),
  inspect_image: (a) => inspectImage(a.path),
  read_settings: () => readText(appData("settings.json")),
  write_settings: (a) => void files.set(appData("settings.json"), enc.encode(a.text)),
  read_models_cache: () => readText(appData("models_cache.json")),
  write_models_cache: (a) => void files.set(appData("models_cache.json"), enc.encode(a.text)),
  log_event: (a) => void control.logs.push({ kind: a.kind, fields: a.fields }),
  diagnostics_preview: () => [],
  diagnostics_export: () => [],
  board_pack_cancel: (a) => {
    cancelled = a.cancelled;
    if (cancelled) holds.forEach((check) => check());
  },
  board_pack_entries: (a) => {
    const pack = scn.packs[a.pack];
    if (!pack) throw `无法读取画板包：${a.pack}`;
    return Object.keys(pack.entries);
  },
  board_pack_read_texts: (a) => {
    const pack = scn.packs[a.pack];
    return Object.fromEntries((a.names as string[]).filter((n) => pack.entries[n]).map((n) => [n, dec.decode(toBytes(pack.entries[n]))]));
  },
  board_pack_import: (a) =>
    holdable("board_pack_import", async () => {
      const pack = scn.packs[a.pack];
      const root = norm(a.outputRoot);
      const outcomes: { path: string; outcome: string }[] = [];
      let bytes = 0;
      const units = a.units as { path: string; identity: string | null }[];
      for (const [i, unit] of units.entries()) {
        emit("board-pack-progress", { done: i, total: units.length });
        const names = Object.keys(pack.entries).filter((n) => n === unit.path || n.startsWith(`${unit.path}/`));
        const identity = unit.identity ? `${unit.path}/${unit.identity}` : unit.path;
        const local = files.get(`${root}/${identity}`);
        if (local) {
          const same = (await sha256(local)) === (await sha256(toBytes(pack.entries[identity])));
          outcomes.push({ path: unit.path, outcome: same ? "identical" : "conflict" });
          continue;
        }
        for (const n of names) {
          const b = toBytes(pack.entries[n]);
          bytes += b.length;
          files.set(`${root}/${n}`, b);
        }
        outcomes.push({ path: unit.path, outcome: "moved" });
      }
      emit("board-pack-progress", { done: units.length, total: units.length });
      return { outcomes, bytes };
    }),
  board_pack_export: (a) =>
    holdable("board_pack_export", () => {
      files.set(norm(a.target), enc.encode(JSON.stringify(a.spec)));
      return { task_dirs: a.spec.task_dirs.length, bytes: 1024 };
    }),
  secret_get: () => {
    if (scn.secretBroken.get) throw "凭据库不可用";
    return control.secret;
  },
  secret_set: (a) => {
    if (scn.secretBroken.set) throw "凭据库不可用";
    control.secret = a.key;
  },
  secret_delete: () => void (control.secret = null),
  list_dir: (a) => {
    const dir = norm(a.path);
    const names = new Map<string, boolean>();
    for (const k of files.keys()) {
      if (!k.startsWith(`${dir}/`)) continue;
      const rest = k.slice(dir.length + 1).split("/");
      names.set(rest[0], rest.length > 1 || names.get(rest[0]) === true);
    }
    return [...names].map(([name, is_dir]) => ({ name, is_dir }));
  },
  file_sha256: (a) => sha256(need(a.path)),
  is_file: (a) => files.has(norm(a.path)),
  read_file_bytes: (a) => need(a.path).slice().buffer,
  write_new_file: (_a, options, raw) => {
    const path = decodeURIComponent(options?.headers?.["x-path"] ?? "");
    if (!path) throw "缺少 x-path";
    if (files.has(norm(path))) throw `文件已存在：${path}`;
    files.set(norm(path), new Uint8Array(raw as Uint8Array));
  },

  "plugin:dialog|open": () => answer("open", null),
  "plugin:dialog|save": () => answer("save", null),
  "plugin:dialog|message": (a) => {
    const buttons = a.buttons;
    const ok = typeof buttons === "object" && buttons !== null ? (buttons.OkCancelCustom?.[0] ?? buttons.OkCustom ?? "Ok") : buttons === "YesNo" ? "Yes" : "Ok";
    return answer("message", ok);
  },
  "plugin:opener|open_url": () => null,
  "plugin:app|version": () => "0.0.0-e2e",
  "plugin:event|listen": (a) => {
    const id = nextEventId++;
    listenerIds.set(id, { event: a.event, handler: a.handler });
    if (!listeners.has(a.event)) listeners.set(a.event, new Set());
    listeners.get(a.event)!.add(a.handler);
    return id;
  },
  "plugin:event|unlisten": (a) => {
    const l = listenerIds.get(a.eventId);
    if (l) listeners.get(l.event)?.delete(l.handler);
    listenerIds.delete(a.eventId);
  },
  "plugin:event|emit": (a) => emit(a.event, a.payload),
  "plugin:window|scale_factor": () => 1,
  "plugin:window|is_maximized": () => false,
};

async function invoke(cmd: string, args: unknown, options?: { headers?: Record<string, string> }) {
  control.calls.push({ cmd, args: args instanceof Uint8Array ? `<${args.length} bytes>` : args });
  if (paused.has(cmd)) await new Promise<void>((resolve) => {
    pausedCalls.set(cmd, [...(pausedCalls.get(cmd) ?? []), resolve]);
  });
  if (control.fail[cmd]) throw control.fail[cmd];
  const handler = commands[cmd];
  if (handler) return handler((args ?? {}) as Args, options, args);
  if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:webview|")) return null;
  throw `e2e 假壳未实现命令：${cmd}`;
}

const blobUrls = new Map<string, string>();
window.__TAURI_INTERNALS__ = {
  invoke,
  transformCallback: (cb: (data: unknown) => void, once = false) => {
    const id = nextCallback++;
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id);
      cb(data);
    });
    return id;
  },
  unregisterCallback: (id: number) => callbacks.delete(id),
  runCallback: (id: number, data: unknown) => callbacks.get(id)?.(data),
  callbacks,
  // 图片直接给 blob URL；文件缺失时给一个必然加载失败的地址，走界面的缺图占位。
  convertFileSrc: (path: string) => {
    const b = files.get(norm(path));
    if (!b) return `http://missing.invalid/${encodeURIComponent(path)}`;
    const key = `${norm(path)}#${b.length}`;
    if (!blobUrls.has(key)) blobUrls.set(key, URL.createObjectURL(new Blob([b as BlobPart], { type: "image/png" })));
    return blobUrls.get(key)!;
  },
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: (event: string, id: number) => {
    const l = listenerIds.get(id);
    if (l) listeners.get(event)?.delete(l.handler);
  },
};

await import("../src/main.tsx");
