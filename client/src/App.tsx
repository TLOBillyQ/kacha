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
import { runDispatch, runScope, buildConfirmItems, collectRunFacts, type ConfirmItem } from "./core/submission";
import { parseUiState, serializeUiState, type UiState } from "./core/uiState";
import { createUpdatePreparation, type UpdatePreparation } from "./core/updatePreparation";
import { imageProbe } from "./shell/adapters";
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
  const prepRef = useRef<UpdatePreparation | null>(null);
  const gate = {
    blocked: () => prepRef.current?.active() ?? false,
    track: (op: Promise<unknown>) => prepRef.current?.track(op),
    generation: () => prepRef.current?.generation() ?? 0,
  };
  const boards = useBoardSessions(
    outputRoot,
    useCallback((key: string) => ({ ...envRef.current, locked: runnerRef.current!.getSnapshot().board(key).locked }), []),
    gate,
  );
  const { sessions, activeKey, openPath, createBoard, flushAll } = boards;

  const { apply, check, undoBoard, redoBoard } = boards;
  // 更新准备闸（issue #13）：active 期间阻断画板变更与任务提交；prepare 复用同一次准备，重复点击不产生第二次流程。
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  /** 更新准备进行中（含异步操作结算期）。所有会产生画板变更 / 新任务的入口先过这道闸。 */
  const guardPreparation = useCallback(() => preparingRef.current, []);
  /** 更新准备期间画板变更入口一律拒绝（runner 产出的系统变更同样不能落地）。 */
  const applyGuarded = useCallback(
    (key: string, change: BoardChange) => (guardPreparation() ? null : apply(key, change)),
    [apply, guardPreparation],
  );
  const { runner, snapshot: runState } = useRunner(applyGuarded, settings.settings.concurrency);
  runnerRef.current = runner;
  /** 严格保存界面状态（更新准备）：立即序列化当前挂起状态并等待真实写入；失败 reject。 */
  const persistStrictRef = useRef<() => Promise<void>>(async () => undefined);
  const prep = (prepRef.current ??= createUpdatePreparation({
    queue: {
      pending: () => runnerRef.current!.getSnapshot().pending(),
      setSubmissionGuard: (g) => runnerRef.current!.setSubmissionGuard(g),
    },
    saveBoards: () => boards.flushAllStrict(),
    saveUi: () => persistStrictRef.current(),
    onProtectionChange: (active) => {
      preparingRef.current = active;
      setPreparing(active);
    },
  }));
  const [focus, setFocus] = useState<{ boardKey: string; nodeId: string; nonce: number } | null>(null);
  const generation = prep.generation();
  const applyActive = useCallback((change: BoardChange) =>
    activeKey && !guardPreparation() && generation === prep.generation() ? apply(activeKey, change) : null,
    [activeKey, apply, guardPreparation, generation, prep]);
  const checkActive = useCallback((change: BoardChange) => (activeKey ? check(activeKey, change) : null), [activeKey, check]);
  const undoActive = useCallback(() => activeKey && !guardPreparation() && undoBoard(activeKey), [activeKey, undoBoard, guardPreparation]);
  const redoActive = useCallback(() => activeKey && !guardPreparation() && redoBoard(activeKey), [activeKey, redoBoard, guardPreparation]);
  const openFromCanvas = useCallback((p: string) => void openOrWarnRef.current(p), []);
  const openOrWarnRef = useRef<(p: string) => Promise<void>>(async () => undefined);

  const toast = useCallback((message: string) => setToastText(message), []);
  const pack = useBoardPack(outputRoot, boards, toast, gate);
  const updateRestart = useCallback(async () => {
    try {
      const r = await prep.prepare();
      toast(r.ok ? "准备就绪：画板与界面状态已保存（自动安装接入见 #12）" : r.reason);
    } finally {
      prep.release();
    }
  }, [prep, toast]);
  useEffect(() => {
    if (!toastText) return;
    const timer = setTimeout(() => setToastText(null), 4000);
    return () => clearTimeout(timer);
  }, [toastText]);

  const openOrWarn = useCallback(
    async (path: string) => {
      // 第二实例 / 画板里的打开动作在准备期间忽略（不多开标签页、不产生界面状态变更）。
      if (guardPreparation()) return;
      const found = await openPath(path, true).catch(() => false);
      if (!found && !guardPreparation()) toast(`找不到画板文件：${path}`);
    },
    [openPath, toast, guardPreparation],
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
    [boards, runner, toast, guardPreparation],
  );

  /** 与运行时相同的上下文算确认项：逐张检测参考图（缺失 / 透明通道）。运行与查看发送文本共用。 */
  const confirmItemsOf = useCallback(
    async (board: Board, ids: string[], root: string) => {
      const { missingNodes, alphaByNode } = await collectRunFacts(imageProbe, board, ids, root);
      return buildConfirmItems(board, table, ids, { discovery: settings.discovery, missingNodes, alphaByNode });
    },
    [settings.discovery, table],
  );

  const startRun = useCallback(
    async (boardKey: string, board: Board, taskIds: string[]) => {
      setConfirm(null);
      if (guardPreparation()) return;
      if (!outputRoot) return;
      const target: RunTarget = { boardKey, boardFile: boards.boardFileName(boardKey), table, outputRoot, baseUrl: settings.settings.base_url, apiKey: settings.apiKey };
      const submitting = runner.submit(target, board, taskIds);
      prep.track(submitting);
      const problems = await submitting;
      if (problems.length && !guardPreparation()) toast(`${problems.length} 个任务提交失败：${problems[0]}`);
    },
    [outputRoot, runner, boards, table, settings.settings.base_url, settings.apiKey, toast, guardPreparation, prep],
  );

  // 单个干净任务直接提交，单个标红 / 没有任务只提示；其余弹二次确认（分派规则见 runDispatch）。
  const openRunConfirm = useCallback(
    async (selectedIds: string[]) => {
      if (!activeKey || !outputRoot) return;
      if (guardPreparation()) return;
      const token = prep.generation();
      await boards.flushAll();
      if (guardPreparation()) return;
      const board = boards.getBoard(activeKey);
      if (!board) return;
      const busy = runner.getSnapshot().board(activeKey).locked;
      const items = await confirmItemsOf(board, runScope(board, selectedIds, busy), outputRoot);
      if (guardPreparation() || token !== prep.generation()) return;
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
    [activeKey, outputRoot, settings.apiKey, boards, runner, confirmItemsOf, startRun, toast, guardPreparation],
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
      if (guardPreparation()) return;
      if (!settings.apiKey) {
        toast("请先在高级设置中填写 API 密钥");
        setSettingsOpen(true);
        return;
      }
      const board = boards.getBoard(activeKey);
      if (!board) return;
      const target: RunTarget = { boardKey: activeKey, boardFile: boards.boardFileName(activeKey), table, outputRoot, baseUrl: settings.settings.base_url, apiKey: settings.apiKey };
      const regenerating = runner.regenerate(target, board, taskNodeId, fromTaskId);
      prep.track(regenerating);
      const problem = await regenerating;
      if (problem && !guardPreparation()) toast(`${fromTaskId ? "生成变体" : "重新生成"}失败：${problem}`);
    },
    [activeKey, outputRoot, boards, runner, settings.apiKey, settings.settings.base_url, table, toast, guardPreparation, prep],
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
      if (guardPreparation()) return;
      const token = prep.generation();
      const count = runner.getSnapshot().pending(key);
      if (count > 0 && !(await confirmStopTasks(count))) return;
      if (guardPreparation() || token !== prep.generation()) return;
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

  const uiWriteChain = useRef(Promise.resolve());
  const writeUi = useCallback(() => {
    const { sessions: list, activeKey: key } = boards.snapshot();
    const active = list.find((s) => s.key === key);
    const text = serializeUiState({ window: windowSize.current, open_boards: list.map((s) => s.path), active_board: active?.path ?? null });
    const write = uiWriteChain.current.then(() => ipc.writeUiState(text));
    uiWriteChain.current = write.catch(() => undefined);
    return write;
  }, [boards]);
  const persistUi = useCallback(() => guardPreparation() ? Promise.resolve() : writeUi().catch(() => undefined), [writeUi, guardPreparation]);
  const persistRef = useRef(persistUi);
  persistRef.current = persistUi;
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  persistStrictRef.current = async () => {
    clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = undefined;
    await writeUi();
  };

  const uiSignature = JSON.stringify([sessions.map((s) => s.path), sessions.find((s) => s.key === activeKey)?.path]);
  useEffect(() => {
    if (ready) void persistRef.current();
  }, [ready, uiSignature]);

  useEffect(() => {
    const win = getCurrentWindow();
    const resized = win.onResized(({ payload }) => {
      if (guardPreparation()) return;
      const work = (async () => {
        if (await win.isMaximized()) return;
        const logical = payload.toLogical(await win.scaleFactor());
        windowSize.current = { width: Math.round(logical.width), height: Math.round(logical.height) };
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(() => void persistRef.current(), 500);
      })();
      prep.track(work);
      void work.catch(() => undefined);
    });
    // 注册了关闭监听后由前端调用 destroy 关窗（需 core:window:allow-destroy）；保存出错也不能挡住关窗。
    // 有未完成任务时先阻断式确认，全局只弹一次。
    let asking = false;
    const closing = win.onCloseRequested(async (event) => {
      // 更新准备期间一律挡住关窗：保存与检查不能被中途截断。
      if (guardPreparation()) {
        event.preventDefault();
        return;
      }
      const token = prep.generation();
      const count = runner.getSnapshot().pending();
      if (count > 0) {
        event.preventDefault();
        if (asking) return;
        asking = true;
        const confirmed = await confirmStopTasks(count).finally(() => (asking = false));
        if (!confirmed || guardPreparation() || token !== prep.generation()) return;
        runner.cancel({ kind: "all" });
      }
      try {
        await flushAll();
        await persistRef.current();
      } catch (e) {
        console.error("关闭前保存失败", e);
      }
      if (guardPreparation() || token !== prep.generation()) {
        event.preventDefault();
        return;
      }
      if (count > 0) await win.destroy();
    });
    return () => {
      clearTimeout(resizeTimerRef.current);
      void resized.then((fn) => fn());
      void closing.then((fn) => fn());
    };
  }, [flushAll, runner, guardPreparation]);

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
          onCreate={() => void (!guardPreparation() && createBoard())}
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
            disabled={!outputRoot || preparing}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setPackMenu((m) => (m ? null : { x: r.left, y: r.bottom + 2 }));
            }}
          >
            画板包 ▾
          </button>
          {update.available && (
            <>
              <button className="topbar-button topbar-update" title="打开下载页" onClick={update.openDownload}>
                ⬇ 新版本 {update.available.version}
              </button>
              <button className="topbar-button" disabled={preparing} onClick={() => void updateRestart()}>
                {preparing ? "正在准备更新…" : "重启并更新"}
              </button>
            </>
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
                  <button onClick={() => void pack.importPack()} disabled={!outputRoot || preparing}>
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
          busy={runState.pending() > 0 || preparing}
          gate={gate}
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
