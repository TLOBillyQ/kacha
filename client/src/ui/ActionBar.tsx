// 悬浮动作条（规格 4.1「悬浮动作条」）：图片节点上方一排图标动作，条目由 core/contextMenu 的 actionBarItems 给出，
// 与上下文菜单同一组 action 与置灰原因；由画布放进 NodeToolbar，固定屏幕像素、不随缩放。
import type { BoardAction, MenuItem } from "../core/contextMenu";
import { actionHoverInfo } from "../core/hoverInfo";
import { HoverButton } from "./hoverInfo";

const ICONS: Partial<Record<BoardAction, string>> = {
  preview: "⤢",
  continueEditing: "✎",
  addAsReference: "⊕",
  generateVariant: "↻",
};

interface Props {
  items: MenuItem[];
  onPick: (action: BoardAction) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

export function ActionBar({ items, onPick, onPointerEnter, onPointerLeave }: Props) {
  return (
    <div className="action-bar nodrag nopan" role="toolbar" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      {items.map((item) => (
        <HoverButton
          key={item.action}
          className="icon"
          aria-label={item.label}
          disabled={item.disabledReason !== null}
          info={actionHoverInfo(item)}
          onClick={() => onPick(item.action)}
        >
          {ICONS[item.action] ?? item.label}
        </HoverButton>
      ))}
    </div>
  );
}
