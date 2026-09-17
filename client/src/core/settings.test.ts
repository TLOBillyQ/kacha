import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE } from "./capabilities";
import {
  availableModels,
  DEFAULT_SETTINGS,
  defaultTaskModel,
  discoveryFromCache,
  isPlainHttp,
  modelAvailabilityIssue,
  parseModelsCache,
  parseSettings,
  serializeModelsCache,
  serializeSettings,
  validateBaseUrl,
} from "./settings";

describe("高级设置 settings.json", () => {
  it("缺失时用默认值：v1 网关地址、输出根目录跟随默认、并发 3", () => {
    expect(parseSettings(null)).toEqual({ kind: "ok", settings: DEFAULT_SETTINGS });
    expect(DEFAULT_SETTINGS).toMatchObject({ format_version: 1, base_url: "http://lzxsvn:3001", output_root: null, concurrency: 3 });
  });

  it("往返并保留未知字段", () => {
    const settings = { ...DEFAULT_SETTINGS, base_url: "https://gw.example", output_root: "D:\\出图", concurrency: 5, extra: { future: [1] } };
    const text = serializeSettings(settings);
    expect(JSON.parse(text)).toMatchObject({ format_version: 1, future: [1] });
    expect(parseSettings(text)).toEqual({ kind: "ok", settings });
  });

  it("不含 API 密钥", () => {
    expect(serializeSettings(DEFAULT_SETTINGS)).not.toMatch(/key/i);
  });

  it("更新版本拒开：报告版本，给出默认值供本次运行，界面禁止覆盖保存", () => {
    expect(parseSettings(JSON.stringify({ format_version: 2, base_url: "x" }))).toEqual({ kind: "newer", version: 2, settings: DEFAULT_SETTINGS });
  });

  it("损坏报错并用默认值", () => {
    for (const text of ["{oops", "[]", '{"format_version":1,"base_url":3}', '{"format_version":1,"concurrency":9}', '{"format_version":0}']) {
      const parsed = parseSettings(text);
      expect(parsed.kind, text).toBe("corrupt");
      expect(parsed.settings).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("并发上限只接受 1～5 的整数", () => {
    expect(parseSettings('{"format_version":1,"concurrency":1}').kind).toBe("ok");
    expect(parseSettings('{"format_version":1,"concurrency":2.5}').kind).toBe("corrupt");
    expect(parseSettings('{"format_version":1,"concurrency":0}').kind).toBe("corrupt");
  });
});

describe("网关基础地址", () => {
  it("只接受 http / https 且有主机名", () => {
    expect(validateBaseUrl("http://lzxsvn:3001")).toBeNull();
    expect(validateBaseUrl("https://gw.example/")).toBeNull();
    expect(validateBaseUrl("")).not.toBeNull();
    expect(validateBaseUrl("ftp://x")).not.toBeNull();
    expect(validateBaseUrl("lzxsvn:3001")).not.toBeNull();
    expect(validateBaseUrl("http://")).not.toBeNull();
  });

  it("明文 HTTP 风险提示", () => {
    expect(isPlainHttp("http://lzxsvn:3001")).toBe(true);
    expect(isPlainHttp(" HTTP://x")).toBe(true);
    expect(isPlainHttp("https://x")).toBe(false);
  });
});

describe("模型发现", () => {
  const cache = { base_url: "http://lzxsvn:3001", fetched_at: "2026-09-16T09:00:00.000Z", model_ids: ["qwen-image-3.0-pro", "wan2.6-t2i"] };

  it("缓存往返；损坏的缓存视为没有", () => {
    expect(parseModelsCache(serializeModelsCache(cache))).toEqual(cache);
    expect(parseModelsCache("{")).toBeNull();
    expect(parseModelsCache(null)).toBeNull();
    expect(parseModelsCache('{"base_url":"x","fetched_at":"t","model_ids":[1]}')).toBeNull();
  });

  it("离线用缓存并标注；缓存属于别的网关地址时不用", () => {
    expect(discoveryFromCache(cache, "http://lzxsvn:3001/")).toEqual({ source: "cached", ids: cache.model_ids, fetchedAt: cache.fetched_at });
    expect(discoveryFromCache(cache, "http://other:3001")).toEqual({ source: "none" });
    expect(discoveryFromCache(null, "http://lzxsvn:3001")).toEqual({ source: "none" });
  });

  it("任务节点模型列表 = 发现结果 ∩ 上架清单", () => {
    const live = { source: "live" as const, ids: ["qwen-image-3.0-pro", "doubao-seedream-5-0-pro-260628"], fetchedAt: "t" };
    expect(availableModels(BUILTIN_TABLE, live).map((m) => m.model_id)).toEqual(["qwen-image-3.0-pro"]);
  });

  it("从未发现过时列出上架清单", () => {
    expect(availableModels(BUILTIN_TABLE, { source: "none" }).map((m) => m.model_id)).toEqual(["qwen-image-3.0-pro", "qwen-image-3.0"]);
  });

  it("已发现但网关没有该模型时，任务标红原因", () => {
    const live = { source: "live" as const, ids: ["qwen-image-3.0-pro"], fetchedAt: "t" };
    expect(modelAvailabilityIssue(BUILTIN_TABLE, live, "qwen-image-3.0-pro")).toBeNull();
    expect(modelAvailabilityIssue(BUILTIN_TABLE, live, "qwen-image-3.0")).toBe("网关未提供模型 qwen-image-3.0");
    expect(modelAvailabilityIssue(BUILTIN_TABLE, { source: "none" }, "qwen-image-3.0")).toBeNull();
  });
});

describe("新建任务默认模型", () => {
  const live = (ids: string[]) => ({ source: "live" as const, ids, fetchedAt: "t" });

  it("优先画板级最近选择；不可用时退回可用列表第一个", () => {
    expect(defaultTaskModel(BUILTIN_TABLE, { source: "none" }, "qwen-image-3.0")).toBe("qwen-image-3.0");
    expect(defaultTaskModel(BUILTIN_TABLE, { source: "none" }, null)).toBe("qwen-image-3.0-pro");
    expect(defaultTaskModel(BUILTIN_TABLE, live(["qwen-image-3.0"]), "qwen-image-3.0-pro")).toBe("qwen-image-3.0");
    expect(defaultTaskModel(BUILTIN_TABLE, { source: "none" }, "doubao-seedream-5-0-pro-260628")).toBe("qwen-image-3.0-pro");
  });

  it("网关一个上架模型都没有时仍给上架清单第一个（节点会标红）", () => {
    expect(defaultTaskModel(BUILTIN_TABLE, live([]), null)).toBe("qwen-image-3.0-pro");
  });
});
