// 高级设置的 React 接线：载入 / 保存 / 模型刷新的规则在 core/settings.ts（#128），这里只映射成 React 状态与提示文案，并在载入后静默刷新一次模型。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  discoveryFromCache,
  loadSettings,
  normalizeBaseUrl,
  refreshModels as refreshModelsWith,
  saveSettings,
  type Discovery,
  type KeyPersistence,
  type LoadedSettings,
  type ModelsCache,
  type Settings,
} from "../core/settings";
import { settingsPorts } from "../shell/adapters";

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

function fileProblemOf(loaded: LoadedSettings): string | null {
  if (loaded.kind === "newer") return `settings.json 由更新版本的工具写入（format_version ${loaded.version}），本次使用默认设置且不会覆盖该文件`;
  if (loaded.kind === "corrupt") return `settings.json 已损坏（${loaded.reason}），本次使用默认设置`;
  return null;
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
    const result = await refreshModelsWith(settingsPorts, baseUrl, apiKey, cacheRef.current);
    if (result.ok) cacheRef.current = result.cache;
    setState((s) => ({ ...s, discovery: result.discovery }));
    return result.ok ? { ok: true, count: result.cache.model_ids.length } : { ok: false, message: result.message ?? "连接测试失败" };
  }, []);

  useEffect(() => {
    void (async () => {
      const { file, apiKey, keyPersistence, cache } = await loadSettings(settingsPorts);
      cacheRef.current = cache;
      const settings = file.settings;
      setState({
        loaded: true,
        file: file.kind,
        fileProblem: fileProblemOf(file),
        settings,
        apiKey,
        keyPersistence,
        discovery: discoveryFromCache(cache, settings.base_url),
      });
      // 启动时静默刷新一次；失败保持缓存。
      if (apiKey) void refreshModels(settings.base_url, apiKey);
    })();
  }, [refreshModels]);

  /** 保存设置与密钥；返回错误说明，成功为 null。 */
  const save = useCallback(async (next: Settings, apiKey: string): Promise<string | null> => {
    const current = stateRef.current;
    const result = await saveSettings(settingsPorts, { fileKind: current.file, apiKey: current.apiKey, keyPersistence: current.keyPersistence }, next, apiKey);
    if (!result.ok) return `保存设置失败：${result.error}`;
    const { keyPersistence } = result;
    // 更新版本写入的 settings.json 没被覆盖：界面上的设置保持不变，只更新密钥。
    if (!result.settingsWritten) {
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
