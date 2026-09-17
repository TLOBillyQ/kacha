import { describe, expect, it } from "vitest";
import { newBoard } from "./board";
import {
  BUILTIN_PRESETS,
  copyBuiltin,
  createPersonal,
  deletePersonal,
  parseBuiltinPresets,
  parsePersonalPresets,
  placePreset,
  PRESETS_FORMAT_VERSION,
  serializePersonalPresets,
  updatePersonal,
  validatePresetDraft,
  type Preset,
} from "./presets";

const builtin: Preset = { id: "egg-cartoon", name: "蛋仔卡通", project: "egg_party", prompt: "卡通风格", negative_prompt: "写实", builtin: true };
let n = 0;
const ids = () => `p${++n}`;

describe("个人预设文件", () => {
  it("缺文件为空列表", () => {
    expect(parsePersonalPresets(null)).toEqual({ kind: "ok", presets: [] });
  });

  it("序列化后读回一致，且不带只读标记", () => {
    const list = createPersonal([], { name: "我的", project: "thousand_stars", prompt: "正", negative_prompt: "" }, ids);
    const text = serializePersonalPresets(list);
    expect(JSON.parse(text)).toMatchObject({ format_version: PRESETS_FORMAT_VERSION });
    expect(text).not.toContain("builtin");
    expect(parsePersonalPresets(text)).toEqual({ kind: "ok", presets: list });
  });

  it("损坏、更新版本、非法条目分别报告", () => {
    expect(parsePersonalPresets("{").kind).toBe("corrupt");
    expect(parsePersonalPresets(JSON.stringify({ format_version: 99, presets: [] }))).toEqual({ kind: "newer", version: 99 });
    expect(parsePersonalPresets(JSON.stringify({ format_version: 1, presets: [{ id: "a", name: "", project: "egg_party", prompt: "x" }] })).kind).toBe("corrupt");
    expect(parsePersonalPresets(JSON.stringify({ format_version: 1, presets: [{ id: "a", name: "n", project: "other", prompt: "x" }] })).kind).toBe("corrupt");
  });

  it("重复 id 视为损坏", () => {
    const p = { id: "a", name: "n", project: "egg_party", prompt: "x", negative_prompt: "" };
    expect(parsePersonalPresets(JSON.stringify({ format_version: 1, presets: [p, p] })).kind).toBe("corrupt");
  });
});

describe("内置预设", () => {
  it("随客户端发布的内置预设可解析且全部只读", () => {
    expect(BUILTIN_PRESETS.every((p) => p.builtin)).toBe(true);
    expect(new Set(BUILTIN_PRESETS.map((p) => p.id)).size).toBe(BUILTIN_PRESETS.length);
  });

  it("内置预设文件非法时抛错（发布前由测试拦住）", () => {
    expect(() => parseBuiltinPresets({ presets: [{ id: "x" }] })).toThrow();
  });
});

describe("个人预设管理", () => {
  it("校验名称与正向提示词必填", () => {
    expect(validatePresetDraft({ name: " ", project: "egg_party", prompt: "x", negative_prompt: "" })).toBe("请填写预设名称");
    expect(validatePresetDraft({ name: "n", project: "egg_party", prompt: " ", negative_prompt: "" })).toBe("请填写正向提示词");
    expect(validatePresetDraft({ name: "n", project: "egg_party", prompt: "x", negative_prompt: "" })).toBeNull();
  });

  it("从内置复制为个人预设：新 id、可编辑", () => {
    const list = copyBuiltin([], builtin, ids);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "蛋仔卡通（副本）", project: "egg_party", prompt: "卡通风格", negative_prompt: "写实", builtin: false });
    expect(list[0].id).not.toBe(builtin.id);
  });

  it("编辑与删除只作用于目标个人预设", () => {
    const list = createPersonal(createPersonal([], { name: "a", project: "egg_party", prompt: "1", negative_prompt: "" }, ids), { name: "b", project: "egg_party", prompt: "2", negative_prompt: "" }, ids);
    const edited = updatePersonal(list, list[0].id, { name: " a2 ", project: "thousand_stars", prompt: "1'", negative_prompt: "neg" });
    expect(edited[0]).toMatchObject({ name: "a2", project: "thousand_stars", prompt: "1'", negative_prompt: "neg" });
    expect(edited[1]).toBe(list[1]);
    expect(deletePersonal(edited, list[0].id).map((p) => p.name)).toEqual(["b"]);
  });
});

describe("选取预设落成提示词节点", () => {
  it("正向、负向各一个提示词节点，负向在正向下方", () => {
    const { board } = placePreset(newBoard(), builtin, [100, 200], ids);
    const prompts = board.nodes.filter((x) => x.type === "prompt");
    expect(prompts.map((x) => x.type === "prompt" && x.text)).toEqual(["卡通风格", "写实"]);
    expect(prompts[0].type === "prompt" && prompts[0].pos).toEqual([100, 200]);
    const [a, b] = prompts as Extract<(typeof prompts)[number], { type: "prompt" }>[];
    expect(b.pos[0]).toBe(100);
    expect(b.pos[1]).toBeGreaterThan(a.pos[1] + a.size[1]);
    expect(board.edges).toEqual([]);
  });

  it("负向为空时也落负向节点，留给用户填写", () => {
    const { board } = placePreset(newBoard(), { ...builtin, negative_prompt: "" }, [0, 0], ids);
    expect(board.nodes.map((x) => x.type === "prompt" && x.text)).toEqual(["卡通风格", ""]);
  });
});
