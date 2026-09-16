// 运行编排：提交（内存快照）→ 全局队列按并发上限派发（写任务目录 + last_submitted → 调网关）→ 结果节点落到画板。
// 队列跨画板 FIFO；429 自动退避重试，其余错误不重试。状态只在内存，不持久化。
import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, TaskNode } from "../core/board";
import type { CapabilityTable } from "../core/capabilities";
import { GatewayError } from "../core/gateway";
import * as Q from "../core/queue";
import { CancelledError, executeJob, failureLabel, prepareJob, prepareRegenerate, writeJob, type PreparedJob, type RunDeps, type TaskStatus } from "../core/run";
import { tableDigest } from "../core/taskDir";
import { httpFetch, ipc } from "../shell/ipc";

const deps: RunDeps = {
  readBytes: ipc.readFileBytes,
  writeNewFile: ipc.writeNewFile,
  fetch: httpFetch,
  now: () => new Date(),
};

export interface RunTarget {
  boardKey: string;
  table: CapabilityTable;
  outputRoot: string;
  baseUrl: string;
  apiKey: string;
}

export interface RunRequest extends RunTarget {
  taskIds: string[];
  /** 二次确认时的画板：按用户确认的内容提交，确认框打开期间的编辑不混进来。 */
  board: Board;
}

/** 已入队的一次提交。 */
interface QueuedSubmission {
  target: RunTarget;
  job: PreparedJob;
  /** 派发时写到画板任务节点上。 */
  lastSubmitted: TaskNode["last_submitted"];
  /** 任务目录已写、last_submitted 已落地（429 重试不再写）。 */
  written: boolean;
  controller: AbortController;
}

/** 运行指示里的一行。 */
export interface ActiveTask {
  taskId: string;
  boardKey: string;
  taskNodeId: string;
  state: "running" | "waiting";
}

/** 占着队列（排队、执行、退避）的状态；这些任务节点运行时锁定。 */
export function isActive(status: TaskStatus | null | undefined): boolean {
  return status?.kind === "queued" || status?.kind === "running" || status?.kind === "backoff";
}

export function useRunner(boards: { getBoard: (key: string) => Board | null; updateBoard: (key: string, fn: (b: Board) => Board) => void }, concurrency: number) {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, TaskStatus>>(new Map());
  const [active, setActive] = useState<ActiveTask[]>([]);
  const queue = useRef(Q.emptyQueue());
  const entries = useRef(new Map<string, QueuedSubmission>());
  /** 正在读参考图、还没入队的任务节点（画板 key + 节点 id）；取消时打标记，读完不入队。 */
  const preparing = useRef(new Map<string, { boardKey: string; cancelled: boolean }>());
  /** 本次程序运行期间经手过的提交，用于推导「已中断」。 */
  const handled = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const boardsRef = useRef(boards);
  boardsRef.current = boards;
  const limit = useRef(concurrency);
  limit.current = concurrency;

  const setStatus = useCallback((taskNodeId: string, status: TaskStatus | null) => {
    setStatuses((m) => {
      const next = new Map(m);
      if (status) next.set(taskNodeId, status);
      else next.delete(taskNodeId);
      return next;
    });
  }, []);

  const publish = useCallback(() => {
    const q = queue.current;
    const row = (state: ActiveTask["state"]) => (taskId: string) => {
      const e = entries.current.get(taskId)!;
      return { taskId, boardKey: e.target.boardKey, taskNodeId: e.job.taskNodeId, state };
    };
    setActive([...q.running.map(row("running")), ...q.waiting.map(row("waiting"))]);
  }, []);

  const pumpRef = useRef<() => void>(() => undefined);

  const setLastSubmitted = useCallback((boardKey: string, taskNodeId: string, value: TaskNode["last_submitted"]) => {
    boardsRef.current.updateBoard(boardKey, (b) => ({
      ...b,
      nodes: b.nodes.map((n) => (n.id === taskNodeId && n.type === "task" ? { ...n, last_submitted: value } : n)),
    }));
  }, []);

  const execute = useCallback(
    async (taskId: string) => {
      const entry = entries.current.get(taskId)!;
      const { job, controller, target } = entry;
      setStatus(job.taskNodeId, { kind: "running", startedAt: Date.now() });
      let retrying = false;
      try {
        if (!entry.written) {
          entry.job = await writeJob(deps, target.outputRoot, job);
          entry.written = true;
          setLastSubmitted(target.boardKey, job.taskNodeId, entry.lastSubmitted);
        }
        if (controller.signal.aborted) return;
        const apply = await executeJob(deps, {
          job: entry.job,
          outputRoot: target.outputRoot,
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          newNodeId: crypto.randomUUID(),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        boardsRef.current.updateBoard(target.boardKey, apply);
        setStatus(job.taskNodeId, null);
        queue.current = Q.complete(queue.current, taskId);
      } catch (e) {
        if (controller.signal.aborted || e instanceof CancelledError) return;
        if (e instanceof GatewayError && e.category === "rate_limited") {
          const { queue: next, outcome } = Q.rateLimited(queue.current, taskId, Date.now());
          queue.current = next;
          retrying = outcome.kind === "retry";
          setStatus(job.taskNodeId, outcome.kind === "retry" ? { kind: "backoff", retryAt: outcome.retryAt } : { kind: "failed", label: failureLabel(e) });
        } else {
          queue.current = Q.complete(queue.current, taskId);
          setStatus(job.taskNodeId, { kind: "failed", label: failureLabel(e) });
        }
      } finally {
        if (!retrying && !controller.signal.aborted) entries.current.delete(taskId);
        pumpRef.current();
      }
    },
    [setStatus, setLastSubmitted],
  );

  const pump = useCallback(() => {
    clearTimeout(timer.current);
    const now = Date.now();
    const { queue: next, started } = Q.dispatch(queue.current, now, limit.current);
    queue.current = next;
    for (const id of started) void execute(id);
    if (next.waiting.length && now < next.pausedUntil) timer.current = setTimeout(pump, next.pausedUntil - now);
    publish();
  }, [execute, publish]);
  pumpRef.current = pump;

  // 并发上限调大后立即补派发。
  useEffect(() => pump(), [concurrency, pump]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const enqueue = useCallback(
    (target: RunTarget, prepared: { job: PreparedJob; board: Board }) => {
      const { job } = prepared;
      const submitted = prepared.board.nodes.find((n) => n.id === job.taskNodeId);
      handled.current.add(job.taskId);
      entries.current.set(job.taskId, {
        target,
        job,
        lastSubmitted: submitted?.type === "task" ? submitted.last_submitted : null,
        written: false,
        controller: new AbortController(),
      });
      queue.current = Q.enqueue(queue.current, [job.taskId]);
      pump();
    },
    [pump],
  );

  const occupied = (boardKey: string, taskNodeId: string) =>
    preparing.current.has(`${boardKey}\n${taskNodeId}`) || [...entries.current.values()].some((e) => e.target.boardKey === boardKey && e.job.taskNodeId === taskNodeId);

  /** 读参考图并入队；读的期间被取消则不入队。返回本地失败说明。 */
  const submit = useCallback(
    async (target: RunTarget, taskNodeId: string, prepare: () => Promise<{ job: PreparedJob; board: Board }>): Promise<string | null> => {
      const key = `${target.boardKey}\n${taskNodeId}`;
      const mark = { boardKey: target.boardKey, cancelled: false };
      preparing.current.set(key, mark);
      setStatus(taskNodeId, { kind: "queued" });
      publish();
      try {
        const prepared = await prepare();
        if (mark.cancelled) return null;
        enqueue(target, prepared);
        return null;
      } catch (e) {
        if (mark.cancelled) return null;
        setStatus(taskNodeId, { kind: "failed", label: failureLabel(e) });
        return e instanceof Error ? e.message : String(e);
      } finally {
        preparing.current.delete(key);
        publish();
      }
    },
    [setStatus, publish, enqueue],
  );

  /** 按顺序提交并入队；返回本地提交失败的说明（不含密钥与提示词）。 */
  const run = useCallback(
    async (req: RunRequest): Promise<string[]> => {
      const problems: string[] = [];
      const tableSha256 = await tableDigest(req.table);
      for (const taskNodeId of req.taskIds) {
        if (!boardsRef.current.getBoard(req.boardKey)) break;
        if (occupied(req.boardKey, taskNodeId)) continue;
        const problem = await submit(req, taskNodeId, () =>
          prepareJob(deps, { board: req.board, table: req.table, tableSha256, outputRoot: req.outputRoot, taskNodeId }),
        );
        if (problem) problems.push(problem);
      }
      return problems;
    },
    [submit],
  );

  /** 重新生成：同参数新任务，不经二次确认；返回本地失败说明。 */
  const regenerate = useCallback(
    async (target: RunTarget, taskNodeId: string): Promise<string | null> => {
      if (occupied(target.boardKey, taskNodeId)) return null;
      const tableSha256 = await tableDigest(target.table);
      return submit(target, taskNodeId, async () => {
        const board = boardsRef.current.getBoard(target.boardKey);
        if (!board) throw new Error("画板已关闭");
        return prepareRegenerate(deps, { board, table: target.table, tableSha256, outputRoot: target.outputRoot, taskNodeId });
      });
    },
    [submit],
  );

  const cancelIds = useCallback(
    (taskIds: string[]) => {
      for (const taskId of taskIds) {
        const entry = entries.current.get(taskId);
        if (!entry) continue;
        const { queue: next, was } = Q.cancel(queue.current, taskId);
        queue.current = next;
        entries.current.delete(taskId);
        if (was === "waiting" && !entry.written) {
          // 从未派发：画板与任务目录都没动过，不留痕迹。
          setStatus(entry.job.taskNodeId, null);
        } else {
          entry.controller.abort();
          setStatus(entry.job.taskNodeId, { kind: "cancelled" });
        }
      }
      pump();
    },
    [pump, setStatus],
  );

  /** 取消还在读参考图的提交。 */
  const cancelPreparing = useCallback(
    (match: (boardKey: string, taskNodeId: string) => boolean) => {
      for (const [key, mark] of preparing.current) {
        const taskNodeId = key.slice(key.indexOf("\n") + 1);
        if (mark.cancelled || !match(mark.boardKey, taskNodeId)) continue;
        mark.cancelled = true;
        setStatus(taskNodeId, null);
      }
    },
    [setStatus],
  );

  const inQueue = () => [...queue.current.running, ...queue.current.waiting];
  const cancelTask = useCallback(
    (boardKey: string, taskNodeId: string) => {
      cancelPreparing((b, t) => b === boardKey && t === taskNodeId);
      cancelIds(inQueue().filter((id) => entries.current.get(id)?.target.boardKey === boardKey && entries.current.get(id)?.job.taskNodeId === taskNodeId));
    },
    [cancelIds, cancelPreparing],
  );
  const cancelWaiting = useCallback(() => {
    cancelPreparing(() => true);
    cancelIds([...queue.current.waiting]);
  }, [cancelIds, cancelPreparing]);
  const cancelBoard = useCallback(
    (boardKey: string) => {
      cancelPreparing((b) => b === boardKey);
      cancelIds(inQueue().filter((id) => entries.current.get(id)?.target.boardKey === boardKey));
    },
    [cancelIds, cancelPreparing],
  );
  const cancelAll = useCallback(() => {
    cancelPreparing(() => true);
    cancelIds(inQueue());
  }, [cancelIds, cancelPreparing]);

  /** 排队（含读参考图中）与执行中的任务数；关闭画板 / 退出前确认用，读最新值。 */
  const pendingCount = useCallback(
    (boardKey?: string) =>
      [...preparing.current.values()].filter((m) => !m.cancelled && (boardKey === undefined || m.boardKey === boardKey)).length +
      inQueue().filter((id) => boardKey === undefined || entries.current.get(id)?.target.boardKey === boardKey).length,
    [],
  );

  const busy = active.length > 0 || preparing.current.size > 0;
  return { statuses, active, busy, handled: handled.current, run, regenerate, cancelTask, cancelWaiting, cancelBoard, cancelAll, pendingCount };
}
