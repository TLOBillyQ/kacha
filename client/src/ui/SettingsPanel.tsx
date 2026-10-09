// 高级设置模态面板：网关地址、API 密钥、连接测试、输出根目录、并发上限、检查更新、诊断包导出。
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import {
  DEFAULT_SETTINGS,
  isPlainHttp,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  normalizeBaseUrl,
  validateBaseUrl,
  type Settings,
} from "../core/settings";
import type { OperationGate } from "../core/updatePreparation";
import { DiagnosticsSection } from "./DiagnosticsSection";
import type { ConnectionResult, useSettings } from "./useSettings";
import type { useUpdateCheck } from "./useUpdateCheck";

interface Props {
  settings: ReturnType<typeof useSettings>;
  /** 当前生效的输出根目录（含默认值）。 */
  outputRoot: string;
  defaultOutputRoot: string;
  /** 当前打开的画板路径，诊断包可勾选带上。 */
  openBoards: string[];
  /** 有排队 / 执行中的任务时不允许切换输出根目录。 */
  busy: boolean;
  gate?: OperationGate;
  /** 输出根目录变了：由调用方关闭标签页并切换。 */
  onOutputRootChange: (root: string) => Promise<void>;
  update: ReturnType<typeof useUpdateCheck>;
  onClose: () => void;
}

export function SettingsPanel({ settings, outputRoot, defaultOutputRoot, openBoards, busy, gate, onOutputRootChange, update, onClose }: Props) {
  const [baseUrl, setBaseUrl] = useState(settings.settings.base_url);
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [showKey, setShowKey] = useState(false);
  const [root, setRoot] = useState(outputRoot);
  const [concurrency, setConcurrency] = useState(settings.settings.concurrency);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 版本号唯一来源是 Cargo.toml（tauri.conf.json 不写 version 即沿用），经 Tauri 读出。
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void getVersion().then(setVersion, () => undefined);
  }, []);

  const urlError = validateBaseUrl(baseUrl);
  const rootChanged = root !== outputRoot;
  const readOnly = settings.file === "newer";
  const { discovery } = settings;

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    setTestResult(await settings.testConnection(normalizeBaseUrl(baseUrl), apiKey));
    setTesting(false);
  };

  const pickRoot = async () => {
    const picked = await open({ directory: true, defaultPath: root });
    if (typeof picked === "string") setRoot(picked);
  };

  const submitWork = async () => {
    if (urlError || (rootChanged && busy)) return;
    setSaving(true);
    setError(null);
    const next: Settings = {
      ...settings.settings,
      base_url: normalizeBaseUrl(baseUrl),
      output_root: root === defaultOutputRoot ? null : root,
      concurrency,
    };
    const problem = await settings.save(next, apiKey.trim());
    if (problem) {
      setError(problem);
      setSaving(false);
      return;
    }
    if (rootChanged && !readOnly) await onOutputRootChange(root);
    setSaving(false);
    onClose();
  };

  const submit = () => {
    if (gate?.blocked()) return;
    const work = submitWork();
    gate?.track(work);
    return work;
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="高级设置">
        <div className="modal-head">
          <strong>高级设置</strong>
          {version && <span className="muted small">版本 {version}</span>}
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>
        {settings.fileProblem && <div className="notice notice-warn">{settings.fileProblem}</div>}

        <label className="form-row">
          <span>网关基础地址</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={DEFAULT_SETTINGS.base_url} spellCheck={false} />
        </label>
        {urlError && <div className="form-error">{urlError}</div>}
        {!urlError && isPlainHttp(baseUrl) && (
          <div className="notice notice-warn">明文 HTTP：密钥与图片不加密传输，仅限可信内网使用。</div>
        )}

        <label className="form-row">
          <span>API 密钥</span>
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="link" onClick={() => setShowKey((v) => !v)}>
            {showKey ? "隐藏" : "显示"}
          </button>
        </label>
        {settings.keyPersistence === "session" && <div className="notice notice-warn">系统凭据库不可用：密钥未持久化，重启需重填。</div>}

        <div className="form-row">
          <span>连接测试</span>
          <button onClick={() => void test()} disabled={testing || !!urlError || !apiKey.trim()}>
            {testing ? "测试中…" : "测试连接并刷新模型"}
          </button>
          {testResult && (
            <span className={testResult.ok ? "ok-text" : "form-error"}>
              {testResult.ok ? `连接成功，网关提供 ${testResult.count} 个模型` : testResult.message}
            </span>
          )}
        </div>
        <div className="muted small form-hint">
          {discovery.source === "live" && `模型列表：已从网关获取（${new Date(discovery.fetchedAt).toLocaleString()}）`}
          {discovery.source === "cached" && `模型列表：离线，使用缓存（${new Date(discovery.fetchedAt).toLocaleString()}）`}
          {discovery.source === "none" && "模型列表：尚未从网关获取，暂按上架清单显示"}
        </div>

        <div className="form-row">
          <span>输出根目录</span>
          <input value={root} readOnly className="mono" title={root} />
          <button onClick={() => void pickRoot()} disabled={busy}>
            选择…
          </button>
          {root !== defaultOutputRoot && (
            <button className="link" onClick={() => setRoot(defaultOutputRoot)} disabled={busy}>
              恢复默认
            </button>
          )}
        </div>
        {busy && <div className="muted small form-hint">有任务在排队或执行，或正在准备更新，暂不能切换输出根目录。</div>}
        {rootChanged && <div className="notice notice-warn">切换不搬文件，新目录的画板列表为空；保存后会关闭当前打开的画板。</div>}

        <label className="form-row">
          <span>并发上限</span>
          <input
            type="number"
            min={MIN_CONCURRENCY}
            max={MAX_CONCURRENCY}
            value={concurrency}
            onChange={(e) => setConcurrency(Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(Number(e.target.value) || MIN_CONCURRENCY))))}
          />
          <span className="muted small">1～{MAX_CONCURRENCY}，默认 {DEFAULT_SETTINGS.concurrency}</span>
        </label>
        {concurrency > 5 && <div className="muted small form-hint">qwen 模型曾在 6 个以上并发时触发网关限流；限流时整条队列会暂停等待。</div>}

        <div className="form-row">
          <span>检查更新</span>
          <button onClick={() => void update.check().catch(() => undefined)} disabled={update.checking}>
            {update.checking ? "检查中…" : "检查更新"}
          </button>
          {update.state.phase === "ready" && (
            <span className="ok-text">
              已就绪 {update.state.version}，
              <button className="link" onClick={() => void update.requestInstall()}>
                重启并更新
              </button>
            </span>
          )}
          {update.state.phase === "downloading" && (
            <span className="muted small">
              下载中 {update.state.progress ? `${update.state.progress.done}/${update.state.progress.total ?? "?"} bytes` : "…"}
            </span>
          )}
          {update.state.phase === "preparing" && <span>正在准备更新…</span>}
          {update.state.phase === "installing" && <span>正在安装更新…</span>}
          {update.state.phase === "idle" && <span className="muted small">已是最新版本</span>}
          {update.state.phase === "error" && (
            <span className="form-error">
              {update.state.error}
              <button className="link" onClick={() => void update.check().catch(() => undefined)}>
                重试
              </button>
            </span>
          )}
          {update.state.installBlockedReason && <span className="muted small">{update.state.installBlockedReason}</span>}
          {update.state.phase === "ready" && update.state.error && <span className="form-error">{update.state.error}</span>}
          {update.state.error && <button className="link" onClick={update.openDownload}>手动下载</button>}
        </div>
        {update.state.version && update.state.notes && <div className="muted small form-hint">更新说明：{update.state.notes}</div>}
        <div className="muted small form-hint">发现新版自动后台下载；就绪后由你点击重启并更新，不会自动安装或重启。</div>

        <DiagnosticsSection outputRoot={outputRoot} openBoards={openBoards} />

        {error && <div className="form-error">{error}</div>}
        <div className="modal-foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void submit()} disabled={saving || !!urlError}>
            {readOnly ? "仅保存密钥" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
