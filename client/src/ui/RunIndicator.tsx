// 顶栏运行指示「执行 n · 排队 m」：点开小列表，可跳到对应画板与节点，或取消全部排队。不是任务中心。
import { useState } from "react";
import type { ActiveTask } from "./useRunner";

interface Props {
  active: ActiveTask[];
  titleOf: (boardKey: string) => string;
  onJump: (task: ActiveTask) => void;
  onCancelWaiting: () => void;
}

export function RunIndicator({ active, titleOf, onJump, onCancelWaiting }: Props) {
  const [open, setOpen] = useState(false);
  if (active.length === 0) return null;
  const running = active.filter((t) => t.state === "running").length;
  const waiting = active.length - running;
  return (
    <div className="run-indicator">
      <button onClick={() => setOpen((v) => !v)}>
        执行 {running} · 排队 {waiting}
      </button>
      {open && (
        <div className="run-list">
          <ul>
            {active.map((t) => (
              <li key={t.taskId}>
                <button
                  className="link"
                  onClick={() => {
                    setOpen(false);
                    onJump(t);
                  }}
                >
                  <span className={t.state === "running" ? "status status-running" : "status status-queued"}>{t.state === "running" ? "执行中" : "排队中"}</span>
                  {titleOf(t.boardKey)}
                  <span className="mono muted"> {t.taskId}</span>
                </button>
              </li>
            ))}
          </ul>
          <button disabled={waiting === 0} onClick={onCancelWaiting}>
            取消全部排队
          </button>
        </div>
      )}
    </div>
  );
}
