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
          <button onClick={() => onCopy(item.sendText)} disabled={!item.sendText}>
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
    </>
  );
}

/** 完整发送文本；负向走原生字段的模型另起一段（拼进文本的已在 sendText 里）。 */
export function SendTextBody({ item }: { item: ConfirmItem }) {
  return (
    <>
      <pre className="send-text">{item.sendText || <span className="muted">（无提示词）</span>}</pre>
      {!item.negativeInlined && item.negativePrompt && <pre className="send-text">负向：{item.negativePrompt}</pre>}
    </>
  );
}
