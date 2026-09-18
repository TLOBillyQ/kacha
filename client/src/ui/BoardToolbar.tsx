// 画板工具栏（顶部第二行左侧）：新建节点、撤销 / 重做、运行。只负责摆放与置灰；
// 有画板时由画布经 portal 渲染并接上动作，没有画板时由 App 渲染置灰占位（布局不跳）。
import type { ReactNode } from "react";
import { textHoverInfo } from "../core/hoverInfo";
import { HoverButton } from "./hoverInfo";

interface Props {
  /** 没有打开的画板：全部置灰。 */
  disabled?: boolean;
  /** 新建生成任务用的模型下拉；没有画板时为空。 */
  modelSelect?: ReactNode;
  onNewPrompt?: () => void;
  onAddReferences?: () => void;
  onNewTask?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  undoLabel?: string | null;
  redoLabel?: string | null;
  /** 当前选中节点数：> 0 时运行按钮写「运行选中」。 */
  selectedCount?: number;
  onRun?: () => void;
}

const NO_BOARD = "没有打开的画板";

export function BoardToolbar({ disabled = false, modelSelect, onNewPrompt, onAddReferences, onNewTask, onUndo, onRedo, undoLabel = null, redoLabel = null, selectedCount = 0, onRun }: Props) {
  const hint = (text: string) => textHoverInfo(disabled ? NO_BOARD : text);
  return (
    <div className="board-toolbar-left" role="toolbar" aria-label="画板工具栏">
      <div className="toolbar-group">
        <HoverButton disabled={disabled} onClick={onNewPrompt} info={hint("在视口中央新建一个提示词节点")}>
          ＋ 提示词
        </HoverButton>
        <HoverButton disabled={disabled} onClick={onAddReferences} info={hint("选择图片文件加为参考图节点")}>
          ＋ 参考图…
        </HoverButton>
        <span className="toolbar-pair">
          <HoverButton disabled={disabled} onClick={onNewTask} info={hint("用右侧模型在视口中央新建一个生成任务节点")}>
            ＋ 生成任务
          </HoverButton>
          {modelSelect ?? <select className="toolbar-model" disabled aria-label="新建任务模型" />}
        </span>
      </div>
      <div className="toolbar-group">
        <HoverButton onClick={onUndo} disabled={disabled || !undoLabel} info={hint(undoLabel ? `撤销 ${undoLabel}（Ctrl+Z）` : "没有可撤销的操作")} aria-label="撤销">
          ↶
        </HoverButton>
        <HoverButton onClick={onRedo} disabled={disabled || !redoLabel} info={hint(redoLabel ? `重做 ${redoLabel}（Ctrl+Shift+Z）` : "没有可重做的操作")} aria-label="重做">
          ↷
        </HoverButton>
      </div>
      <div className="toolbar-group">
        <HoverButton className="primary" disabled={disabled} onClick={onRun} info={hint("有选中时只运行选中子图，否则运行整个画板中需要运行的任务")}>
          ▶ 运行{selectedCount > 0 ? "选中" : ""}
        </HoverButton>
      </div>
    </div>
  );
}
