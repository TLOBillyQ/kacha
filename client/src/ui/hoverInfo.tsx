// 悬浮信息的弹出层：光标停留约 400ms 后在光标旁弹只读浮层，移出即消失；
// 浮层在窗口坐标里渲染，不随画布缩放。内容由 core/hoverInfo 组装；嵌套时最内层的悬浮目标生效。
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactElement } from "react";
import { clampMenuPosition } from "../core/contextMenu";
import type { HoverInfo } from "../core/hoverInfo";

export const HOVER_DELAY_MS = 400;
/** 浮层相对光标的偏移。 */
const OFFSET = { x: 14, y: 18 };

export interface HoverController {
  /** 光标在某个悬浮目标上移动；key 标识目标，换目标即重新计时。空内容等同离开。 */
  move: (key: string, info: HoverInfo, x: number, y: number) => void;
  leave: (key: string) => void;
  hide: () => void;
}

type Shown = { info: HoverInfo; x: number; y: number };

const HoverContext = createContext<HoverController | null>(null);
export const HoverProvider = HoverContext.Provider;

/** 画布级：建控制器与浮层；按下指针、滚轮时收起。 */
export function useHoverLayer(): { controller: HoverController; layer: ReactElement | null } {
  const [shown, setShown] = useState<Shown | null>(null);
  const current = useRef<{ key: string; info: HoverInfo; x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const controller = useMemo<HoverController>(() => {
    const clearTimer = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    const hide = () => {
      clearTimer();
      current.current = null;
      setShown(null);
    };
    return {
      move: (key, info, x, y) => {
        if (!info.length) return hide();
        const same = current.current?.key === key;
        current.current = { key, info, x, y };
        if (same) return;
        clearTimer();
        setShown(null);
        timer.current = setTimeout(() => {
          timer.current = null;
          const target = current.current;
          if (target) setShown({ info: target.info, x: target.x, y: target.y });
        }, HOVER_DELAY_MS);
      },
      leave: (key) => {
        if (current.current?.key === key) hide();
      },
      hide,
    };
  }, []);

  useEffect(() => {
    window.addEventListener("pointerdown", controller.hide, true);
    window.addEventListener("wheel", controller.hide, true);
    window.addEventListener("blur", controller.hide);
    return () => {
      controller.hide();
      window.removeEventListener("pointerdown", controller.hide, true);
      window.removeEventListener("wheel", controller.hide, true);
      window.removeEventListener("blur", controller.hide);
    };
  }, [controller]);

  return { controller, layer: shown && <HoverLayer {...shown} /> };
}

function HoverLayer({ info, x, y }: Shown) {
  const ref = useRef<HTMLDivElement>(null);
  const at = { x: x + OFFSET.x, y: y + OFFSET.y };
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setPos(clampMenuPosition(at, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [x, y, info]);
  return (
    <div className="hover-info" role="tooltip" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {info.map((line, i) => (
        <div key={i} className={`hover-line${line.tone ? ` hover-${line.tone}` : ""}`}>
          {line.label && <span className="hover-label">{line.label}</span>}
          <span className={`hover-text${line.mono ? " mono" : ""}`} style={line.clamp ? { WebkitLineClamp: line.clamp } : undefined} data-clamp={line.clamp ? "" : undefined}>
            {line.text}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 同一次指针事件只交给最内层的悬浮目标（不阻止冒泡：拖动等依赖窗口级监听）。 */
const claimed = new WeakSet<Event>();

/** 把元素设为悬浮目标：返回要展开到元素上的指针事件；info 为 null / 空 = 不弹，但仍挡住外层目标。 */
export function useHover(info: HoverInfo | null): Pick<HTMLAttributes<HTMLElement>, "onPointerMove" | "onPointerLeave"> {
  const controller = useContext(HoverContext);
  const key = useId();
  const infoRef = useRef(info);
  infoRef.current = info;
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!controller || claimed.has(e.nativeEvent)) return;
      claimed.add(e.nativeEvent);
      // 按着键移动（拖动、框选）不弹。
      if (e.buttons !== 0) return controller.hide();
      controller.move(key, infoRef.current ?? [], e.clientX, e.clientY);
    },
    [controller, key],
  );
  const onPointerLeave = useCallback(() => controller?.leave(key), [controller, key]);
  return { onPointerMove, onPointerLeave };
}

/** 带悬浮信息的按钮；disabled 用 aria-disabled 表示（禁用的按钮收不到指针事件，悬浮不出原因），点击时不触发。 */
export function HoverButton({ info, disabled, onClick, ...rest }: { info: HoverInfo | null } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const hover = useHover(info);
  return <button {...rest} {...hover} aria-disabled={disabled || undefined} onClick={disabled ? (e) => e.preventDefault() : onClick} />;
}

export function HoverSpan({ info, ...rest }: { info: HoverInfo | null } & HTMLAttributes<HTMLSpanElement>) {
  const hover = useHover(info);
  return <span {...rest} {...hover} />;
}
