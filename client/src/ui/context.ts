import { createContext, useContext, useEffect, useState } from "react";
import type { Board, KnownNode } from "../core/board";
import type { CapabilityTable, ModelCapability } from "../core/capabilities";
import { joinPath } from "../core/paths";
import type { TaskStatus } from "../core/run";
import { isInterrupted } from "../core/submission";
import { OUTCOME_FILE, parseOutcome, taskDirOfTaskId, type TaskOutcome } from "../core/taskDir";
import { ipc, type ImageInfo } from "../shell/ipc";

export interface BoardActions {
  table: CapabilityTable;
  outputRoot: string;
  /** 任务节点模型下拉：网关发现 ∩ 上架清单。 */
  availableModels: ModelCapability[];
  /** 选模型：写节点并记为画板级最近模型。 */
  setTaskModel: (id: string, modelId: string) => void;
  updateNode: (id: string, patch: Partial<KnownNode>) => void;
  moveImagePort: (taskId: string, from: number, to: number) => void;
  /** 编辑已提交过的提示词节点，选「断开并分叉」。 */
  forkPrompt: (promptId: string, text: string) => void;
  cancelTask: (taskId: string) => void;
  regenerate: (taskId: string) => void;
}

export const BoardContext = createContext<BoardActions | null>(null);

export function useBoardActions(): BoardActions {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error("BoardContext 未提供");
  return ctx;
}

// 同一路径的图片只检查一次；null = 读取失败（缺图）。
const imageInfoCache = new Map<string, Promise<ImageInfo | null>>();

export function useImageInfo(absPath: string | null): ImageInfo | null | undefined {
  const [info, setInfo] = useState<ImageInfo | null | undefined>(undefined);
  useEffect(() => {
    if (absPath === null) return setInfo(undefined);
    let alive = true;
    let pending = imageInfoCache.get(absPath);
    if (!pending) {
      pending = ipc.inspectImage(absPath).catch(() => null);
      imageInfoCache.set(absPath, pending);
    }
    void pending.then((value) => alive && setInfo(value));
    return () => {
      alive = false;
    };
  }, [absPath]);
  return info;
}

export function primeImageInfo(absPath: string, info: ImageInfo): void {
  imageInfoCache.set(absPath, Promise.resolve(info));
}

// 任务目录的结局记录只写一次，读过就缓存；null = 没有记录。
const outcomeCache = new Map<string, Promise<TaskOutcome | null>>();

function readOutcome(outputRoot: string, taskId: string): Promise<TaskOutcome | null> {
  const dir = taskDirOfTaskId(taskId);
  if (!dir) return Promise.resolve(null);
  const path = joinPath(outputRoot, ...dir.split("/"), OUTCOME_FILE);
  let pending = outcomeCache.get(path);
  if (!pending) {
    pending = ipc.readFileBytes(path).then(parseOutcome, () => null);
    outcomeCache.set(path, pending);
  }
  return pending;
}

/**
 * 本次运行没经手过、提交过却没有结果的任务：按任务目录的 outcome.json 推导失败 / 已取消，没有记录 = 已中断。
 * 读完之前不显示徽标。
 */
export function useStoredStatuses(board: Board, outputRoot: string, handled: ReadonlySet<string>): ReadonlyMap<string, TaskStatus> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, TaskStatus>>(new Map());
  const candidates = board.nodes.flatMap((n) =>
    n.type === "task" && typeof n.last_submitted?.task_id === "string" && isInterrupted(board, n.id, handled) ? [[n.id, n.last_submitted.task_id] as const] : [],
  );
  const signature = JSON.stringify([outputRoot, candidates]);
  useEffect(() => {
    let alive = true;
    void Promise.all(
      candidates.map(async ([nodeId, taskId]) => {
        const outcome = await readOutcome(outputRoot, taskId);
        return [nodeId, outcome ?? { kind: "interrupted" }] as const;
      }),
    ).then((entries) => alive && setStatuses(new Map(entries)));
    return () => {
      alive = false;
    };
    // candidates 由 signature 概括。
  }, [signature]);
  return statuses;
}
