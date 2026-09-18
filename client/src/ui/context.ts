import { createContext, useContext, useEffect, useState } from "react";
import type { Board, KnownNode, PortRef, Region } from "../core/board";
import type { CapabilityTable, ModelCapability } from "../core/capabilities";
import type { BoardAction, MenuTarget } from "../core/contextMenu";
import { joinPath, resolveFromRoot } from "../core/paths";
import type { TaskStatus } from "../core/run";
import { isInterrupted } from "../core/submission";
import { OUTCOME_FILE, parseOutcome, taskDirOfTaskId, type TaskOutcome } from "../core/taskDir";
import { ipc, type ImageInfo } from "../shell/ipc";
import { logEvent } from "../shell/log";

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
  /** 迭代动作：触发节点在多选内时按选中顺序带上其余图片节点；sourceLayer（1 起）= 接该图层而非合成结果；at = 新任务左上角的画布坐标（拖线建节点）。 */
  continueEditing: (nodeId: string, sourceLayer?: number | null, at?: { x: number; y: number }) => void;
  addAsReference: (resultId: string, sourceLayer?: number | null) => void;
  generateVariant: (resultId: string) => void;
  /** 缺图节点：pick = 选文件，search = 在输出根目录内按身份找。 */
  relocate: (nodeId: string, mode: "pick" | "search") => void;
  /** 设置 / 清除一条图片连线的指示区域。 */
  setEdgeRegion: (ref: { from: PortRef; to: PortRef }, region: Region | null) => void;
  /** 参考图 / 结果节点的「放大预览」：弹窗里可再选扇出任务编辑区域。 */
  previewNode: (nodeId: string) => void;
  /** 任务端口行的「指示区域」：直接编辑该条连线的区域。 */
  editRegion: (taskId: string, ref: { from: PortRef; to: PortRef }) => void;
  /**
   * 执行一个画板动作：上下文菜单、悬浮动作条、节点上的运行 / 展开按钮共用；条目与置灰原因由 core/contextMenu 给出。
   * at = 新建类动作的落点（画布坐标），缺省 = 视口中央。
   */
  perform: (action: BoardAction, target: MenuTarget, at?: { x: number; y: number }) => void;
}

export const BoardContext = createContext<BoardActions | null>(null);

export function useBoardActions(): BoardActions {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error("BoardContext 未提供");
  return ctx;
}

// 读到过的图片只检查一次；null = 读取失败（缺图），不缓存，下次再查（文件可能被放回原处）。
const imageInfoCache = new Map<string, Promise<ImageInfo | null>>();

export function useImageInfo(absPath: string | null): ImageInfo | null | undefined {
  const [info, setInfo] = useState<ImageInfo | null | undefined>(undefined);
  useEffect(() => {
    if (absPath === null) return setInfo(undefined);
    let alive = true;
    void cachedImageInfo(absPath).then((value) => alive && setInfo(value));
    return () => {
      alive = false;
    };
  }, [absPath]);
  return info;
}

export function primeImageInfo(absPath: string, info: ImageInfo): void {
  imageInfoCache.set(absPath, Promise.resolve(info));
  resolvedImageInfo.set(absPath, info);
}

// 已读到的图片信息的同步视图：画板变更当场重算自动宽高比时用，等不了 Promise。
const resolvedImageInfo = new Map<string, ImageInfo>();

/** 已经读到过的图片信息；还没读到或读取失败为 undefined。 */
export function knownImageInfo(absPath: string): ImageInfo | undefined {
  return resolvedImageInfo.get(absPath);
}

/** 批量读取图片信息（画布级：透明通道接线等）；path → 信息，读取失败为 null。 */
export function useImageInfos(absPaths: string[]): ReadonlyMap<string, ImageInfo | null> {
  const [infos, setInfos] = useState<ReadonlyMap<string, ImageInfo | null>>(new Map());
  const signature = JSON.stringify(absPaths);
  useEffect(() => {
    let alive = true;
    void Promise.all(absPaths.map(async (abs) => [abs, await cachedImageInfo(abs)] as const)).then(
      (entries) => alive && setInfos(new Map(entries)),
    );
    return () => {
      alive = false;
    };
    // absPaths 由 signature 概括。
  }, [signature]);
  return infos;
}

function cachedImageInfo(absPath: string): Promise<ImageInfo | null> {
  let pending = imageInfoCache.get(absPath);
  if (!pending) {
    pending = ipc.inspectImage(absPath).then(
      (info) => {
        resolvedImageInfo.set(absPath, info);
        return info;
      },
      () => {
        imageInfoCache.delete(absPath);
        resolvedImageInfo.delete(absPath);
        return null;
      },
    );
    imageInfoCache.set(absPath, pending);
  }
  return pending;
}

/** 图片文件读不到的参考图 / 结果节点 id；读完之前为空（不闪缺图占位）。 */
export function useMissingImages(board: Board, outputRoot: string): ReadonlySet<string> {
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const images = board.nodes.flatMap((n) => (n.type === "reference" || n.type === "result" ? [[n.id, resolveFromRoot(outputRoot, n.path)] as const] : []));
  const signature = JSON.stringify(images);
  useEffect(() => {
    let alive = true;
    void Promise.all(images.map(async ([id, abs]) => ((await cachedImageInfo(abs)) ? null : id))).then(
      (ids) => alive && setMissing(new Set(ids.filter((id): id is string => id !== null))),
    );
    return () => {
      alive = false;
    };
    // images 由 signature 概括。
  }, [signature]);
  return missing;
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
/** 已中断只在本次运行里首次发现时记一次日志。 */
const loggedInterrupted = new Set<string>();

export function useStoredStatuses(board: Board, boardFile: string, outputRoot: string, handled: ReadonlySet<string>): ReadonlyMap<string, TaskStatus> {
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
        if (!outcome && !loggedInterrupted.has(taskId)) {
          loggedInterrupted.add(taskId);
          logEvent("task", { task_id: taskId, board_file: boardFile, task_node_id: nodeId, from_status: "running", to_status: "interrupted" });
        }
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
