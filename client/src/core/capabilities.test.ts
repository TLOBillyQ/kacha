import { describe, expect, it } from "vitest";
import {
  BUILTIN_TABLE,
  isSupported,
  mergeOverride,
  modelsByTier,
  parseCapabilityTable,
  untestedCapabilities,
} from "./capabilities";

const qwenPro = () => BUILTIN_TABLE.models.find((m) => m.model_id === "qwen-image-3.0-pro")!;

describe("内置能力表", () => {
  it("通过自身 schema 校验，顶层整数 format_version", () => {
    expect(BUILTIN_TABLE.format_version).toBe(1);
    expect(BUILTIN_TABLE.models.length).toBe(4);
  });

  it("只有 qwen 两个模型上架，Seedream 四个不赋档位", () => {
    const groups = modelsByTier(BUILTIN_TABLE);
    expect(groups.map((g) => [g.tier, g.models.map((m) => m.model_id)])).toEqual([
      ["flagship", ["qwen-image-3.0-pro"]],
      ["economy", ["qwen-image-3.0"]],
    ]);
  });

  it("help_url 按规格初值", () => {
    expect(qwenPro().help_url).toContain("platform.qianwenai.com");
    const seedream = BUILTIN_TABLE.models.find((m) => m.model_id.startsWith("doubao-seedream-5-0-pro"))!;
    expect(seedream.help_url).toBe("https://docs.volcengine.com/docs/82379/1829186?lang=zh");
  });
});

describe("三态", () => {
  it("待测在 UI 上等同不支持", () => {
    expect(isSupported("supported")).toBe(true);
    expect(isSupported("untested")).toBe(false);
    expect(isSupported("unsupported")).toBe(false);
  });

  it("列出模型的待测能力供模型说明浮层展示", () => {
    const pro = BUILTIN_TABLE.models.find((m) => m.model_id.startsWith("doubao-seedream-5-0-pro"))!;
    expect(untestedCapabilities(pro)).toEqual([
      "透明背景",
      "拆分图层（文生图）",
      "拆分图层（图片编辑）",
    ]);
    expect(untestedCapabilities(qwenPro())).toEqual([]);
  });
});

describe("解析与校验", () => {
  it("拒绝非整数 format_version", () => {
    const result = parseCapabilityTable({ format_version: "1", models: [] });
    expect(result.ok).toBe(false);
  });

  it("拒绝非法三态取值并指出字段", () => {
    const bad = structuredClone(BUILTIN_TABLE) as unknown as { models: Record<string, unknown>[] };
    bad.models[0].native_mask = "maybe";
    const result = parseCapabilityTable(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("native_mask");
  });

  it("拒绝更新版本的表", () => {
    const result = parseCapabilityTable({ format_version: 2, models: [] });
    expect(result.ok).toBe(false);
  });
});

describe("覆盖文件按模型合并", () => {
  it("同 model_id 整条替换内置，新模型追加，其余不动", () => {
    const override = structuredClone(qwenPro());
    override.workflows.image_edit.max_references = 5;
    const added = { ...structuredClone(qwenPro()), model_id: "new-model", tier: null };
    const merged = mergeOverride(BUILTIN_TABLE, { format_version: 1, models: [override, added] });
    expect(merged.models.length).toBe(5);
    expect(merged.models.find((m) => m.model_id === "qwen-image-3.0-pro")!.workflows.image_edit.max_references).toBe(5);
    expect(merged.models.find((m) => m.model_id === "qwen-image-3.0")!.workflows.image_edit.max_references).toBe(3);
    expect(merged.models.at(-1)!.model_id).toBe("new-model");
    expect(BUILTIN_TABLE.models[0].workflows.image_edit.max_references).toBe(3);
  });
});
