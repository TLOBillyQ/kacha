// 上下文菜单的弹出层：条目由 core/contextMenu 按对象给出，这里只负责摆放、置灰（悬浮给原因）与关闭（点外面 / Esc）。
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampMenuPosition, type BoardAction, type MenuItem } from "../core/contextMenu";
import { textHoverInfo } from "../core/hoverInfo";
import { HoverButton } from "./hoverInfo";

interface Props {
  /** 右键处的窗口坐标。 */
  at: { x: number; y: number };
  items: MenuItem[];
  onPick: (action: BoardAction) => void;
  onClose: () => void;
}

export function ContextMenu({ at, items, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(clampMenuPosition(at, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [at, items]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div className="context-menu" role="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item) => (
        <Fragment key={item.action}>
          {item.separatorBefore && <div className="context-menu-separator" role="separator" />}
          <HoverButton
            role="menuitem"
            disabled={item.disabledReason !== null}
            info={item.disabledReason ? textHoverInfo(item.disabledReason) : null}
            onClick={() => {
              onClose();
              onPick(item.action);
            }}
          >
            {item.label}
          </HoverButton>
        </Fragment>
      ))}
    </div>
  );
}
