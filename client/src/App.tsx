import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BOARD_EXTENSION, serializeBoard, type Board } from "./core/board";
import { buildManifest, checkPack, importSummary, PACK_EXTENSION, packBoardEntry, planExport, type PackFs } from "./core/boardPack";
import { BUILTIN_TABLE, effectiveTable, type CapabilityTable } from "./core/capabilities";
import { redoLabel, undoLabel, type Change } from "./core/history";
import { basename } from "./core/paths";
import { runScope, buildConfirmItems, imageSources, type ConfirmItem } from "./core/submission";
import { parseUiState, serializeUiState, type UiState } from "./core/uiState";
import { ipc, PACK_CANCELLED } from "./shell/ipc";
import { logEvent } from "./shell/log";
import { BoardPackDialog, type PackDialogState } from "./ui/BoardPackDialog";
import { BoardCanvas } from "./ui/BoardCanvas";
import { RunConfirmDialog } from "./ui/RunConfirmDialog";
import { RunIndicator } from "./ui/RunIndicator";
import { SettingsPanel } from "./ui/SettingsPanel";
import { isActive, useRunner, type RunTarget } from "./ui/useRunner";
import { useSettings } from "./ui/useSettings";
import { TabBar } from "./ui/TabBar";
import { useBoardSessions } from "./ui/useBoardSessions";

const isBoardPath = (p: string) => p.toLowerCase().endsWith(BOARD_EXTENSION);

const packFs: PackFs = { isFile: ipc.isFile, sha256: async (path) => (await ipc.inspectImage(path)).sha256 };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App() {
  const [outputRoot, setOutputRoot] = useState<string | null>(null);
  const [defaultRoot, setDefaultRoot] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ boardKey: string; board: Board; items: ConfirmItem[]; scope: "selection" | "board" } | null>(null);
  const settings = useSettings();
  const [table, setTable] = useState<CapabilityTable>(BUILTIN_TABLE);
  const [tableError, setTableError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [toastText, setToastText] = useState<string | null>(null);
  const [pack, setPack] = useState<PackDialogState | null>(null);
  const started = useRef(false);
  const initialUi = useRef<UiState | null>(null);
  const windowSize = useRef<UiState["window"]>(null);
  const boards = useBoardSessions(outputRoot);
  const { sessions, activeKey, openPath, createBoard, flushAll } = boards;

  const { updateBoard, undoBoard, redoBoard } = boards;
  const runner = useRunner(boards, settings.settings.concurrency);
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  const [focus, setFocus] = useState<{ boardKey: string; nodeId: string; nonce: number } | null>(null);
  const updateActive = useCallback((fn: (b: Board) => Board, change: Change) => activeKey && updateBoard(activeKey, fn, change), [activeKey, updateBoard]);
  const undoActive = useCallback((locked: ReadonlySet<string>) => activeKey && undoBoard(activeKey, locked), [activeKey, undoBoard]);
  const redoActive = useCallback((locked: ReadonlySet<string>) => activeKey && redoBoard(activeKey, locked), [activeKey, redoBoard]);
  const openFromCanvas = useCallback((p: string) => void openOrWarnRef.current(p), []);
  const openOrWarnRef = useRef<(p: string) => Promise<void>>(async () => undefined);

  const toast = useCallback((message: string) => setToastText(message), []);
  useEffect(() => {
    if (!toastText) return;
    const timer = setTimeout(() => setToastText(null), 4000);
    return () => clearTimeout(timer);
  }, [toastText]);

  const openOrWarn = useCallback(
    async (path: string) => {
      const found = await openPath(path, true).catch(() => false);
      if (!found) toast(`找不到画板文件：${path}`);
    },
    [openPath, toast],
  );
  openOrWarnRef.current = openOrWarn;

  // 第一阶段：路径、能力表、界面状态、窗口尺寸。
  useEffect(() => {
    void (async () => {
      try {
        const paths = await ipc.appPaths();
        const override = await ipc.readCapabilityOverride().catch((e) => {
          setTableError(`读取能力表覆盖文件失败：${e}`);
          return null;
        });
        const effective = effectiveTable(override);
        setTable(effective.table);
        if (effective.error) setTableError(effective.error);
        const ui = parseUiState(await ipc.readUiState().catch(() => null));
        initialUi.current = ui;
        windowSize.current = ui.window;
        if (ui.window) await getCurrentWindow().setSize(new LogicalSize(ui.window.width, ui.window.height));
        setDefaultRoot(paths.default_output_root);
      } catch (e) {
        setFatal(String(e));
      }
    })();
  }, []);

  // 设置读完再定输出根目录（设置里没填就用默认）。
  useEffect(() => {
    if (defaultRoot && settings.loaded && outputRoot === null) setOutputRoot(settings.settings.output_root ?? defaultRoot);
  }, [defaultRoot, settings.loaded, settings.settings.output_root, outputRoot]);

  // 切换输出根目录：不搬文件，关掉全部标签页；新目录的画板列表为空。
  const switchOutputRoot = useCallback(
    async (root: string) => {
      await boards.closeAll();
      setOutputRoot(root);
      toast("已切换输出根目录：旧目录的画板与任务目录原样保留，新目录的画板列表为空");
    },
    [boards, toast],
  );

  const openRunConfirm = useCallback(
    async (selectedIds: string[]) => {
      if (!activeKey || !outputRoot) return;
      if (!settings.apiKey) {
        toast("请先在高级设置中填写 API 密钥");
        setSettingsOpen(true);
        return;
      }
      await boards.flushAll();
      const board = boards.getBoard(activeKey);
      if (!board) return;
      const busy = new Set([...runner.statuses].filter(([, st]) => isActive(st)).map(([id]) => id));
      const ids = runScope(board, selectedIds, busy);
      const sources = ids.flatMap((id) => imageSources(board, id, outputRoot));
      const missingNodes = new Set<string>();
      const alphaByNode = new Map<string, boolean>();
      await Promise.all(
        sources.map((src) =>
          ipc.inspectImage(src.absPath).then(
            (info) => alphaByNode.set(src.nodeId, info.has_alpha),
            () => {
              missingNodes.add(src.nodeId);
            },
          ),
        ),
      );
      const items = buildConfirmItems(board, table, ids, { discovery: settings.discovery, missingNodes, alphaByNode });
      setConfirm({ boardKey: activeKey, board, items, scope: selectedIds.length ? "selection" : "board" });
    },
    [activeKey, outputRoot, settings.apiKey, settings.discovery, boards, runner.statuses, table, toast],
  );

  const startRun = useCallback(
    async (boardKey: string, board: Board, taskIds: string[]) => {
      setConfirm(null);
      if (!outputRoot) return;
      const problems = await runner.run({
        boardKey,
        board,
        taskIds,
        table,
        outputRoot,
        baseUrl: settings.settings.base_url,
        apiKey: settings.apiKey,
      });
      if (problems.length) toast(`${problems.length} 个任务提交失败：${problems[0]}`);
    },
    [outputRoot, runner, table, settings.settings.base_url, settings.apiKey, toast],
  );

  const regenerate = useCallback(
    async (taskNodeId: string, fromTaskId?: string) => {
      if (!activeKey || !outputRoot) return;
      if (!settings.apiKey) {
        toast("请先在高级设置中填写 API 密钥");
        setSettingsOpen(true);
        return;
      }
      const target: RunTarget = { boardKey: activeKey, table, outputRoot, baseUrl: settings.settings.base_url, apiKey: settings.apiKey };
      const problem = await runnerRef.current.regenerate(target, taskNodeId, fromTaskId);
      if (problem) toast(`${fromTaskId ? "生成变体" : "重新生成"}失败：${problem}`);
    },
    [activeKey, outputRoot, settings.apiKey, settings.settings.base_url, table, toast],
  );

  const cancelTask = useCallback((taskNodeId: string) => activeKey && runnerRef.current.cancelTask(activeKey, taskNodeId), [activeKey]);

  /** 画板还有排队 / 执行中的任务时，关闭前阻断式二选一；不后台续跑。 */
  const confirmStopTasks = (count: number) =>
    ask(`还有 ${count} 个任务在排队或执行。关闭后不会在后台继续；已在执行的只停止本地等待，网关侧计算可能仍在继续。`, {
      title: "任务未完成",
      kind: "warning",
      okLabel: "取消全部并关闭",
      cancelLabel: "留在画板",
    });

  const closeBoard = useCallback(
    async (key: string) => {
      const count = runnerRef.current.pendingCount(key);
      if (count > 0) {
        if (!(await confirmStopTasks(count))) return;
        runnerRef.current.cancelBoard(key);
      }
      await boards.closeBoard(key);
    },
    [boards],
  );

  /** 导出画板包第一步：落盘后列出要带的任务目录与缺图，弹确认（提示含完整提示词）。 */
  const prepareExportPack = useCallback(
    async (key: string) => {
      if (!outputRoot) return;
      await boards.flushAll();
      const board = boards.getBoard(key);
      const boardFile = boards.boardFileName(key);
      if (!board || !boardFile) return;
      try {
        const plan = await planExport(board, outputRoot, packFs);
        setPack({ stage: "confirmExport", boardFile, plan });
      } catch (e) {
        toast(`无法导出画板包：${errorText(e)}`);
      }
    },
    [outputRoot, boards, toast],
  );

  const exportPack = useCallback(
    async (boardFile: string, plan: Extract<PackDialogState, { stage: "confirmExport" }>["plan"]) => {
      if (!outputRoot) return;
      const stem = boardFile.slice(0, -BOARD_EXTENSION.length);
      const picked = await save({ defaultPath: `${stem}${PACK_EXTENSION}`, filters: [{ name: "画板包", extensions: [PACK_EXTENSION.slice(1)] }] });
      if (!picked) return;
      const target = picked.toLowerCase().endsWith(PACK_EXTENSION) ? picked : `${picked}${PACK_EXTENSION}`;
      setPack({ stage: "progress", title: `正在导出画板包：${stem}` });
      const entry = packBoardEntry(boardFile);
      const fields = { action: "export", board_file: boardFile, task_dirs: plan.taskDirs.length, missing: plan.missing.length };
      try {
        const report = await ipc.boardPackExport(outputRoot, target, {
          manifest: buildManifest(await getVersion(), [entry]),
          board_entry: entry,
          board_text: serializeBoard(plan.board),
          task_dirs: plan.taskDirs,
          files: plan.files,
        });
        logEvent("board_pack", { ...fields, task_dirs: report.task_dirs, bytes: report.bytes, result: "ok" });
        toast(`已导出画板包到 ${target}`);
      } catch (e) {
        const cancelled = errorText(e) === PACK_CANCELLED;
        logEvent("board_pack", { ...fields, result: cancelled ? "cancelled" : "failed", message: cancelled ? undefined : errorText(e) });
        toast(cancelled ? "已取消导出画板包" : `导出画板包失败：${errorText(e)}`);
      } finally {
        setPack(null);
      }
    },
    [outputRoot, toast],
  );

  /** 导入画板包：先判版本（更高则不写任何文件），再解压合并任务目录，最后写画板并在新标签页打开。 */
  const importPack = useCallback(async () => {
    if (!outputRoot) return;
    const picked = await open({ multiple: false, directory: false, filters: [{ name: "画板包", extensions: [PACK_EXTENSION.slice(1)] }] });
    if (typeof picked !== "string") return;
    const fields = { action: "import", pack_file: basename(picked) };
    let check;
    try {
      const inspected = await ipc.boardPackInspect(picked);
      check = checkPack(inspected.manifest, inspected.boards);
    } catch (e) {
      check = { kind: "corrupt" as const, reason: errorText(e) };
    }
    if (check.kind !== "ok") {
      logEvent("board_pack", { ...fields, result: check.kind });
      if (check.kind === "newer") await message(check.message, { title: "无法导入画板包", kind: "warning" });
      else toast(`无法导入画板包：${check.reason}`);
      return;
    }
    const board_file = check.boards.map((b) => basename(b.entry)).join(", ");
    setPack({ stage: "progress", title: `正在导入画板包：${basename(picked)}` });
    let report;
    try {
      report = await ipc.boardPackImport(picked, outputRoot);
    } catch (e) {
      const cancelled = errorText(e) === PACK_CANCELLED;
      logEvent("board_pack", { ...fields, board_file, result: cancelled ? "cancelled" : "failed", message: cancelled ? undefined : errorText(e) });
      toast(cancelled ? "已取消导入；已移入的任务目录保留" : `导入画板包失败：${errorText(e)}`);
      setPack(null);
      return;
    }
    const logged = { ...fields, board_file, task_dirs: report.imported, skipped: report.skipped, conflicts: report.conflicts.length, bytes: report.bytes };
    try {
      for (const { board } of check.boards) await boards.addImportedBoard(board);
    } catch (e) {
      logEvent("board_pack", { ...logged, result: "failed", message: errorText(e) });
      toast(`任务目录已导入，但写画板失败：${errorText(e)}`);
      setPack(null);
      return;
    }
    logEvent("board_pack", { ...logged, result: "ok" });
    const summary = importSummary(report);
    if (summary.conflicts.length) setPack({ stage: "importDone", ...summary });
    else {
      setPack(null);
      toast(summary.message);
    }
  }, [outputRoot, boards, toast]);

  // 第二阶段：恢复标签页，再打开启动参数里的画板；一个都没有就新建。
  useEffect(() => {
    if (!outputRoot || started.current) return;
    started.current = true;
    void (async () => {
      const ui = initialUi.current!;
      const opened: string[] = [];
      for (const p of ui.open_boards) {
        if (await openPath(p, false).catch(() => false)) opened.push(p);
      }
      let activated = false;
      if (ui.active_board && opened.includes(ui.active_board)) activated = await openPath(ui.active_board, true);
      for (const p of (await ipc.startupArgs().catch(() => [])).filter(isBoardPath)) {
        if (await openPath(p, true).catch(() => false)) activated = true;
        else toast(`找不到画板文件：${p}`);
      }
      if (!activated && opened.length) await openPath(opened[0], true);
      else if (!activated) await createBoard();
      setReady(true);
    })();
  }, [outputRoot, openPath, createBoard, toast]);

  // 第二实例把参数转交过来。
  useEffect(() => {
    const unlisten = listen<string[]>("second-instance", (event) => {
      event.payload.filter(isBoardPath).forEach((p) => void openOrWarn(p));
    });
    return () => void unlisten.then((fn) => fn());
  }, [openOrWarn]);

  const persistUi = useCallback(() => {
    const active = sessions.find((s) => s.key === activeKey);
    const state: UiState = { window: windowSize.current, open_boards: sessions.map((s) => s.path), active_board: active?.path ?? null };
    return ipc.writeUiState(serializeUiState(state)).catch(() => undefined);
  }, [sessions, activeKey]);
  const persistRef = useRef(persistUi);
  persistRef.current = persistUi;

  const uiSignature = JSON.stringify([sessions.map((s) => s.path), sessions.find((s) => s.key === activeKey)?.path]);
  useEffect(() => {
    if (ready) void persistRef.current();
  }, [ready, uiSignature]);

  useEffect(() => {
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resized = win.onResized(async ({ payload }) => {
      if (await win.isMaximized()) return;
      const logical = payload.toLogical(await win.scaleFactor());
      windowSize.current = { width: Math.round(logical.width), height: Math.round(logical.height) };
      clearTimeout(timer);
      timer = setTimeout(() => void persistRef.current(), 500);
    });
    // 注册了关闭监听后由前端调用 destroy 关窗（需 core:window:allow-destroy）；保存出错也不能挡住关窗。
    // 有未完成任务时先阻断式确认，全局只弹一次。
    let asking = false;
    const closing = win.onCloseRequested(async (event) => {
      const count = runnerRef.current.pendingCount();
      if (count > 0) {
        event.preventDefault();
        if (asking) return;
        asking = true;
        const confirmed = await confirmStopTasks(count).finally(() => (asking = false));
        if (!confirmed) return;
        runnerRef.current.cancelAll();
      }
      try {
        await flushAll();
        await persistRef.current();
      } catch (e) {
        console.error("关闭前保存失败", e);
      }
      if (count > 0) await win.destroy();
    });
    return () => {
      clearTimeout(timer);
      void resized.then((fn) => fn());
      void closing.then((fn) => fn());
    };
  }, [flushAll]);

  if (fatal) return <div className="fatal">启动失败：{fatal}</div>;

  const active = sessions.find((s) => s.key === activeKey);
  const failing = sessions.filter((s) => s.status === "ok" && s.saveError);

  return (
    <div className="app">
      {failing.map(
        (s) =>
          s.status === "ok" && (
            <div key={s.key} className="bar bar-error">
              <span>
                「{s.board.title}」{s.saveError}（之后每次修改都会重试）
              </span>
              <button onClick={() => void boards.saveAs(s.key)}>另存到…</button>
            </div>
          ),
      )}
      {tableError && (
        <div className="bar bar-warn">
          <span>{tableError}（已使用内置能力表）</span>
          <button onClick={() => setTableError(null)}>知道了</button>
        </div>
      )}
      <div className="topbar">
        <TabBar
          sessions={sessions}
          activeKey={activeKey}
          onActivate={(key) => {
            setFocus(null);
            boards.setActiveKey(key);
          }}
          onClose={(key) => void closeBoard(key)}
          onRename={(key, title) => void boards.renameBoard(key, title)}
          onCreate={() => void createBoard()}
          onExportPack={(key) => void prepareExportPack(key)}
          onImportPack={() => void importPack()}
        />
        <RunIndicator
          active={runner.active}
          titleOf={(key) => {
            const s = sessions.find((x) => x.key === key);
            return s?.status === "ok" ? s.board.title : "（已关闭的画板）";
          }}
          onJump={(t) => {
            boards.setActiveKey(t.boardKey);
            setFocus((f) => ({ boardKey: t.boardKey, nodeId: t.taskNodeId, nonce: (f?.nonce ?? 0) + 1 }));
          }}
          onCancelWaiting={runner.cancelWaiting}
        />
        <button className="settings-button" onClick={() => setSettingsOpen(true)} disabled={!settings.loaded || !outputRoot}>
          ⚙ 高级设置
        </button>
      </div>
      {settings.fileProblem && !settingsOpen && (
        <div className="bar bar-warn">
          <span>{settings.fileProblem}</span>
          <button onClick={() => setSettingsOpen(true)}>打开高级设置</button>
        </div>
      )}
      {active?.status === "ok" && active.notice && (
        <div className="bar bar-warn">
          <span>{active.notice}</span>
          <button onClick={() => boards.dismissNotice(active.key)}>知道了</button>
        </div>
      )}
      <main className="workspace">
        {!active || !outputRoot ? (
          <div className="empty">{ready ? "没有打开的画板" : "正在加载…"}</div>
        ) : active.status === "newer" ? (
          <div className="empty">
            该画板由更新版本的工具保存（format_version {active.version}），本版本无法打开；文件未做任何改动。
            <div className="mono muted">{active.path}</div>
          </div>
        ) : active.status === "corrupt" ? (
          <div className="empty">
            画板文件已损坏且没有可用备份：{active.reason}
            <div className="mono muted">{active.path}</div>
          </div>
        ) : (
          <ReactFlowProvider key={active.key}>
            <BoardCanvas
              board={active.board}
              boardFile={basename(active.path)}
              table={table}
              outputRoot={outputRoot}
              update={updateActive}
              onUndo={undoActive}
              onRedo={redoActive}
              undoLabel={undoLabel(active.history)}
              redoLabel={redoLabel(active.history)}
              openBoardPath={openFromCanvas}
              toast={toast}
              discovery={settings.discovery}
              statuses={runner.statuses}
              handled={runner.handled}
              onRun={(ids) => void openRunConfirm(ids)}
              onCancelTask={cancelTask}
              onRegenerate={regenerate}
              onExportPack={() => void prepareExportPack(active.key)}
              focus={focus?.boardKey === active.key ? focus : null}
            />
          </ReactFlowProvider>
        )}
      </main>
      {settingsOpen && outputRoot && defaultRoot && (
        <SettingsPanel
          settings={settings}
          outputRoot={outputRoot}
          defaultOutputRoot={defaultRoot}
          openBoards={sessions.map((s) => s.path)}
          busy={runner.busy}
          onOutputRootChange={switchOutputRoot}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {confirm && (
        <RunConfirmDialog
          items={confirm.items}
          scope={confirm.scope}
          onCancel={() => setConfirm(null)}
          onConfirm={(ids) => void startRun(confirm.boardKey, confirm.board, ids)}
        />
      )}
      {pack && (
        <BoardPackDialog
          state={pack}
          onExport={() => pack.stage === "confirmExport" && void exportPack(pack.boardFile, pack.plan)}
          onCancelProgress={() => void ipc.boardPackCancel()}
          onClose={() => setPack(null)}
        />
      )}
      {toastText && <div className="toast">{toastText}</div>}
    </div>
  );
}
