// 画板包（ADR 0013）的界面流程：导出确认 → 选位置 → 可取消的进度；导入选包 → 判版本与布局 → 进度 → 写画板并打开。
// 包格式规则与导入流程（含取消竞态与脱敏日志）在 core/boardPack.ts，字节搬运在 Rust 壳；这里只管弹窗、进度与提示文案。
import { getVersion } from "@tauri-apps/api/app";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useState } from "react";
import { BOARD_EXTENSION, type Board } from "../core/board";
import { buildExportSpec, importPack as importPackIn, PACK_EXTENSION, PACK_FILE_FILTER, planExport, runCancellable } from "../core/boardPack";
import { basename } from "../core/paths";
import { packFs, packIo } from "../shell/adapters";
import { ipc } from "../shell/ipc";
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

export function useBoardPack(outputRoot: string | null, boards: PackBoards, toast: (message: string) => void) {
  const [dialog, setDialog] = useState<PackDialogState | null>(null);

  /** runCancellable 复位取消标记之后才调：此时弹进度，之后立刻点的取消不会丢。 */
  const progress = (title: string) => () => setDialog({ stage: "progress", title });

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
    const outcome = await runCancellable(packIo, progress(`正在导出画板包：${stem}`), () => ipc.boardPackExport(outputRoot, target, spec));
    setDialog(null);
    if (outcome.ok) {
      logEvent("board_pack", { ...fields, task_dirs: outcome.value.task_dirs, bytes: outcome.value.bytes, result: "ok" });
      toast(`已导出画板包到 ${target}`);
    } else {
      logEvent("board_pack", { ...fields, result: outcome.result });
      toast(outcome.result === "cancelled" ? "已取消导出画板包" : `导出画板包失败：${outcome.error}`);
    }
  }, [outputRoot, dialog, toast]);

  /** 导入：先判版本与布局（不合格不写任何文件），再解压合并，最后写画板并在新标签页打开。 */
  const importPack = useCallback(async () => {
    if (!outputRoot) return;
    const picked = await open({ multiple: false, directory: false, filters: [PACK_FILE_FILTER] });
    if (typeof picked !== "string") return;
    const result = await importPackIn(packIo, {
      packPath: picked,
      outputRoot,
      addBoard: (board) => boards.addImportedBoard(board),
      onStage: progress(`正在导入画板包：${basename(picked)}`),
      log: logEvent,
    });
    switch (result.kind) {
      case "newer":
        await message(result.message, { title: "无法导入画板包", kind: "warning" });
        return;
      case "corrupt":
        return toast(`无法导入画板包：${result.reason}`);
      case "cancelled":
        setDialog(null);
        return toast("已取消导入；已移入的任务目录保留");
      case "failed":
        setDialog(null);
        return toast(`导入画板包失败：${result.error}`);
      case "done": {
        const { summary, writeError } = result;
        if (writeError || summary.conflicts.length) setDialog({ stage: "importDone", message: summary.message, conflicts: summary.conflicts, error: writeError });
        else {
          setDialog(null);
          toast(summary.message);
        }
      }
    }
  }, [outputRoot, boards, toast]);

  return {
    prepareExport,
    importPack,
    dialog: dialog && {
      state: dialog,
      onExport: () => void confirmExport(),
      onCancelProgress: () => void packIo.cancel(true),
      onClose: () => setDialog(null),
    },
  };
}
