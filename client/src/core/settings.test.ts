import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE } from "./capabilities";
import {
  availableModels,
  DEFAULT_SETTINGS,
  defaultTaskModel,
  discoveryFromCache,
  isPlainHttp,
  loadSettings,
  modelAvailabilityIssue,
  parseModelsCache,
  parseSettings,
  refreshModels,
  saveSettings,
  serializeModelsCache,
  serializeSettings,
  validateBaseUrl,
  type SettingsPorts,
} from "./settings";

/** 内存里的设置端口：记下每次写入；stub 可让某个端口抛错。 */
function memoryPorts(stub: Partial<SettingsPorts> = {}) {
  const writes = { settings: [] as string[], cache: [] as string[], secretSet: [] as string[], secretDelete: 0 };
  const logs: { kind: string; fields: Record<string, unknown> }[] = [];
  const ports: SettingsPorts = {
    readSettings: async () => null,
    writeSettings: async (text) => void writes.settings.push(text),
    readModelsCache: async () => null,
    writeModelsCache: async (text) => void writes.cache.push(text),
    secretGet: async () => null,
    secretSet: async (key) => void writes.secretSet.push(key),
    secretDelete: async () => void writes.secretDelete++,
    fetch: async () => {
      throw new Error("未联网");
    },
    now: () => new Date("2026-09-18T08:00:00Z"),
    log: (kind, fields) => void logs.push({ kind, fields }),
    ...stub,
  };
  return { ports, writes, logs };
}

describe("高级设置 settings.json", () => {
  it("缺失时用默认值：v1 网关地址、输出根目录跟随默认、并发 4", () => {
    expect(parseSettings(null)).toEqual({ kind: "ok", settings: DEFAULT_SETTINGS });
    expect(DEFAULT_SETTINGS).toMatchObject({ format_version: 1, base_url: "http://lzxsvn:3001", output_root: null, concurrency: 4 });
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
    for (const text of ["{oops", "[]", '{"format_version":1,"base_url":3}', '{"format_version":1,"concurrency":11}', '{"format_version":0}']) {
      const parsed = parseSettings(text);
      expect(parsed.kind, text).toBe("corrupt");
      expect(parsed.settings).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("并发上限只接受 1～10 的整数", () => {
    expect(parseSettings('{"format_version":1,"concurrency":1}').kind).toBe("ok");
    expect(parseSettings('{"format_version":1,"concurrency":10}').kind).toBe("ok");
    expect(parseSettings('{"format_version":1,"concurrency":11}').kind).toBe("corrupt");
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
    expect(availableModels(BUILTIN_TABLE, live).map((m) => m.model_id)).toEqual(["qwen-image-3.0-pro", "doubao-seedream-5-0-pro-260628"]);
  });

  it("从未发现过时列出上架清单", () => {
    expect(availableModels(BUILTIN_TABLE, { source: "none" }).map((m) => m.model_id)).toEqual(["qwen-image-3.0-pro", "doubao-seedream-5-0-pro-260628", "qwen-image-3.0", "doubao-seedream-5-0-lite-260128"]);
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

  it("优先画板级最近选择；否则首选 Seedream 5.0 lite；都不可用时退回可用列表第一个", () => {
    expect(defaultTaskModel(BUILTIN_TABLE, { source: "none" }, "qwen-image-3.0")).toBe("qwen-image-3.0");
    expect(defaultTaskModel(BUILTIN_TABLE, { source: "none" }, null)).toBe("doubao-seedream-5-0-lite-260128");
    expect(defaultTaskModel(BUILTIN_TABLE, live(["qwen-image-3.0"]), "qwen-image-3.0-pro")).toBe("qwen-image-3.0");
    expect(defaultTaskModel(BUILTIN_TABLE, { source: "none" }, "doubao-seedream-5-0-pro-260628")).toBe("doubao-seedream-5-0-pro-260628");
    expect(defaultTaskModel(BUILTIN_TABLE, { source: "none" }, "nope")).toBe("doubao-seedream-5-0-lite-260128");
    expect(defaultTaskModel(BUILTIN_TABLE, live(["qwen-image-3.0-pro", "doubao-seedream-5-0-pro-260628"]), null)).toBe("qwen-image-3.0-pro");
  });

  it("网关一个上架模型都没有时仍给上架清单第一个（节点会标红）", () => {
    expect(defaultTaskModel(BUILTIN_TABLE, live([]), null)).toBe("qwen-image-3.0-pro");
  });
});

describe("保存设置", () => {
  const next = { ...DEFAULT_SETTINGS, base_url: "http://other:3001" };

  it("文件由更新版本写入（newer）时不写 settings.json，但仍存密钥", async () => {
    const { ports, writes } = memoryPorts();
    const result = await saveSettings(ports, { file: "newer", apiKey: "", keyPersistence: "persisted" }, next, "sk-new");
    expect(result).toEqual({ ok: true, settingsWritten: false, keyPersistence: "persisted" });
    expect(writes.settings).toEqual([]);
    expect(writes.secretSet).toEqual(["sk-new"]);
  });

  it("文件正常时写 settings.json；密钥未变且已存入凭据库时不碰凭据库", async () => {
    const { ports, writes } = memoryPorts();
    const result = await saveSettings(ports, { file: "ok", apiKey: "sk", keyPersistence: "persisted" }, next, "sk");
    expect(result).toEqual({ ok: true, settingsWritten: true, keyPersistence: "persisted" });
    expect(JSON.parse(writes.settings[0])).toMatchObject({ base_url: "http://other:3001" });
    expect(writes.secretSet).toEqual([]);
    expect(writes.secretDelete).toBe(0);
  });

  it("凭据库 set 抛错时密钥退回会话内存（session）", async () => {
    const { ports } = memoryPorts({
      secretSet: async () => {
        throw new Error("凭据库不可用");
      },
    });
    const result = await saveSettings(ports, { file: "ok", apiKey: "", keyPersistence: "persisted" }, next, "sk-new");
    expect(result).toEqual({ ok: true, settingsWritten: true, keyPersistence: "session" });
  });

  it("当前为 session 时即使密钥未变也重试写入凭据库，成功后回到 persisted", async () => {
    const { ports, writes } = memoryPorts();
    const result = await saveSettings(ports, { file: "ok", apiKey: "sk", keyPersistence: "session" }, next, "sk");
    expect(writes.secretSet).toEqual(["sk"]);
    expect(result).toMatchObject({ ok: true, keyPersistence: "persisted" });
  });

  it("清空密钥走删除", async () => {
    const { ports, writes } = memoryPorts();
    await saveSettings(ports, { file: "ok", apiKey: "sk", keyPersistence: "persisted" }, next, "");
    expect(writes.secretDelete).toBe(1);
    expect(writes.secretSet).toEqual([]);
  });

  it("写 settings.json 失败时返回报错原文，不再碰凭据库", async () => {
    const { ports, writes } = memoryPorts({
      writeSettings: async () => {
        throw new Error("磁盘已满");
      },
    });
    const result = await saveSettings(ports, { file: "ok", apiKey: "", keyPersistence: "persisted" }, next, "sk-new");
    expect(result).toEqual({ ok: false, error: "磁盘已满" });
    expect(writes.secretSet).toEqual([]);
  });
});

describe("载入设置", () => {
  const cacheText = serializeModelsCache({ base_url: "http://lzxsvn:3001", fetched_at: "2026-09-17T00:00:00Z", model_ids: ["m1"] });

  it("读出设置、文件状态、凭据库里的密钥与模型缓存", async () => {
    const { ports } = memoryPorts({
      readSettings: async () => serializeSettings({ ...DEFAULT_SETTINGS, concurrency: 2 }),
      readModelsCache: async () => cacheText,
      secretGet: async () => "sk",
    });
    const loaded = await loadSettings(ports);
    expect(loaded.file).toMatchObject({ kind: "ok", settings: { concurrency: 2 } });
    expect(loaded).toMatchObject({ apiKey: "sk", keyPersistence: "persisted", cache: { model_ids: ["m1"] } });
  });

  it("凭据库 get 抛错时密钥为空、退回 session", async () => {
    const { ports } = memoryPorts({
      secretGet: async () => {
        throw new Error("凭据库不可用");
      },
    });
    expect(await loadSettings(ports)).toMatchObject({ apiKey: "", keyPersistence: "session" });
  });

  it("读文件抛错按缺失处理：默认设置、无缓存", async () => {
    const fail = async () => {
      throw new Error("读失败");
    };
    const { ports } = memoryPorts({ readSettings: fail, readModelsCache: fail });
    expect(await loadSettings(ports)).toEqual({ file: { kind: "ok", settings: DEFAULT_SETTINGS }, apiKey: "", keyPersistence: "persisted", cache: null });
  });

  it("文件由更新版本写入时如实报 newer", async () => {
    const { ports } = memoryPorts({ readSettings: async () => JSON.stringify({ format_version: 99 }) });
    expect((await loadSettings(ports)).file).toMatchObject({ kind: "newer", version: 99 });
  });
});

describe("刷新模型列表", () => {
  const BASE = "http://lzxsvn:3001";
  const cached = { base_url: `${BASE}/`, fetched_at: "2026-09-17T00:00:00Z", model_ids: ["old"] };
  const modelsFetch = (status: number, body: unknown) => async () => ({
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  });

  it("成功：返回发现结果并写入按规范化地址记的缓存", async () => {
    const { ports, writes, logs } = memoryPorts({ fetch: modelsFetch(200, { data: [{ id: "m1" }, { id: "m2" }] }) });
    const result = await refreshModels(ports, `${BASE}/`, "sk", cached);
    const cache = { base_url: BASE, fetched_at: "2026-09-18T08:00:00.000Z", model_ids: ["m1", "m2"] };
    expect(result).toEqual({ ok: true, cache, discovery: { source: "live", ids: ["m1", "m2"], fetchedAt: cache.fetched_at } });
    expect(JSON.parse(writes.cache[0])).toEqual(cache);
    expect(logs).toEqual([{ kind: "connection", fields: { stage: "list_models", ok: true, models: 2 } }]);
  });

  it("写缓存失败不影响结果，仍返回 ok", async () => {
    const { ports } = memoryPorts({
      fetch: modelsFetch(200, { data: [{ id: "m1" }] }),
      writeModelsCache: async () => {
        throw new Error("磁盘已满");
      },
    });
    expect(await refreshModels(ports, BASE, "sk", null)).toMatchObject({ ok: true, discovery: { source: "live", ids: ["m1"] } });
  });

  it("失败：回落到同 base_url 的缓存，并记一条 connection 日志", async () => {
    const { ports, writes, logs } = memoryPorts({ fetch: modelsFetch(401, { error: { message: "bad key" } }) });
    const result = await refreshModels(ports, BASE, "sk", cached);
    expect(result).toMatchObject({ ok: false, discovery: { source: "cached", ids: ["old"], fetchedAt: cached.fetched_at } });
    expect(result.ok || result.message).toBeTruthy();
    expect(writes.cache).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ kind: "connection", fields: { stage: "list_models", ok: false, category: "auth", status_code: 401 } });
  });

  it("失败且缓存属于别的 base_url：视为无缓存", async () => {
    const { ports } = memoryPorts();
    expect(await refreshModels(ports, "http://other:3001", "sk", cached)).toMatchObject({ ok: false, discovery: { source: "none" } });
  });

  it("非网关错误：没有可展示的说明，日志类别记 unknown", async () => {
    const { ports, logs } = memoryPorts({
      fetch: async () => ({
        status: 200,
        headers: {
          get: () => {
            throw new TypeError("boom");
          },
        },
        text: async () => "",
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    });
    const result = await refreshModels(ports, BASE, "sk", null);
    expect(result).toEqual({ ok: false, message: null, discovery: { source: "none" } });
    expect(logs[0].fields).toMatchObject({ ok: false, category: "unknown" });
  });
});
