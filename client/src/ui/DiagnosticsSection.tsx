// 诊断包导出：默认含日志、清单、脱敏设置与能力覆盖文件；画板与任务目录 JSON 含提示词，需逐项勾选。
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { ipc, type PackageEntry } from "../shell/ipc";
import { logEvent } from "../shell/log";

const formatSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export function DiagnosticsSection({ outputRoot, openBoards }: { outputRoot: string; openBoards: string[] }) {
  const [entries, setEntries] = useState<PackageEntry[] | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    ipc
      .diagnosticsPreview(outputRoot, openBoards)
      .then((list) => alive && setEntries(list))
      .catch((e) => alive && setResult({ ok: false, message: `无法列出诊断包内容：${String(e)}` }));
    return () => {
      alive = false;
    };
      // openBoards 只在展开时取一次快照。
  }, [expanded, outputRoot]);

  const toggle = (name: string) =>
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const exportPackage = async () => {
    const picked = await save({ defaultPath: `kacha-diagnostics-${stamp(new Date())}.zip`, filters: [{ name: "诊断包", extensions: ["zip"] }] });
    if (!picked) return;
    const target = picked.toLowerCase().endsWith(".zip") ? picked : `${picked}.zip`;
    setExporting(true);
    setResult(null);
    try {
      const packed = await ipc.diagnosticsExport(outputRoot, openBoards, target, [...included]);
      // 字段名不能含 prompt：日志会把提示词类字段整体脱敏。
      logEvent("system", { message: "导出诊断包", files: packed.length, optional_files: packed.filter((e) => e.optional).length });
      setResult({ ok: true, message: `已导出 ${packed.length} 个文件到 ${target}` });
    } catch (e) {
      logEvent("system", { message: "导出诊断包失败", reason: String(e) });
      setResult({ ok: false, message: `导出失败：${String(e)}` });
    } finally {
      setExporting(false);
    }
  };

  const required = entries?.filter((e) => !e.optional) ?? [];
  const optional = entries?.filter((e) => e.optional) ?? [];

  return (
    <div className="diagnostics">
      <div className="form-row">
        <span>诊断包</span>
        <button className="link" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起" : "导出诊断包…"}
        </button>
      </div>
      {expanded && (
        <>
          <div className="muted small form-hint">用于反馈问题。导出时再做一次脱敏：不含 API 密钥、认证头、临时下载地址与图片内容。</div>
          {entries === null ? (
            !result && <div className="muted small form-hint">正在列出…</div>
          ) : (
            <ul className="diagnostics-list">
              {required.map((e) => (
                <li key={e.name}>
                  <input type="checkbox" checked disabled />
                  <span className="mono">{e.name}</span>
                  <span className="muted small">
                    {e.description} · {formatSize(e.size)}
                  </span>
                </li>
              ))}
              {optional.length > 0 && <li className="muted small">以下内容含提示词，默认不打包，需要时逐项勾选：</li>}
              {optional.map((e) => (
                <li key={e.name}>
                  <input type="checkbox" checked={included.has(e.name)} onChange={() => toggle(e.name)} />
                  <span className="mono">{e.name}</span>
                  {e.contains_prompt && <span className="badge-warn small">含提示词</span>}
                  <span className="muted small">
                    {e.description} · {formatSize(e.size)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="form-row">
            <span />
            <button onClick={() => void exportPackage()} disabled={exporting || entries === null}>
              {exporting ? "导出中…" : included.size ? `导出（含 ${included.size} 项含提示词内容）` : "导出"}
            </button>
          </div>
          {result && <div className={result.ok ? "ok-text small" : "form-error"}>{result.message}</div>}
        </>
      )}
    </div>
  );
}
