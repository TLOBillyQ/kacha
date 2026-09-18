// 项目预设：内置预设随客户端发布、只读；个人预设在 app-data 目录 presets.json，不进画板文件。
// 预设不是节点：选取后正向、负向各落成一个提示词节点。
import type { Board, PromptNode } from "./board";
import builtinJson from "./presets.builtin.json";
import { PROMPT_NODE_SIZE, ROW_GAP } from "./layout";

export const PRESETS_FORMAT_VERSION = 1;

export const PROJECTS = { egg_party: "蛋仔派对", thousand_stars: "千星" } as const;
export type PresetProject = keyof typeof PROJECTS;

export interface PresetDraft {
  name: string;
  project: PresetProject;
  prompt: string;
  negative_prompt: string;
}

export interface Preset extends PresetDraft {
  id: string;
  builtin: boolean;
}

export type LoadedPresets = { kind: "ok"; presets: Preset[] } | { kind: "newer"; version: number } | { kind: "corrupt"; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 单条预设；非法时返回原因。 */
function parsePreset(raw: unknown, builtin: boolean): Preset | string {
  if (!isObject(raw)) return "预设必须是对象";
  const { id, name, project, prompt, negative_prompt = "" } = raw;
  if (typeof id !== "string" || !id) return "预设 id 必须是非空字符串";
  if (typeof name !== "string" || !name.trim()) return `预设 ${id} 缺少名称`;
  if (typeof project !== "string" || !(project in PROJECTS)) return `预设 ${id} 的项目必须是蛋仔派对或千星`;
  if (typeof prompt !== "string" || !prompt.trim()) return `预设 ${id} 缺少正向提示词`;
  if (typeof negative_prompt !== "string") return `预设 ${id} 的负向提示词必须是字符串`;
  return { id, name: name.trim(), project: project as PresetProject, prompt, negative_prompt, builtin };
}

function parseList(list: unknown, builtin: boolean): Preset[] | string {
  if (!Array.isArray(list)) return "presets 必须是数组";
  const out: Preset[] = [];
  for (const item of list) {
    const p = parsePreset(item, builtin);
    if (typeof p === "string") return p;
    if (out.some((x) => x.id === p.id)) return `预设 id 重复：${p.id}`;
    out.push(p);
  }
  return out;
}

/** 内置预设文件由团队维护；非法直接抛错，由测试在发布前拦住。 */
export function parseBuiltinPresets(json: unknown): Preset[] {
  const list = parseList(isObject(json) ? json.presets : undefined, true);
  if (typeof list === "string") throw new Error(`内置预设无效：${list}`);
  return list;
}

export const BUILTIN_PRESETS: readonly Preset[] = parseBuiltinPresets(builtinJson);

export function parsePersonalPresets(text: string | null): LoadedPresets {
  if (text === null) return { kind: "ok", presets: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "corrupt", reason: "不是有效的 JSON" };
  }
  if (!isObject(raw) || !Number.isInteger(raw.format_version) || (raw.format_version as number) < 1) {
    return { kind: "corrupt", reason: "format_version 必须是正整数" };
  }
  if ((raw.format_version as number) > PRESETS_FORMAT_VERSION) return { kind: "newer", version: raw.format_version as number };
  const list = parseList(raw.presets, false);
  return typeof list === "string" ? { kind: "corrupt", reason: list } : { kind: "ok", presets: list };
}

export function serializePersonalPresets(presets: Preset[]): string {
  const items = presets.map(({ id, name, project, prompt, negative_prompt }) => ({ id, name, project, prompt, negative_prompt }));
  return `${JSON.stringify({ format_version: PRESETS_FORMAT_VERSION, presets: items }, null, 2)}\n`;
}

/** 返回错误说明；合法为 null。 */
export function validatePresetDraft(draft: PresetDraft): string | null {
  if (!draft.name.trim()) return "请填写预设名称";
  if (!draft.prompt.trim()) return "请填写正向提示词";
  return null;
}

const personal = (id: string, draft: PresetDraft): Preset => ({ ...draft, id, name: draft.name.trim(), builtin: false });

export function createPersonal(list: Preset[], draft: PresetDraft, newId: () => string): Preset[] {
  return [...list, personal(newId(), draft)];
}

export function copyBuiltin(list: Preset[], source: Preset, newId: () => string): Preset[] {
  return createPersonal(list, { name: `${source.name}（副本）`, project: source.project, prompt: source.prompt, negative_prompt: source.negative_prompt }, newId);
}

export function updatePersonal(list: Preset[], id: string, draft: PresetDraft): Preset[] {
  return list.map((p) => (p.id === id ? personal(id, draft) : p));
}

export function deletePersonal(list: Preset[], id: string): Preset[] {
  return list.filter((p) => p.id !== id);
}

/** 在 at 处落正向提示词节点，正下方落负向提示词节点（负向为空也落，留给用户填写）；不连线。 */
export function placePreset(board: Board, preset: PresetDraft, at: [number, number], newId: () => string): { board: Board; nodeIds: string[] } {
  const texts = [preset.prompt, preset.negative_prompt];
  const nodes: PromptNode[] = texts.map((text, i) => ({
    type: "prompt",
    id: newId(),
    pos: [at[0], at[1] + i * (PROMPT_NODE_SIZE[1] + ROW_GAP)],
    size: PROMPT_NODE_SIZE,
    text,
    extra: {},
  }));
  return { board: { ...board, nodes: [...board.nodes, ...nodes] }, nodeIds: nodes.map((n) => n.id) };
}
