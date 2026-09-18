// 画板包（ADR 0013）的界面流程：导出确认 → 选位置 → 可取消的进度；导入选包 → 判版本与布局 → 进度 → 写画板并打开。
// 包格式规则在 core/boardPack.ts，字节搬运在 Rust 壳；这里只串流程、弹窗与脱敏日志（只记类别与计数，不记提示词与报错原文）。
import { getVersion } from "@tauri-apps/api/app";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useState } from "react";
import { BOARD_EXTENSION, type Board } from "../core/board";
import { buildExportSpec, importSummary, inspectPack, PACK_EXTENSION, PACK_FILE_FILTER, planExport } from "../core/boardPack";
import { basename } from "../core/paths";
import { packFs } from "../shell/adapters";
import { ipc, PACK_CANCELLED } from "../shell/ipc";
import { logEvent } from "../shell/log";
import type { PackDialogState } from "./BoardPackDialog";

interface PackBoards {
  flushAll: () => Promise<void>;
  getBoard: (key: string) => Board | null;
  boardFileName: (key: string) => string | null;
  /** 按同名改名规则写入画板目录并在新标签页打开，返回实际写入的路径。 */
  addImportedBoard: (board: Board) => Promise<string>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Outcome<T> = { ok: true; value: T } | { ok: false; result: "cancelled" | "failed"; error: string };

export function useBoardPack(outputRoot: string | null, boards: PackBoards, toast: (message: string) => void) {
  const [dialog, setDialog] = useState<PackDialogState | null>(null);

  /** 复位取消标记后弹出进度再跑命令：先复位，进度弹出后立刻点的取消才不会丢。 */
  const withProgress = useCallback(async <T,>(title: string, run: () => Promise<T>): Promise<Outcome<T>> => {
    await ipc.boardPackCancel(false);
    setDialog({ stage: "progress", title });
    try {
      return { ok: true, value: await run() };
    } catch (e) {
      const error = errorText(e);
      return { ok: false, result: error === PACK_CANCELLED ? "cancelled" : "failed", error };
    }
  }, []);

  /** 导出第一步：落盘后列出要带的任务目录与缺图，弹确认（提示含完整提示词）。 */
  const prepareExport = useCallback(
    async (key: string) => {
      if (!outputRoot) return;
      await boards.flushAll();
      const board = boards.getBoard(key);
      const boardFile = boards.boardFileName(key);
      if (!board || !boardFile) return;
      try {
        setDialog({ stage: "confirmExport", boardFile, plan: await planExport(board, outputRoot, packFs) });
      } catch (e) {
        toast(`无法导出画板包：${errorText(e)}`);
      }
    },
    [outputRoot, boards, toast],
  );

  const confirmExport = useCallback(async () => {
    if (!outputRoot || dialog?.stage !== "confirmExport") return;
    const { boardFile, plan } = dialog;
    const stem = boardFile.slice(0, -BOARD_EXTENSION.length);
    const picked = await save({ defaultPath: `${stem}${PACK_EXTENSION}`, filters: [PACK_FILE_FILTER] });
    if (!picked) return;
    const target = picked.toLowerCase().endsWith(PACK_EXTENSION) ? picked : `${picked}${PACK_EXTENSION}`;
    const spec = buildExportSpec(await getVersion(), boardFile, plan);
    const fields = { action: "export", board_file: boardFile, task_dirs: plan.taskDirs.length, missing: plan.missing.length };
    const outcome = await withProgress(`正在导出画板包：${stem}`, () => ipc.boardPackExport(outputRoot, target, spec));
    setDialog(null);
    if (outcome.ok) {
      logEvent("board_pack", { ...fields, task_dirs: outcome.value.task_dirs, bytes: outcome.value.bytes, result: "ok" });
      toast(`已导出画板包到 ${target}`);
    } else {
      logEvent("board_pack", { ...fields, result: outcome.result });
      toast(outcome.result === "cancelled" ? "已取消导出画板包" : `导出画板包失败：${outcome.error}`);
    }
  }, [outputRoot, dialog, withProgress, toast]);

  /** 导入：先判版本与布局（不合格不写任何文件），再解压合并，最后写画板并在新标签页打开。 */
  const importPack = useCallback(async () => {
    if (!outputRoot) return;
    const picked = await open({ multiple: false, directory: false, filters: [PACK_FILE_FILTER] });
    if (typeof picked !== "string") return;
    const fields = { action: "import", pack_file: basename(picked) };
    const check = await ipc
      .boardPackEntries(picked)
      .then((entries) => inspectPack(entries, (names) => ipc.boardPackReadTexts(picked, names)))
      .catch((e) => ({ kind: "corrupt" as const, reason: errorText(e) }));
    if (check.kind !== "ok") {
      logEvent("board_pack", { ...fields, result: check.kind });
      if (check.kind === "newer") await message(check.message, { title: "无法导入画板包", kind: "warning" });
      else toast(`无法导入画板包：${check.reason}`);
      return;
    }
    const packBoards = check.boards.map((b) => basename(b.entry)).join(", ");
    const outcome = await withProgress(`正在导入画板包：${basename(picked)}`, () => ipc.boardPackImport(picked, outputRoot, check.units));
    if (!outcome.ok) {
      setDialog(null);
      logEvent("board_pack", { ...fields, board_file: packBoards, result: outcome.result });
      toast(outcome.result === "cancelled" ? "已取消导入；已移入的任务目录保留" : `导入画板包失败：${outcome.error}`);
      return;
    }
    const summary = importSummary(check.units, outcome.value.outcomes);
    const logged = { ...fields, task_dirs: summary.imported, skipped: summary.skipped, conflicts: summary.conflicts.length, bytes: outcome.value.bytes };
    const written: string[] = [];
    let writeError: string | null = null;
    try {
      for (const { board } of check.boards) written.push(basename(await boards.addImportedBoard(board)));
    } catch (e) {
      writeError = errorText(e);
    }
    logEvent("board_pack", { ...logged, board_file: writeError ? packBoards : written.join(", "), result: writeError ? "board_write_failed" : "ok" });
    if (writeError || summary.conflicts.length) setDialog({ stage: "importDone", message: summary.message, conflicts: summary.conflicts, error: writeError });
    else {
      setDialog(null);
      toast(summary.message);
    }
  }, [outputRoot, boards, withProgress, toast]);

  return {
    prepareExport,
    importPack,
    dialog: dialog && {
      state: dialog,
      onExport: () => void confirmExport(),
      onCancelProgress: () => void ipc.boardPackCancel(true),
      onClose: () => setDialog(null),
    },
  };
}
