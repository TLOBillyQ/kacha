// 多画板标签页：打开 / 新建 / 关闭 / 重命名 / 去抖自动保存 / 另存到。
import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useRef, useState } from "react";
import {
  BOARD_EXTENSION,
  DEFAULT_BOARD_TITLE,
  newBoard,
  openBoard,
  serializeBoard,
  uniqueBoardFileName,
  type Board,
} from "../core/board";
import { editBoard, type BoardChange, type EditEnv, type EditResult } from "../core/edit";
import { emptyHistory, recordChange, redo, undo, type History } from "../core/history";
import { basename, boardsDir, dirname, joinPath, resolveFromRoot } from "../core/paths";
import { restoreResultLayers } from "../core/taskDir";
import { ipc } from "../shell/ipc";
import { logEvent } from "../shell/log";
import type { OperationGate } from "../core/updatePreparation";
import { knownImageInfo } from "./context";

export const AUTOSAVE_DEBOUNCE_MS = 1000;

export type Session =
  | { key: string; path: string; status: "ok"; board: Board; history: History; notice: string | null; saveError: string | null }
  | { key: string; path: string; status: "newer"; version: number }
  | { key: string; path: string; status: "corrupt"; reason: string };

export type OkSession = Extract<Session, { status: "ok" }>;

interface Saver {
  timer: ReturnType<typeof setTimeout> | null;
  /** 串行化同一画板的写入，避免旧写入覆盖新写入。 */
  chain: Promise<void>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/** 编辑环境里随应用状态变化的部分：能力表、网关发现、该画板的锁定集（排队 / 执行 / 限流退避中的任务节点）。 */
export type EnvSource = (key: string) => Pick<EditEnv, "table" | "discovery" | "locked">;

export function useBoardSessions(outputRoot: string | null, envSource: EnvSource, gate?: OperationGate) {
  const [sessions, setSessionsState] = useState<Session[]>([]);
  const [activeKey, setActiveKeyState] = useState<string | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const setActiveKey = useCallback((next: string | null | ((prev: string | null) => string | null)) => {
    activeKeyRef.current = typeof next === "function" ? next(activeKeyRef.current) : next;
    setActiveKeyState(activeKeyRef.current);
  }, []);
  const sessionsRef = useRef<Session[]>([]);
  const savers = useRef(new Map<string, Saver>());
  const gateRef = useRef(gate);
  gateRef.current = gate;
  const blocked = () => gateRef.current?.blocked() ?? false;
  const tracked = <A extends unknown[], R,>(operation: (...args: A) => Promise<R>, fallback: R) =>
    (...args: A): Promise<R> => {
      if (blocked()) return Promise.resolve(fallback);
      const work = operation(...args);
      gateRef.current?.track(work);
      return work;
    };

  const setSessions = useCallback((next: Session[]) => {
    sessionsRef.current = next;
    setSessionsState(next);
  }, []);

  const patch = useCallback(
    (key: string, fn: (s: OkSession) => OkSession) => {
      setSessions(sessionsRef.current.map((s) => (s.key === key && s.status === "ok" ? { ...fn(s) } : s)));
    },
    [setSessions],
  );

  const saverOf = (key: string): Saver => {
    let saver = savers.current.get(key);
    if (!saver) {
      saver = { timer: null, chain: Promise.resolve() };
      savers.current.set(key, saver);
    }
    return saver;
  };

  const flush = useCallback(
    (key: string): Promise<void> => {
      const saver = saverOf(key);
      if (saver.timer) clearTimeout(saver.timer);
      saver.timer = null;
      saver.chain = saver.chain.then(async () => {
        // 写入时再取最新会话：路径可能刚被重命名或另存。
        const s = sessionsRef.current.find((x) => x.key === key);
        if (!s || s.status !== "ok") return;
        try {
          await ipc.writeBoard(s.path, serializeBoard(s.board));
          if (s.saveError) patch(key, (x) => ({ ...x, saveError: null }));
        } catch (e) {
          logEvent("board_save_failed", { board_file: basename(s.path), reason: "autosave", message: errorText(e) });
          patch(key, (x) => ({ ...x, saveError: `未能保存到 ${s.path}：${errorText(e)}` }));
        }
      });
      return saver.chain;
    },
    [patch],
  );

  const scheduleSave = useCallback(
    (key: string) => {
      const saver = saverOf(key);
      if (saver.timer) clearTimeout(saver.timer);
      saver.timer = setTimeout(() => void flush(key), AUTOSAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  const envSourceRef = useRef(envSource);
  envSourceRef.current = envSource;
  const outputRootRef = useRef(outputRoot);
  outputRootRef.current = outputRoot;
  /** 按画板组装编辑环境：图片宽高只取已读到的；锁定集取该画板的（ADR 0015）。 */
  const envOf = useCallback(
    (key: string): EditEnv => ({
      ...envSourceRef.current(key),
      imageSize: (path) => {
        const root = outputRootRef.current;
        const info = root ? knownImageInfo(resolveFromRoot(root, path)) : undefined;
        return info ? [info.width, info.height] : undefined;
      },
      newId: () => crypto.randomUUID(),
    }),
    [],
  );

  /** 按当前画板试算一次变更，不写入（删除前的确认判断用）；会话不可编辑时为 null。 */
  const check = useCallback(
    (key: string, change: BoardChange): EditResult | null => {
      const s = sessionsRef.current.find((x) => x.key === key);
      return s?.status === "ok" ? editBoard(s.board, change, envOf(key)) : null;
    },
    [envOf],
  );

  /** 画板写入的唯一入口（ADR 0014）：经画板编辑算出新画板，落撤销步（只有用户变更有），排程去抖保存。会话不可编辑时为 null。 */
  const apply = useCallback(
    (key: string, change: BoardChange): EditResult | null => {
      const s = sessionsRef.current.find((x) => x.key === key);
      if (!s || s.status !== "ok") return null;
      const r = editBoard(s.board, change, envOf(key));
      if (r.board === s.board) return r;
      patch(key, (x) => ({ ...x, board: r.board, history: r.step ? recordChange(x.history, s.board, r.step, Date.now()) : x.history }));
      scheduleSave(key);
      return r;
    },
    [envOf, patch, scheduleSave],
  );

  /** 撤销 / 重做一步；锁定任务的参数与输入连线按当前状态保留。 */
  const travel = useCallback(
    (key: string, direction: typeof undo) => {
      const s = sessionsRef.current.find((x) => x.key === key);
      if (!s || s.status !== "ok") return;
      const r = direction(s.history, s.board, envSourceRef.current(key).locked);
      if (!r) return;
      patch(key, (x) => ({ ...x, board: r.board, history: r.history }));
      scheduleSave(key);
    },
    [patch, scheduleSave],
  );
  const undoBoard = useCallback((key: string) => travel(key, undo), [travel]);
  const redoBoard = useCallback((key: string) => travel(key, redo), [travel]);

  /** 最新的画板内容（不等 React 重渲染）；会话不存在或不可编辑时为 null。 */
  const getBoard = useCallback((key: string): Board | null => {
    const s = sessionsRef.current.find((x) => x.key === key);
    return s?.status === "ok" ? s.board : null;
  }, []);

  /** 画板文件名（日志用，不带目录）；会话不存在时为 null。 */
  const boardFileName = useCallback((key: string): string | null => {
    const s = sessionsRef.current.find((x) => x.key === key);
    return s ? basename(s.path) : null;
  }, []);

  /** 关闭全部标签页（切换输出根目录时用）；先落盘。 */
  const closeAll = useCallback(async () => {
    for (const s of sessionsRef.current) await closeBoardRef.current(s.key);
  }, []);
  const closeBoardRef = useRef<(key: string) => Promise<void>>(async () => undefined);

  /** 普通关窗 / 导出入口：吞掉失败，只保证计时器与在途写入做完。 */
  const flushAll = useCallback(async () => {
    const pending = [...savers.current.entries()].filter(([, s]) => s.timer !== null).map(([key]) => flush(key));
    await Promise.all([...pending, ...[...savers.current.values()].map((s) => s.chain)]);
  }, [flush]);

  /** 单画板严格写入（更新准备用）：清空计时器，写入当前画板，失败 reject 真实原因。 */
  const flushStrictOne = useCallback(async (key: string) => {
    const saver = saverOf(key);
    if (saver.timer) clearTimeout(saver.timer);
    saver.timer = null;
    const write = saver.chain.then(async () => {
      const s = sessionsRef.current.find((x) => x.key === key);
      if (!s || s.status !== "ok") return;
      try {
        await ipc.writeBoard(s.path, serializeBoard(s.board));
        if (s.saveError) patch(key, (x) => ({ ...x, saveError: null }));
      } catch (e) {
        const message = `未能保存到 ${s.path}：${errorText(e)}`;
        logEvent("board_save_failed", { board_file: basename(s.path), reason: "update_prepare", message: errorText(e) });
        patch(key, (x) => ({ ...x, saveError: message }));
        throw new Error(message);
      }
    });
    saver.chain = write.catch(() => undefined);
    return write;
  }, [patch]);

  /** 严格保存全部已打开画板（ADR 0016）：每个可编辑会话都重新写一遍并等待真实结果，
   *  覆盖未到期计时器、在途写入与此前失败的保存；一个失败也等其余写完再抛错。 */
  const flushAllStrict = useCallback(async () => {
    const keys = sessionsRef.current.filter((s) => s.status === "ok").map((s) => s.key);
    const results = await Promise.allSettled(keys.map((key) => flushStrictOne(key)));
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }, [flushStrictOne]);

  /** 打开画板文件；已打开则切过去。主文件与 .bak 都不存在时返回 false。 */
  const openPath = useCallback(
    async (path: string, activate = true): Promise<boolean> => {
      const existing = sessionsRef.current.find((s) => samePath(s.path, path));
      if (existing) {
        if (activate) setActiveKey(existing.key);
        return true;
      }
      const texts = await ipc.readBoard(path);
      if (texts.main === null && texts.bak === null) return false;
      const opened = openBoard(texts.main, texts.bak);
      // 任务目录是真源：Flash 结果的图层身份 / 定位按 layers.json 还原（画板只冗余展示）；画板包导入同走这里。
      if (opened.kind === "ok" && outputRootRef.current) {
        try {
          opened.board = await restoreResultLayers({ readFile: ipc.readFileBytes }, outputRootRef.current, opened.board);
        } catch (e) {
          throw new Error(`打开画板失败：${errorText(e)}`);
        }
      }
      const key = crypto.randomUUID();
      const session: Session =
        opened.kind === "ok"
          ? {
              key,
              path,
              status: "ok",
              board: opened.board,
              history: emptyHistory(),
              notice: opened.recoveredFromBak ? "画板主文件已损坏，已从备份 .bak 恢复；下次保存会写回主文件。" : null,
              saveError: null,
            }
          : opened.kind === "newer"
            ? { key, path, status: "newer", version: opened.version }
            : { key, path, status: "corrupt", reason: opened.reason };
      setSessions([...sessionsRef.current, session]);
      if (activate) setActiveKey(key);
      return true;
    },
    [setSessions],
  );

  const createBoard = useCallback(async () => {
    if (!outputRoot) return;
    const dir = boardsDir(outputRoot);
    const onDisk = await ipc.listBoardNames(dir).catch(() => [] as string[]);
    const openHere = sessionsRef.current.filter((s) => samePath(dirname(s.path), dir)).map((s) => basename(s.path));
    const path = joinPath(dir, uniqueBoardFileName(DEFAULT_BOARD_TITLE, [...onDisk, ...openHere]));
    const key = crypto.randomUUID();
    setSessions([...sessionsRef.current, { key, path, status: "ok", board: newBoard(), history: emptyHistory(), notice: null, saveError: null }]);
    setActiveKey(key);
    // 立即落盘占住文件名。
    await flush(key);
  }, [outputRoot, flush, setSessions]);

  /** 导入的画板写进输出根目录画板目录：同名沿用 (2) 自动改名、永不覆盖；写好后在新标签页打开。 */
  const addImportedBoard = useCallback(
    async (board: Board): Promise<string> => {
      if (!outputRoot) throw new Error("输出根目录未就绪");
      const dir = boardsDir(outputRoot);
      const onDisk = await ipc.listBoardNames(dir);
      const openHere = sessionsRef.current.filter((s) => samePath(dirname(s.path), dir)).map((s) => basename(s.path));
      const path = joinPath(dir, uniqueBoardFileName(board.title, [...onDisk, ...openHere]));
      await ipc.writeBoard(path, serializeBoard(board));
      await openPath(path, true);
      return path;
    },
    [outputRoot, openPath],
  );

  const closeBoard = useCallback(
    async (key: string) => {
      const saver = savers.current.get(key);
      if (saver?.timer) await flush(key);
      else if (saver) await saver.chain;
      // 更新准备接管在途关闭：保留会话，由严格保存重试吞错的写入。
      if (blocked()) return;
      savers.current.delete(key);
      const list = sessionsRef.current;
      const index = list.findIndex((s) => s.key === key);
      const next = list.filter((s) => s.key !== key);
      setSessions(next);
      setActiveKey((active) => (active === key ? (next[Math.min(index, next.length - 1)]?.key ?? null) : active));
    },
    [flush, setSessions],
  );

  closeBoardRef.current = closeBoard;

  /** 改标题：文件名由标题派生，重名加 (2)，连同 .bak 一起改名。 */
  const renameBoard = useCallback(
    async (key: string, rawTitle: string) => {
      const s = sessionsRef.current.find((x) => x.key === key);
      if (!s || s.status !== "ok") return;
      const title = rawTitle.trim() || DEFAULT_BOARD_TITLE;
      if (title === s.board.title) return;
      // 先落盘挂起的修改，避免去抖写入在改名途中把旧文件重新写出来。
      await flush(key);
      const dir = dirname(s.path);
      const self = basename(s.path);
      const onDisk = await ipc.listBoardNames(dir).catch(() => [] as string[]);
      const openHere = sessionsRef.current.filter((x) => x.key !== key && samePath(dirname(x.path), dir)).map((x) => basename(x.path));
      const nextPath = joinPath(dir, uniqueBoardFileName(title, [...onDisk, ...openHere], self));
      try {
        if (nextPath !== s.path) await ipc.renameBoard(s.path, nextPath);
      } catch (e) {
        patch(key, (x) => ({ ...x, notice: `重命名失败：${errorText(e)}` }));
        return;
      }
      patch(key, (x) => ({ ...x, path: nextPath }));
      apply(key, { kind: "title", title });
      await flush(key);
    },
    [flush, patch, apply],
  );

  const saveAs = useCallback(
    async (key: string) => {
      const s = sessionsRef.current.find((x) => x.key === key);
      if (!s || s.status !== "ok") return;
      const target = await save({
        defaultPath: basename(s.path),
        filters: [{ name: "画板", extensions: [BOARD_EXTENSION.slice(1)] }],
      });
      if (!target) return;
      const path = target.toLowerCase().endsWith(BOARD_EXTENSION) ? target : `${target.replace(/\.json$/i, "")}${BOARD_EXTENSION}`;
      try {
        await ipc.writeBoard(path, serializeBoard(s.board));
        patch(key, (x) => ({ ...x, path, saveError: null }));
      } catch (e) {
        logEvent("board_save_failed", { board_file: basename(path), reason: "save_as", message: errorText(e) });
        patch(key, (x) => ({ ...x, saveError: `未能保存到 ${path}：${errorText(e)}` }));
      }
    },
    [patch],
  );

  const dismissNotice = useCallback((key: string) => patch(key, (x) => ({ ...x, notice: null })), [patch]);

  return {
    sessions,
    activeKey,
    setActiveKey: (key: string | null) => { if (!blocked()) setActiveKey(key); },
    openPath: tracked(openPath, false),
    createBoard: tracked(createBoard, undefined),
    addImportedBoard: (board: Board) => {
      if (blocked()) return Promise.reject(new Error("正在准备更新，暂不能导入画板"));
      const work = addImportedBoard(board);
      gateRef.current?.track(work);
      return work;
    },
    closeBoard: tracked(closeBoard, undefined),
    renameBoard: tracked(renameBoard, undefined),
    saveAs: tracked(saveAs, undefined),
    apply: (key: string, change: BoardChange) => blocked() ? null : apply(key, change),
    check,
    undoBoard: (key: string) => { if (!blocked()) undoBoard(key); },
    redoBoard: (key: string) => { if (!blocked()) redoBoard(key); },
    getBoard,
    boardFileName,
    closeAll,
    flushAll,
    flushAllStrict,
    dismissNotice: (key: string) => { if (!blocked()) dismissNotice(key); },
    snapshot: () => ({ sessions: sessionsRef.current, activeKey: activeKeyRef.current }),
  };
}
