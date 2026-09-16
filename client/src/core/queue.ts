// 任务队列（规格第 8 节）：全局一条，跨画板按提交顺序 FIFO；并发上限内派发。
// 纯状态机，时间由调用方传入；队列只认任务编号，画板与节点归属在界面层。

export interface QueueState {
  /** 等待派发，队首在前。 */
  waiting: string[];
  running: string[];
  /** 每个任务已自动重试的次数（仅 429）。 */
  retries: Record<string, number>;
  /** 429 退避期间整条队列暂停派发，到此刻（毫秒）恢复；0 = 未暂停。 */
  pausedUntil: number;
}

/** 第 1、2、3 次 429 后的等待；第 4 次按失败。 */
export const BACKOFF_MS = [30_000, 60_000, 120_000];

export function emptyQueue(): QueueState {
  return { waiting: [], running: [], retries: {}, pausedUntil: 0 };
}

export function enqueue(q: QueueState, ids: string[]): QueueState {
  return { ...q, waiting: [...q.waiting, ...ids] };
}

/** 从队首派发，直到执行数达到并发上限。 */
export function dispatch(q: QueueState, now: number, limit: number): { queue: QueueState; started: string[] } {
  if (now < q.pausedUntil) return { queue: q, started: [] };
  const free = Math.max(0, limit - q.running.length);
  const started = q.waiting.slice(0, free);
  if (started.length === 0) return { queue: q, started };
  return { queue: { ...q, waiting: q.waiting.slice(started.length), running: [...q.running, ...started] }, started };
}

/** 执行结束（成功、失败或已取消）。 */
export function complete(q: QueueState, id: string): QueueState {
  const { [id]: _, ...retries } = q.retries;
  return { ...q, running: q.running.filter((x) => x !== id), retries };
}

export type RateLimitOutcome = { kind: "retry"; retryAt: number } | { kind: "failed" };

/**
 * 执行中的任务收到 429：回队首（排在已在退避的任务之后），整队暂停到最晚的恢复时刻；
 * 已重试 3 次则按失败出队。
 */
export function rateLimited(q: QueueState, id: string, now: number): { queue: QueueState; outcome: RateLimitOutcome } {
  const attempt = q.retries[id] ?? 0;
  const running = q.running.filter((x) => x !== id);
  if (attempt >= BACKOFF_MS.length) {
    return { queue: complete({ ...q, running }, id), outcome: { kind: "failed" } };
  }
  const pausedUntil = Math.max(q.pausedUntil, now + BACKOFF_MS[attempt]);
  let head = 0;
  while (head < q.waiting.length && q.retries[q.waiting[head]] !== undefined) head++;
  const waiting = [...q.waiting.slice(0, head), id, ...q.waiting.slice(head)];
  return {
    queue: { waiting, running, retries: { ...q.retries, [id]: attempt + 1 }, pausedUntil },
    outcome: { kind: "retry", retryAt: pausedUntil },
  };
}

export function cancel(q: QueueState, id: string): { queue: QueueState; was: "waiting" | "running" | null } {
  if (q.waiting.includes(id)) {
    const { [id]: _, ...retries } = q.retries;
    return { queue: { ...q, waiting: q.waiting.filter((x) => x !== id), retries }, was: "waiting" };
  }
  if (q.running.includes(id)) return { queue: complete(q, id), was: "running" };
  return { queue: q, was: null };
}

/** 运行指示「取消全部排队」：执行中的不受影响。 */
export function cancelWaiting(q: QueueState): { queue: QueueState; cancelled: string[] } {
  const cancelled = q.waiting;
  const retries = Object.fromEntries(Object.entries(q.retries).filter(([id]) => !cancelled.includes(id)));
  return { queue: { ...q, waiting: [], retries }, cancelled };
}
