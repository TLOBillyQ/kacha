// 画板包（ADR 0013）的模态：导出前确认（含完整提示词、缺图清单）、可取消的进度、导入后的冲突清单。
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { ExportPlan } from "../core/boardPack";

export type PackDialogState =
  | { stage: "confirmExport"; boardFile: string; plan: ExportPlan }
  | { stage: "progress"; title: string }
  | { stage: "importDone"; message: string; conflicts: string[] };

interface Props {
  state: PackDialogState;
  onExport: () => void;
  onCancelProgress: () => void;
  onClose: () => void;
}

const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function Progress({ title, onCancel }: { title: string; onCancel: () => void }) {
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    const unlisten = listen<{ done: number; total: number }>("board-pack-progress", (e) => setProgress(e.payload));
    return () => void unlisten.then((fn) => fn());
  }, []);
  return (
    <>
      <div className="modal-head">
        <strong>{title}</strong>
      </div>
      <progress className="pack-progress" value={progress.done} max={progress.total || 1} />
      <div className="muted small">{progress.total ? `${formatSize(progress.done)} / ${formatSize(progress.total)}` : "准备中…"}</div>
      <div className="modal-foot">
        <button
          disabled={cancelling}
          onClick={() => {
            setCancelling(true);
            onCancel();
          }}
        >
          {cancelling ? "正在取消…" : "取消"}
        </button>
      </div>
    </>
  );
}

export function BoardPackDialog({ state, onExport, onCancelProgress, onClose }: Props) {
  // 进度中不响应点背景关闭：只能点「取消」。
  const dismiss = state.stage === "progress" ? undefined : onClose;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && dismiss?.()}>
      <div className="modal" role="dialog" aria-label="画板包">
        {state.stage === "progress" && <Progress title={state.title} onCancel={onCancelProgress} />}
        {state.stage === "confirmExport" && (
          <>
            <div className="modal-head">
              <strong>导出画板包：{state.boardFile}</strong>
            </div>
            <div>
              将打包画板与它引用的 {state.plan.taskDirs.length} 个任务目录
              {state.plan.files.length > 0 && `、${state.plan.files.length} 张参考图`}。
            </div>
            <div className="badge-warn">包含完整提示词与任务记录，不脱敏；请只发给可信的人。</div>
            {state.plan.missing.length > 0 && (
              <>
                <div>以下 {state.plan.missing.length} 张图片缺失，导出后在导入端仍为缺图占位：</div>
                <ul className="error-list">
                  {state.plan.missing.map((m) => (
                    <li key={m.nodeId} className="mono">
                      {m.path}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="modal-foot">
              <button onClick={onClose}>取消</button>
              <button className="primary" onClick={onExport}>
                {state.plan.missing.length ? "仍然导出…" : "选择位置并导出…"}
              </button>
            </div>
          </>
        )}
        {state.stage === "importDone" && (
          <>
            <div className="modal-head">
              <strong>{state.message}</strong>
            </div>
            <div>以下内容与本机已有的不一致，已跳过、未覆盖：</div>
            <ul className="error-list">
              {state.conflicts.map((c) => (
                <li key={c} className="mono">
                  {c}
                </li>
              ))}
            </ul>
            <div className="modal-foot">
              <button className="primary" onClick={onClose}>
                知道了
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
