// 任务运行器（ADR 0015）：提交（读参考图）→ 全局任务队列按并发上限派发（写任务目录 + 提交记录 → 调网关）→ 运行结果。
// 队列跨画板 FIFO；429 自动退避重试，其余错误不重试。任务状态以（画板键, 任务节点 id）为键，只在内存。
// 时钟、文件、网关、画板写入与日志都经端口注入；运行器不直接调 Date.now() / setTimeout。
import type { Board, TaskNode } from "./board";
import type { CapabilityTable } from "./capabilities";
import type { BoardChange } from "./edit";
import { GatewayError } from "./gateway";
import { CancelledError, executeJob, failureLabel, prepareJob, prepareRegenerate, writeJob, type Prepared, type PreparedJob, type RunDeps, type TaskStatus } from "./run";
import { tableDigest, writeOutcome, type TaskOutcome } from "./taskDir";

/** 第 1、2、3 次 429 后的等待；第 4 次按失败。 */
export const BACKOFF_MS = [30_000, 60_000, 120_000];

/** 提交时随任务固化的目标：排队期间改设置不影响已排队任务。 */
export interface RunTarget {
  boardKey: string;
  /** 画板文件名（日志用）。 */
  boardFile: string | null;
  table: CapabilityTable;
  outputRoot: string;
  baseUrl: string;
  apiKey: string;
}

/** 运行器产出的系统变更：提交记录、运行结果。 */
export type RunnerChange = Extract<BoardChange, { kind: "submitted" | "runResult" }>;

/** 进诊断包的日志事件（对外契约，名称与字段不变）。 */
export type RunnerLogKind = "task" | "queue_dispatch" | "rate_limit" | "download";

export interface RunnerPorts {
  deps: RunDeps;
  /** 画板写入（ADR 0014 的 apply）；画板已关闭时由对方忽略。 */
  apply(boardKey: string, change: RunnerChange): void;
  log(kind: RunnerLogKind, fields: Record<string, unknown>): void;
  concurrency: number;
}

/** 运行指示里的一行。 */
export interface ActiveTask {
  taskId: string;
  boardKey: string;
  taskNodeId: string;
  state: "running" | "waiting";
}

export interface BoardRunState {
  /** 本次运行里的任务状态（含失败 / 已取消）；已中断等由任务目录推导的不在这里。 */
  statuses: ReadonlyMap<string, TaskStatus>;
  /** 读图中、排队、执行、退避的任务节点：参数与输入连线锁定（ADR 0014 环境里的锁定集）。 */
  locked: ReadonlySet<string>;
  /** 本次运行经手过的任务编号，用于推导「已中断」。 */
  handled: ReadonlySet<string>;
}

export interface RunnerSnapshot {
  board(boardKey: string): BoardRunState;
  /** 运行指示：执行中在前，排队（含退避）按队列顺序在后。 */
  active: readonly ActiveTask[];
  /** 读图中、排队、执行、退避的任务数；关闭画板 / 退出前确认用。 */
  pending(boardKey?: string): number;
}

export type CancelFilter =
  | { kind: "task"; boardKey: string; taskNodeId: string }
  | { kind: "board"; boardKey: string }
  /** 运行指示「取消全部排队」：读图中、排队、退避的；执行中的不受影响。 */
  | { kind: "waiting" }
  | { kind: "all" };

export interface Runner {
  /** 按顺序读参考图并入队；board 是二次确认时的画板。返回本地提交失败的说明（不含密钥与提示词）。 */
  submit(target: RunTarget, board: Board, taskNodeIds: string[]): Promise<string[]>;
  /** 重新生成 / 生成变体（fromTaskId = 该结果的任务编号）；board 是当前画板。返回本地失败说明。 */
  regenerate(target: RunTarget, board: Board, taskNodeId: string, fromTaskId?: string): Promise<string | null>;
  cancel(filter: CancelFilter): void;
  /** 关闭画板：取消该画板的任务并遗忘它的状态与经手过的任务编号。 */
  closeBoard(boardKey: string): void;
  setConcurrency(limit: number): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): RunnerSnapshot;
}

type Phase = "reading" | "waiting" | "backoff" | "running";

/** 一个任务的记录（读图中 / 等待 / 退避 / 执行中）；结束即删除。 */
interface Job {
  target: RunTarget;
  taskNodeId: string;
  phase: Phase;
  /** 同一次提交的一组任务共用；按画板 / 全部取消时，其中还没读图的不再提交。 */
  submission: { cancelled: boolean };
  prepared?: PreparedJob;
  /** 派发时写到任务节点上；undefined = 不改（生成变体）。 */
  lastSubmitted?: TaskNode["last_submitted"];
  /** 任务目录已写、提交记录已落地（429 重试不再写）。 */
  written: boolean;
  /** 已自动重试的次数（仅 429）。 */
  retries: number;
  startedAt: number;
  controller: AbortController;
}

const EMPTY_BOARD: BoardRunState = { statuses: new Map(), locked: new Set(), handled: new Set() };

/** 日志里的错误字段：只带类别、状态码、网关请求编号与脱敏说明。 */
function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof GatewayError) return { category: error.category, status_code: error.status, gateway_request_id: error.requestId, message: failureLabel(error) };
  return { category: "local", message: failureLabel(error) };
}

export function createRunner(ports: RunnerPorts): Runner {
  const { deps } = ports;
  let limit = ports.concurrency;
  const jobs = new Set<Job>();
  /** 等待派发（含退避），队首在前。 */
  let waiting: Job[] = [];
  let running: Job[] = [];
  /** 429 退避期间整条队列暂停派发，到此刻（毫秒）恢复；0 = 未暂停。 */
  let pausedUntil = 0;
  let cancelTimer: (() => void) | null = null;
  /** 画板键 → 任务节点 id → 终态（失败 / 已取消）。 */
  const finished = new Map<string, Map<string, TaskStatus>>();
  const handled = new Map<string, Set<string>>();
  /** 已关闭的画板键（键不复用）：关闭前已开始、还在算摘要的提交不再入队。 */
  const closed = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot = buildSnapshot();

  const now = () => deps.now().getTime();

  function statusOf(job: Job): TaskStatus {
    switch (job.phase) {
      case "reading":
      case "waiting":
        return { kind: "queued" };
      case "backoff":
        return { kind: "backoff", retryAt: pausedUntil };
      case "running":
        return { kind: "running", startedAt: job.startedAt };
    }
  }

  function buildSnapshot(): RunnerSnapshot {
    const boards = new Map<string, { statuses: Map<string, TaskStatus>; locked: Set<string>; handled: ReadonlySet<string> }>();
    const of = (key: string) => {
      let b = boards.get(key);
      if (!b) boards.set(key, (b = { statuses: new Map(), locked: new Set(), handled: handled.get(key) ?? new Set() }));
      return b;
    };
    for (const [key, statuses] of finished) statuses.forEach((st, id) => of(key).statuses.set(id, st));
    for (const key of handled.keys()) of(key);
    for (const job of jobs) {
      const b = of(job.target.boardKey);
      b.statuses.set(job.taskNodeId, statusOf(job));
      b.locked.add(job.taskNodeId);
    }
    const row = (state: ActiveTask["state"]) => (job: Job): ActiveTask => ({ taskId: job.prepared!.taskId, boardKey: job.target.boardKey, taskNodeId: job.taskNodeId, state });
    const live = [...jobs];
    return {
      board: (key) => boards.get(key) ?? EMPTY_BOARD,
      active: [...running.map(row("running")), ...waiting.map(row("waiting"))],
      pending: (key) => live.filter((j) => key === undefined || j.target.boardKey === key).length,
    };
  }

  function publish() {
    snapshot = buildSnapshot();
    listeners.forEach((l) => l());
  }

  function setFinished(job: Job, status: TaskStatus | null) {
    const key = job.target.boardKey;
    let m = finished.get(key);
    if (status) {
      if (!m) finished.set(key, (m = new Map()));
      m.set(job.taskNodeId, status);
    } else m?.delete(job.taskNodeId);
  }

  /** 任务迁移事件带画板文件名 + 任务节点 id。 */
  function taskFields(job: Job) {
    const p = job.prepared!;
    return { task_id: p.taskId, board_file: job.target.boardFile, task_node_id: job.taskNodeId, model: p.plan.model, workflow: p.plan.references.length ? "image_edit" : "text_to_image" };
  }
  function logTransition(job: Job, from: string | null, to: string, extra: Record<string, unknown> = {}) {
    ports.log("task", { ...taskFields(job), from_status: from, to_status: to, ...extra });
  }

  /** 任务目录已写的任务没有结果时记下结局，重开时据此区分失败 / 已取消 / 已中断；写不了就算了。 */
  function recordOutcome(job: Job, outcome: TaskOutcome) {
    if (job.written) void writeOutcome(deps, job.target.outputRoot, job.prepared!.relDir, outcome).catch(() => undefined);
  }

  function remove(job: Job) {
    jobs.delete(job);
    waiting = waiting.filter((j) => j !== job);
    running = running.filter((j) => j !== job);
  }

  function fail(job: Job, error: unknown) {
    remove(job);
    logTransition(job, "running", "failed", errorFields(error));
    const failed = { kind: "failed" as const, label: failureLabel(error) };
    setFinished(job, failed);
    recordOutcome(job, failed);
  }

  function rateLimited(job: Job, error: unknown) {
    const attempt = job.retries + 1;
    if (job.retries >= BACKOFF_MS.length) {
      ports.log("rate_limit", { ...taskFields(job), attempt, outcome: "failed" });
      fail(job, error);
      return;
    }
    pausedUntil = Math.max(pausedUntil, now() + BACKOFF_MS[job.retries]);
    job.retries = attempt;
    running = running.filter((j) => j !== job);
    // 回队首，排在已在退避的任务之后。
    let head = 0;
    while (head < waiting.length && waiting[head].phase === "backoff") head++;
    waiting.splice(head, 0, job);
    job.phase = "backoff";
    const at = (ms: number) => new Date(ms).toISOString();
    ports.log("rate_limit", { ...taskFields(job), attempt, outcome: "retry", retry_at: at(pausedUntil), queue_paused_until: at(pausedUntil) });
    logTransition(job, "running", "backoff");
  }

  async function execute(job: Job) {
    const { controller, target } = job;
    const aborted = () => controller.signal.aborted;
    try {
      if (!job.written) {
        job.prepared = await writeJob(deps, target.outputRoot, job.prepared!);
        job.written = true;
        if (job.lastSubmitted !== undefined) ports.apply(target.boardKey, { kind: "submitted", taskId: job.taskNodeId, lastSubmitted: job.lastSubmitted });
        // 写目录期间被取消：取消时目录还没写，这里补记结局。
        if (aborted()) recordOutcome(job, { kind: "cancelled", gatewayMayContinue: false });
      }
      if (aborted()) return;
      const prepared = job.prepared!;
      const result = await executeJob(deps, {
        job: prepared,
        outputRoot: target.outputRoot,
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        signal: controller.signal,
        onDownload: (r) => ports.log("download", { task_id: prepared.taskId, model: prepared.plan.model, ...(r.ok ? { ok: true, images: r.images } : { ok: false, ...errorFields(r.error) }) }),
      });
      if (aborted()) return;
      remove(job);
      logTransition(job, "running", "succeeded");
      ports.apply(target.boardKey, { kind: "runResult", result });
      setFinished(job, null);
    } catch (e) {
      if (aborted() || e instanceof CancelledError) return;
      if (e instanceof GatewayError && e.category === "rate_limited") rateLimited(job, e);
      else fail(job, e);
    } finally {
      if (!aborted()) pump();
    }
  }

  /** 从队首派发，直到执行数达到并发上限；暂停中则定时到恢复时刻。 */
  function pump() {
    cancelTimer?.();
    cancelTimer = null;
    const t = now();
    if (t < pausedUntil) {
      if (waiting.length) cancelTimer = deps.schedule(pausedUntil - t, pump);
      publish();
      return;
    }
    const started = waiting.slice(0, Math.max(0, limit - running.length));
    waiting = waiting.slice(started.length);
    running = [...running, ...started];
    for (const job of started) {
      ports.log("queue_dispatch", { ...taskFields(job), running: running.length, waiting: waiting.length, limit });
      logTransition(job, job.phase === "backoff" ? "backoff" : "queued", "running");
      job.phase = "running";
      job.startedAt = t;
      void execute(job);
    }
    publish();
  }

  const occupied = (boardKey: string, taskNodeId: string) => [...jobs].some((j) => j.target.boardKey === boardKey && j.taskNodeId === taskNodeId);

  /** 读参考图并入队；读的期间被取消则不入队。返回本地失败说明。 */
  async function enqueue(target: RunTarget, taskNodeId: string, submission: Job["submission"], prepare: () => Promise<Prepared>): Promise<string | null> {
    if (closed.has(target.boardKey)) return null;
    const job: Job = { target, taskNodeId, phase: "reading", submission, written: false, retries: 0, startedAt: 0, controller: new AbortController() };
    jobs.add(job);
    setFinished(job, null);
    publish();
    try {
      const prepared = await prepare();
      if (job.controller.signal.aborted) return null;
      job.prepared = prepared.job;
      job.lastSubmitted = prepared.lastSubmitted;
      job.phase = "waiting";
      let h = handled.get(target.boardKey);
      if (!h) handled.set(target.boardKey, (h = new Set()));
      h.add(prepared.job.taskId);
      waiting.push(job);
      logTransition(job, null, "queued");
      pump();
      return null;
    } catch (e) {
      if (job.controller.signal.aborted) return null;
      jobs.delete(job);
      setFinished(job, { kind: "failed", label: failureLabel(e) });
      publish();
      return e instanceof Error ? e.message : String(e);
    }
  }

  function cancelJob(job: Job) {
    job.controller.abort();
    const was = job.phase;
    remove(job);
    if (was === "reading") {
      setFinished(job, null);
      return;
    }
    if (was === "waiting") {
      // 从未派发：画板与任务目录都没动过，不留痕迹。
      logTransition(job, "queued", "cancelled", { gateway_may_continue: false });
      setFinished(job, null);
      return;
    }
    // 执行中：请求可能已发出；限流退避中：网关没接这次请求。
    const cancelled = { kind: "cancelled" as const, gatewayMayContinue: was === "running" && job.written };
    logTransition(job, was, "cancelled", { gateway_may_continue: cancelled.gatewayMayContinue });
    setFinished(job, cancelled);
    recordOutcome(job, cancelled);
  }

  function cancel(filter: CancelFilter) {
    const match = (job: Job) => {
      switch (filter.kind) {
        case "task":
          return job.target.boardKey === filter.boardKey && job.taskNodeId === filter.taskNodeId;
        case "board":
          return job.target.boardKey === filter.boardKey;
        case "waiting":
          return job.phase !== "running";
        case "all":
          return true;
      }
    };
    for (const job of [...jobs]) {
      if (!match(job)) continue;
      // 按画板 / 全部取消时，同一次提交里还没读图的任务也不再提交。
      if (filter.kind !== "task") job.submission.cancelled = true;
      cancelJob(job);
    }
    pump();
  }

  async function submit(target: RunTarget, board: Board, taskNodeIds: string[]): Promise<string[]> {
    const problems: string[] = [];
    const submission = { cancelled: false };
    const tableSha256 = await tableDigest(target.table);
    for (const taskNodeId of taskNodeIds) {
      if (submission.cancelled || closed.has(target.boardKey)) break;
      if (occupied(target.boardKey, taskNodeId)) continue;
      const problem = await enqueue(target, taskNodeId, submission, () => prepareJob(deps, { board, table: target.table, tableSha256, outputRoot: target.outputRoot, taskNodeId }));
      if (problem) problems.push(problem);
    }
    return problems;
  }

  async function regenerate(target: RunTarget, board: Board, taskNodeId: string, fromTaskId?: string): Promise<string | null> {
    if (occupied(target.boardKey, taskNodeId)) return null;
    const tableSha256 = await tableDigest(target.table);
    if (occupied(target.boardKey, taskNodeId)) return null;
    return enqueue(target, taskNodeId, { cancelled: false }, () =>
      prepareRegenerate(deps, { board, table: target.table, tableSha256, outputRoot: target.outputRoot, taskNodeId, fromTaskId }),
    );
  }

  return {
    submit,
    regenerate,
    cancel,
    closeBoard(boardKey) {
      closed.add(boardKey);
      cancel({ kind: "board", boardKey });
      finished.delete(boardKey);
      handled.delete(boardKey);
      publish();
    },
    setConcurrency(next) {
      limit = next;
      pump();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };
}
