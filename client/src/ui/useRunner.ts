// 运行：提交（写任务目录 + last_submitted）→ 全局队列逐个调网关 → 结果节点落到画板。
// 本切片队列串行；并发上限只存储，运行编排切片才生效。状态只在内存，不持久化。
import { useCallback, useRef, useState } from "react";
import type { Board } from "../core/board";
import type { CapabilityTable } from "../core/capabilities";
import { executeJob, failureLabel, prepareJob, type PreparedJob, type RunDeps, type TaskStatus } from "../core/run";
import { tableDigest } from "../core/taskDir";
import { httpFetch, ipc } from "../shell/ipc";

const deps: RunDeps = {
  readBytes: ipc.readFileBytes,
  writeNewFile: ipc.writeNewFile,
  fetch: httpFetch,
  now: () => new Date(),
};

interface QueuedJob {
  boardKey: string;
  job: PreparedJob;
  outputRoot: string;
  baseUrl: string;
  apiKey: string;
}

export interface RunRequest {
  boardKey: string;
  taskIds: string[];
  /** 二次确认时的画板：按用户确认的内容提交，确认框打开期间的编辑不混进来。 */
  board: Board;
  table: CapabilityTable;
  outputRoot: string;
  baseUrl: string;
  apiKey: string;
}

export function useRunner(boards: { getBoard: (key: string) => Board | null; updateBoard: (key: string, fn: (b: Board) => Board) => void }) {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, TaskStatus>>(new Map());
  const queue = useRef<QueuedJob[]>([]);
  const working = useRef(false);
  const boardsRef = useRef(boards);
  boardsRef.current = boards;

  const setStatus = useCallback((taskNodeId: string, status: TaskStatus | null) => {
    setStatuses((m) => {
      const next = new Map(m);
      if (status) next.set(taskNodeId, status);
      else next.delete(taskNodeId);
      return next;
    });
  }, []);

  const work = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    try {
      for (let item = queue.current.shift(); item; item = queue.current.shift()) {
        const { job, boardKey } = item;
        setStatus(job.taskNodeId, { kind: "running", startedAt: Date.now() });
        try {
          const apply = await executeJob(deps, { job, outputRoot: item.outputRoot, baseUrl: item.baseUrl, apiKey: item.apiKey, newNodeId: crypto.randomUUID() });
          boardsRef.current.updateBoard(boardKey, apply);
          setStatus(job.taskNodeId, null);
        } catch (e) {
          setStatus(job.taskNodeId, { kind: "failed", label: failureLabel(e) });
        }
      }
    } finally {
      working.current = false;
    }
  }, [setStatus]);

  /** 按顺序提交并入队；返回本地提交失败的说明（不含密钥与提示词）。 */
  const run = useCallback(
    async (req: RunRequest): Promise<string[]> => {
      const problems: string[] = [];
      const tableSha256 = await tableDigest(req.table);
      for (const taskNodeId of req.taskIds) {
        if (!boardsRef.current.getBoard(req.boardKey)) break;
        setStatus(taskNodeId, { kind: "queued" });
        try {
          const prepared = await prepareJob(deps, { board: req.board, table: req.table, tableSha256, outputRoot: req.outputRoot, taskNodeId });
          // 提交期间画板可能又被编辑：只把 last_submitted 写到最新画板的该节点上。
          const submitted = prepared.board.nodes.find((n) => n.id === taskNodeId);
          boardsRef.current.updateBoard(req.boardKey, (b) => ({
            ...b,
            nodes: b.nodes.map((n) => (n.id === taskNodeId && n.type === "task" && submitted?.type === "task" ? { ...n, last_submitted: submitted.last_submitted } : n)),
          }));
          queue.current.push({ boardKey: req.boardKey, job: prepared.job, outputRoot: req.outputRoot, baseUrl: req.baseUrl, apiKey: req.apiKey });
          void work();
        } catch (e) {
          setStatus(taskNodeId, { kind: "failed", label: failureLabel(e) });
          problems.push(e instanceof Error ? e.message : String(e));
        }
      }
      return problems;
    },
    [setStatus, work],
  );

  const busy = [...statuses.values()].some((s) => s.kind !== "failed");
  return { statuses, busy, run };
}
