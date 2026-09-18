// 任务运行器的 React 接线：创建运行器并拼真适配器，订阅快照，把并发上限同步进去。编排本身在 core/runner.ts（ADR 0015）。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRunner, type Runner, type RunnerChange } from "../core/runner";
import { httpFetch, ipc } from "../shell/ipc";
import { imageCodec } from "../shell/imageCodec";
import { logEvent } from "../shell/log";
import { composeOverlay } from "../shell/overlay";

export function useRunner(apply: (boardKey: string, change: RunnerChange) => unknown, concurrency: number) {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const [runner] = useState<Runner>(() =>
    createRunner({
      deps: {
        readBytes: ipc.readFileBytes,
        writeNewFile: ipc.writeNewFile,
        fetch: httpFetch,
        now: () => new Date(),
        schedule: (ms, fn) => {
          const timer = setTimeout(fn, ms);
          return () => clearTimeout(timer);
        },
        composeOverlay,
        imageCodec,
      },
      apply: (boardKey, change) => void applyRef.current(boardKey, change),
      log: logEvent,
      concurrency,
    }),
  );
  const snapshot = useSyncExternalStore(runner.subscribe, runner.getSnapshot);
  // 并发上限调大后立即补派发。
  useEffect(() => runner.setConcurrency(concurrency), [runner, concurrency]);
  return { runner, snapshot };
}
