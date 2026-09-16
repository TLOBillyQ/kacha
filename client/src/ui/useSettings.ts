// 高级设置的加载 / 保存、API 密钥（系统凭据库，不可用时只在会话内存）、模型发现（规格第 12 节）。
import { useCallback, useEffect, useRef, useState } from "react";
import { GatewayError, listModels } from "../core/gateway";
import {
  DEFAULT_SETTINGS,
  discoveryFromCache,
  normalizeBaseUrl,
  parseModelsCache,
  parseSettings,
  serializeModelsCache,
  serializeSettings,
  type Discovery,
  type LoadedSettings,
  type ModelsCache,
  type Settings,
} from "../core/settings";
import { httpFetch, ipc } from "../shell/ipc";

/** persisted = 已存入系统凭据库；session = 凭据库不可用，只在本次运行的内存里。 */
export type KeyPersistence = "persisted" | "session";

export type ConnectionResult = { ok: true; count: number } | { ok: false; message: string };

export interface SettingsState {
  loaded: boolean;
  /** 文件状态：newer 时禁止保存，corrupt 时提示已用默认值。 */
  file: LoadedSettings["kind"];
  fileProblem: string | null;
  settings: Settings;
  apiKey: string;
  keyPersistence: KeyPersistence;
  discovery: Discovery;
}

export function useSettings() {
  const [state, setState] = useState<SettingsState>({
    loaded: false,
    file: "ok",
    fileProblem: null,
    settings: DEFAULT_SETTINGS,
    apiKey: "",
    keyPersistence: "persisted",
    discovery: { source: "none" },
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const cacheRef = useRef<ModelsCache | null>(null);

  const refreshModels = useCallback(async (baseUrl: string, apiKey: string): Promise<ConnectionResult> => {
    try {
      const ids = await listModels({ baseUrl, apiKey, fetch: httpFetch });
      const cache: ModelsCache = { base_url: normalizeBaseUrl(baseUrl), fetched_at: new Date().toISOString(), model_ids: ids };
      cacheRef.current = cache;
      await ipc.writeModelsCache(serializeModelsCache(cache)).catch(() => undefined);
      setState((s) => ({ ...s, discovery: { source: "live", ids, fetchedAt: cache.fetched_at } }));
      return { ok: true, count: ids.length };
    } catch (e) {
      setState((s) => ({ ...s, discovery: discoveryFromCache(cacheRef.current, baseUrl) }));
      return { ok: false, message: e instanceof GatewayError ? e.message : "连接测试失败" };
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const loaded = parseSettings(await ipc.readSettings().catch(() => null));
      cacheRef.current = parseModelsCache(await ipc.readModelsCache().catch(() => null));
      let apiKey = "";
      let keyPersistence: KeyPersistence = "persisted";
      try {
        apiKey = (await ipc.secretGet()) ?? "";
      } catch {
        keyPersistence = "session";
      }
      const settings = loaded.settings;
      setState({
        loaded: true,
        file: loaded.kind,
        fileProblem:
          loaded.kind === "newer"
            ? `settings.json 由更新版本的工具写入（format_version ${loaded.version}），本次使用默认设置且不会覆盖该文件`
            : loaded.kind === "corrupt"
              ? `settings.json 已损坏（${loaded.reason}），本次使用默认设置`
              : null,
        settings,
        apiKey,
        keyPersistence,
        discovery: discoveryFromCache(cacheRef.current, settings.base_url),
      });
      // 启动时静默刷新一次；失败保持缓存。
      if (apiKey) void refreshModels(settings.base_url, apiKey);
    })();
  }, [refreshModels]);

  /** 保存设置与密钥；返回错误说明，成功为 null。 */
  const save = useCallback(async (next: Settings, apiKey: string): Promise<string | null> => {
    const current = stateRef.current;
    // 更新版本写入的 settings.json 不覆盖，但密钥仍可保存。
    const readOnly = current.file === "newer";
    if (!readOnly) {
      try {
        await ipc.writeSettings(serializeSettings(next));
      } catch (e) {
        return `保存设置失败：${e instanceof Error ? e.message : String(e)}`;
      }
    }
    let keyPersistence: KeyPersistence = "persisted";
    if (apiKey !== current.apiKey || current.keyPersistence === "session") {
      try {
        if (apiKey) await ipc.secretSet(apiKey);
        else await ipc.secretDelete();
      } catch {
        keyPersistence = "session";
      }
    }
    if (readOnly) {
      setState((s) => ({ ...s, apiKey, keyPersistence }));
      return null;
    }
    const baseChanged = normalizeBaseUrl(next.base_url) !== normalizeBaseUrl(current.settings.base_url);
    setState((s) => ({
      ...s,
      file: "ok",
      fileProblem: null,
      settings: next,
      apiKey,
      keyPersistence,
      discovery: baseChanged ? discoveryFromCache(cacheRef.current, next.base_url) : s.discovery,
    }));
    return null;
  }, []);

  return { ...state, save, testConnection: refreshModels };
}
