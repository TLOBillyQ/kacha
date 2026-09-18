import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BOARD_EXTENSION, type Board } from "./core/board";
import { BUILTIN_TABLE, effectiveTable, type CapabilityTable } from "./core/capabilities";
import type { BoardChange } from "./core/edit";
import { redoLabel, undoLabel } from "./core/history";
import { basename } from "./core/paths";
import type { Runner, RunTarget } from "./core/runner";
import { runDispatch, runScope, buildConfirmItems, imageSources, type ConfirmItem } from "./core/submission";
import { parseUiState, serializeUiState, type UiState } from "./core/uiState";
import { ipc } from "./shell/ipc";
import { BoardPackDialog } from "./ui/BoardPackDialog";
import { BoardToolbar } from "./ui/BoardToolbar";
import { ContextMenu } from "./ui/ContextMenu";
import { BoardCanvas } from "./ui/BoardCanvas";
import { RunConfirmDialog } from "./ui/RunConfirmDialog";
import { RunIndicator } from "./ui/RunIndicator";
import { SendTextDialog } from "./ui/SendTextDialog";
import { SettingsPanel } from "./ui/SettingsPanel";
import { useRunner } from "./ui/useRunner";
import { useSettings } from "./ui/useSettings";
import { TabBar } from "./ui/TabBar";
import { useUpdateCheck } from "./ui/useUpdateCheck";
import { useBoardPack } from "./ui/useBoardPack";
import { useBoardSessions } from "./ui/useBoardSessions";

const isBoardPath = (p: string) => p.toLowerCase().endsWith(BOARD_EXTENSION);

export function App() {
  const [outputRoot, setOutputRoot] = useState<string | null>(null);
  const [defaultRoot, setDefaultRoot] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const update = useUpdateCheck();
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const [packMenu, setPackMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<{ boardKey: string; board: Board; items: ConfirmItem[]; scope: "selection" | "board" } | null>(null);
  const [sendText, setSendText] = useState<ConfirmItem | null>(null);
  const settings = useSettings();
  const [table, setTable] = useState<CapabilityTable>(BUILTIN_TABLE);
  const [tableError, setTableError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [toastText, setToastText] = useState<string | null>(null);
  const started = useRef(false);
  const initialUi = useRef<UiState | null>(null);
  const windowSize = useRef<UiState["window"]>(null);
  // 编辑环境随渲染更新（能力表、网关发现），锁定集按画板现取运行器的最新快照；sessions 在每次画板变更时取。
  const envRef = useRef({ table, discovery: settings.discovery });
  envRef.current = { table, discovery: settings.discovery };
  const runnerRef = useRef<Runner | null>(null);
  const boards = useBoardSessions(
    outputRoot,
    useCallback((key: string) => ({ ...envRef.current, locked: runnerRef.current!.getSnapshot().board(key).locked }), []),
  );
  const { sessions, activeKey, openPath, createBoard, flushAll } = boards;

  const { apply, check, undoBoard, redoBoard } = boards;
  const { runner, snapshot: runState } = useRunner(apply, settings.settings.concurrency);
  runnerRef.current = runner;
  const [focus, setFocus] = useState<{ boardKey: string; nodeId: string; nonce: number } | null>(null);
  const applyActive = useCallback((change: BoardChange) => (activeKey ? apply(activeKey, change) : null), [activeKey, apply]);
  const checkActive = useCallback((change: BoardChange) => (activeKey ? check(activeKey, change) : null), [activeKey, check]);
  const undoActive = useCallback(() => activeKey && undoBoard(activeKey), [activeKey, undoBoard]);
  const redoActive = useCallback(() => activeKey && redoBoard(activeKey), [activeKey, redoBoard]);
  const openFromCanvas = useCallback((p: string) => void openOrWarnRef.current(p), []);
  const openOrWarnRef = useRef<(p: string) => Promise<void>>(async () => undefined);

  const toast = useCallback((message: string) => setToastText(message), []);
  const pack = useBoardPack(outputRoot, boards, toast);
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
      boards.sessions.forEach((s) => runner.closeBoard(s.key));
      await boards.closeAll();
      setOutputRoot(root);
      toast("已切换输出根目录：旧目录的画板与任务目录原样保留，新目录的画板列表为空");
    },
    [boards, runner, toast],
  );

  /** 与运行时相同的上下文算确认项：逐张检测参考图（缺失 / 透明通道）。运行与查看发送文本共用。 */
  const confirmItemsOf = useCallback(
    async (board: Board, ids: string[], root: string) => {
      const sources = ids.flatMap((id) => imageSources(board, id, root));
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
      return buildConfirmItems(board, table, ids, { discovery: settings.discovery, missingNodes, alphaByNode });
    },
    [settings.discovery, table],
  );

  const startRun = useCallback(
    async (boardKey: string, board: Board, taskIds: string[]) => {
      setConfirm(null);
      if (!outputRoot) return;
      const target: RunTarget = { boardKey, boardFile: boards.boardFileName(boardKey), table, outputRoot, baseUrl: settings.settings.base_url, apiKey: settings.apiKey };
      const problems = await runner.submit(target, board, taskIds);
      if (problems.length) toast(`${problems.length} 个任务提交失败：${problems[0]}`);
    },
    [outputRoot, runner, boards, table, settings.settings.base_url, settings.apiKey, toast],
  );

  // 单个干净任务直接提交，单个标红 / 没有任务只提示；其余弹二次确认（分派规则见 runDispatch）。
  const openRunConfirm = useCallback(
    async (selectedIds: string[]) => {
      if (!activeKey || !outputRoot) return;
      await boards.flushAll();
      const board = boards.getBoard(activeKey);
      if (!board) return;
      const busy = runner.getSnapshot().board(activeKey).locked;
      const items = await confirmItemsOf(board, runScope(board, selectedIds, busy), outputRoot);
      const dispatch = runDispatch(items);
      // 没有可提交的任务时先说明原因；真要提交或弹确认窗才需要密钥。
      if (dispatch.kind === "toast") return toast(dispatch.message);
      if (!settings.apiKey) {
        toast("请先在高级设置中填写 API 密钥");
        setSettingsOpen(true);
        return;
      }
      if (dispatch.kind === "submit") void startRun(activeKey, board, [dispatch.taskId]);
      else setConfirm({ boardKey: activeKey, board, items, scope: selectedIds.length ? "selection" : "board" });
    },
    [activeKey, outputRoot, settings.apiKey, boards, runner, confirmItemsOf, startRun, toast],
  );

  const viewSendText = useCallback(
    async (taskNodeId: string) => {
      if (!activeKey || !outputRoot) return;
      const board = boards.getBoard(activeKey);
      if (!board) return;
      const [item] = await confirmItemsOf(board, [taskNodeId], outputRoot);
      if (item) setSendText(item);
    },
    [activeKey, outputRoot, boards, confirmItemsOf],
  );

  const copyText = useCallback(
    (text: string) =>
      void navigator.clipboard.writeText(text).then(
        () => toast("已复制发送文本"),
        (e) => toast(`复制失败：${e}`),
      ),
    [toast],
  );

  const regenerate = useCallback(
    async (taskNodeId: string, fromTaskId?: string) => {
      if (!activeKey || !outputRoot) return;
      if (!settings.apiKey) {
        toast("请先在高级设置中填写 API 密钥");
        setSettingsOpen(true);
        return;
      }
      const board = boards.getBoard(activeKey);
      if (!board) return;
      const target: RunTarget = { boardKey: activeKey, boardFile: boards.boardFileName(activeKey), table, outputRoot, baseUrl: settings.settings.base_url, apiKey: settings.apiKey };
      const problem = await runner.regenerate(target, board, taskNodeId, fromTaskId);
      if (problem) toast(`${fromTaskId ? "生成变体" : "重新生成"}失败：${problem}`);
    },
    [activeKey, outputRoot, boards, runner, settings.apiKey, settings.settings.base_url, table, toast],
  );

  const cancelTask = useCallback((taskNodeId: string) => activeKey && runner.cancel({ kind: "task", boardKey: activeKey, taskNodeId }), [activeKey, runner]);

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
      const count = runner.getSnapshot().pending(key);
      if (count > 0 && !(await confirmStopTasks(count))) return;
      // 取消并遗忘：重开后失败 / 已取消由任务目录的 outcome.json 给出。
      runner.closeBoard(key);
      await boards.closeBoard(key);
    },
    [boards, runner],
  );

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
      const count = runner.getSnapshot().pending();
      if (count > 0) {
        event.preventDefault();
        if (asking) return;
        asking = true;
        const confirmed = await confirmStopTasks(count).finally(() => (asking = false));
        if (!confirmed) return;
        runner.cancel({ kind: "all" });
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
  }, [flushAll, runner]);

  if (fatal) return <div className="fatal">启动失败：{fatal}</div>;

  const active = sessions.find((s) => s.key === activeKey);
  const failing = sessions.filter((s) => s.status === "ok" && s.saveError);

  const canvasReady = active?.status === "ok" && !!outputRoot;
  return (
    <div className="app">
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
          onExportPack={(key) => void pack.prepareExport(key)}
        />
      </div>
      <div className="board-toolbar">
        {/* 有画板时画布把工具栏 portal 进这个容器；没有时放置灰占位，布局不跳。 */}
        <div ref={setToolbarSlot} className="board-toolbar-slot">
          {!canvasReady && <BoardToolbar disabled />}
        </div>
        <div className="board-toolbar-right">
          <RunIndicator
            active={runState.active}
            titleOf={(key) => {
              const s = sessions.find((x) => x.key === key);
              return s?.status === "ok" ? s.board.title : "（已关闭的画板）";
            }}
            onJump={(t) => {
              boards.setActiveKey(t.boardKey);
              setFocus((f) => ({ boardKey: t.boardKey, nodeId: t.taskNodeId, nonce: (f?.nonce ?? 0) + 1 }));
            }}
            onCancelWaiting={() => runner.cancel({ kind: "waiting" })}
          />
          <button
            className="topbar-button"
            aria-haspopup="menu"
            aria-expanded={packMenu !== null}
            disabled={!outputRoot}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setPackMenu((m) => (m ? null : { x: r.left, y: r.bottom + 2 }));
            }}
          >
            画板包 ▾
          </button>
          {update.available && (
            <button className="topbar-button topbar-update" title="打开下载页" onClick={update.openDownload}>
              ⬇ 新版本 {update.available.version}
            </button>
          )}
          <button className="topbar-button" onClick={() => setSettingsOpen(true)} disabled={!settings.loaded || !outputRoot}>
            ⚙ 高级设置
          </button>
        </div>
      </div>
      {packMenu && (
        <ContextMenu
          at={packMenu}
          items={[
            { action: "importPack", label: "导入画板包…", disabledReason: null },
            { action: "exportPack", label: "导出画板包…", disabledReason: active?.status === "ok" ? null : active ? "画板无法打开，不能导出" : "没有打开的画板" },
          ]}
          onPick={(action) => {
            setPackMenu(null);
            if (action === "importPack") void pack.importPack();
            else if (action === "exportPack" && active) void pack.prepareExport(active.key);
          }}
          onClose={() => setPackMenu(null)}
        />
      )}
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
          <div className="empty">
            {ready ? (
              <>
                <div>没有打开的画板</div>
                <div className="empty-actions">
                  <button className="primary" onClick={() => void createBoard()} disabled={!outputRoot}>
                    新建画板
                  </button>
                  <button onClick={() => void pack.importPack()} disabled={!outputRoot}>
                    导入画板包…
                  </button>
                </div>
              </>
            ) : (
              "正在加载…"
            )}
          </div>
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
              apply={applyActive}
              check={checkActive}
              locked={runState.board(active.key).locked}
              onUndo={undoActive}
              onRedo={redoActive}
              undoLabel={undoLabel(active.history)}
              redoLabel={redoLabel(active.history)}
              openBoardPath={openFromCanvas}
              toast={toast}
              discovery={settings.discovery}
              statuses={runState.board(active.key).statuses}
              handled={runState.board(active.key).handled}
              onRun={(ids) => void openRunConfirm(ids)}
              onCancelTask={cancelTask}
              onRegenerate={regenerate}
              onViewSendText={(id) => void viewSendText(id)}
              toolbarSlot={toolbarSlot}
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
          busy={runState.pending() > 0}
          onOutputRootChange={switchOutputRoot}
          update={update}
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
      {sendText && <SendTextDialog item={sendText} onCopy={copyText} onClose={() => setSendText(null)} />}
      {pack.dialog && <BoardPackDialog {...pack.dialog} />}
      {toastText && <div className="toast">{toastText}</div>}
    </div>
  );
}
