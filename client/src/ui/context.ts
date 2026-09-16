import { createContext, useContext, useEffect, useState } from "react";
import type { KnownNode } from "../core/board";
import type { CapabilityTable, ModelCapability } from "../core/capabilities";
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
