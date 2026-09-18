// 「查看发送文本」：只读展示单个任务当前会发给模型的内容，与二次确认同源（同一 ConfirmItem）。
import type { ConfirmItem } from "../core/submission";

interface Props {
  item: ConfirmItem;
  onCopy: (text: string) => void;
  onClose: () => void;
}

export function SendTextDialog({ item, onCopy, onClose }: Props) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-label="查看发送文本">
        <div className="modal-head">
          <strong>查看发送文本（{item.modelName}）</strong>
        </div>
        <ItemProblems item={item} />
        <SendTextBody item={item} />
        <div className="modal-foot">
          <button onClick={() => onCopy(item.send?.text ?? "")} disabled={!item.send?.text}>
            复制
          </button>
          <button className="primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** 标红原因与黄色提示；二次确认逐项复用。 */
export function ItemProblems({ item }: { item: ConfirmItem }) {
  return (
    <>
      {item.issues.length > 0 && (
        <ul className="error-list">
          {item.issues.map((issue) => (
            <li key={`${issue.kind}:${issue.text}`}>{issue.text}</li>
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
    </>
  );
}

/** 发送计划的发送文本；负向走原生字段时另起一段（拼进文本的已在发送文本里）。模型不可用时没有发送计划。 */
export function SendTextBody({ item }: { item: ConfirmItem }) {
  const { send } = item;
  if (!send) return <pre className="send-text"><span className="muted">模型不可用，无法生成发送文本</span></pre>;
  return (
    <>
      <pre className="send-text">{send.text || <span className="muted">（无提示词）</span>}</pre>
      {send.nativeNegativePrompt && <pre className="send-text">负向：{send.nativeNegativePrompt}</pre>}
    </>
  );
}
