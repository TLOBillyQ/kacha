// 「运行」二次确认（规格第 3.3 节）：逐项列模型、提示词首行、可展开的完整发送文本；标红项列原因且不可勾选；黄色提示不阻断。
import { useState } from "react";
import type { ConfirmItem } from "../core/submission";

interface Props {
  items: ConfirmItem[];
  /** 选中子图还是整个画板。 */
  scope: "selection" | "board";
  onConfirm: (taskIds: string[]) => void;
  onCancel: () => void;
}

export function RunConfirmDialog({ items, scope, onConfirm, onCancel }: Props) {
  const [checked, setChecked] = useState(() => new Set(items.filter((i) => i.issues.length === 0).map((i) => i.taskId)));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const blocked = items.filter((i) => i.issues.length > 0).length;
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal-wide" role="dialog" aria-label="确认运行">
        <div className="modal-head">
          <strong>确认运行（{scope === "selection" ? "选中子图" : "整个画板"}）</strong>
        </div>
        {items.length === 0 ? (
          <div className="empty-small">没有需要运行的任务：任务都已执行且未修改，或正在排队 / 执行。</div>
        ) : (
          <ul className="confirm-list">
            {items.map((item, index) => {
              const bad = item.issues.length > 0;
              const open = expanded.has(item.taskId);
              return (
                <li key={item.taskId} className={bad ? "confirm-bad" : ""}>
                  <label className="confirm-head">
                    <input
                      type="checkbox"
                      disabled={bad}
                      checked={!bad && checked.has(item.taskId)}
                      onChange={() => setChecked((s) => toggle(s, item.taskId))}
                    />
                    <span className="muted">#{index + 1}</span>
                    <strong>{item.modelName}</strong>
                    <span className="confirm-line">{item.firstLine || <span className="muted">（无提示词）</span>}</span>
                    {item.referenceCount > 0 && <span className="badge">{item.referenceCount} 张参考图</span>}
                  </label>
                  {bad && (
                    <ul className="error-list">
                      {item.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  )}
                  {item.warnings.length > 0 && (
                    <ul className="warn-list">
                      {item.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                  <button className="link small" onClick={() => setExpanded((s) => toggle(s, item.taskId))}>
                    {open ? "收起发送文本" : "展开完整发送文本"}
                  </button>
                  {open && (
                    <>
                      <pre className="send-text">{item.sendText}</pre>
                      {item.referenceCount === 0 && item.negativePrompt && <pre className="send-text">负向：{item.negativePrompt}</pre>}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="modal-foot">
          <span className="muted">
            共 {items.length} 个任务，已勾选 {checked.size}
            {blocked > 0 && `，${blocked} 个不可运行`}
          </span>
          <button onClick={onCancel}>取消</button>
          <button className="primary" disabled={checked.size === 0} onClick={() => onConfirm(items.filter((i) => checked.has(i.taskId)).map((i) => i.taskId))}>
            运行 {checked.size} 个任务
          </button>
        </div>
      </div>
    </div>
  );
}
