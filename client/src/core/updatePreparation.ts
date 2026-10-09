// 更新重启前共享保护：阻止新操作，等待已开始的操作，严格保存后保持到安装结束。
export const BUSY_MESSAGE = "任务结束后可更新";
export type PreparationResult = { ok: true } | { ok: false; reason: string };

export interface UpdateQueue {
  pending(): number;
  setSubmissionGuard(guard: (() => void) | null): void;
}

export interface OperationGate {
  blocked(): boolean;
  track(operation: Promise<unknown>): void;
}

export interface UpdatePreparationPorts {
  queue: UpdateQueue;
  saveBoards(): Promise<void>;
  saveUi(): Promise<void>;
  onProtectionChange?(active: boolean): void;
}

export interface UpdatePreparation extends OperationGate {
  prepare(): Promise<PreparationResult>;
  /** 可直接注入 #12 的 UpdateFlowPorts.restartGuard；允许后保持保护到安装结束。 */
  restartGuard(): Promise<{ allowed: boolean; reason?: string }>;
  release(): void;
  active(): boolean;
  /** 异步 UI 操作持有代次；失败恢复后旧操作仍不可提交变更。 */
  generation(): number;
}

const text = (e: unknown) => e instanceof Error ? e.message : String(e);

export function createUpdatePreparation(ports: UpdatePreparationPorts): UpdatePreparation {
  const pending = new Set<Promise<unknown>>();
  let current: Promise<PreparationResult> | null = null;
  let protectedNow = false;
  let generation = 0;

  function release() {
    protectedNow = false;
    current = null;
    ports.queue.setSubmissionGuard(null);
    ports.onProtectionChange?.(false);
  }

  async function run(): Promise<PreparationResult> {
    try {
      // 已在读图 / 排队 / 执行 / 退避的任务继续执行，不等结束、不取消。
      if (ports.queue.pending() > 0) return { ok: false, reason: BUSY_MESSAGE };
      let operationFailure: PromiseRejectedResult | undefined;
      while (pending.size) {
        const batch = [...pending];
        const results = await Promise.allSettled(batch);
        operationFailure ??= results.find((r): r is PromiseRejectedResult => r.status === "rejected");
        for (const p of batch) pending.delete(p);
      }
      if (operationFailure) throw operationFailure.reason;
      if (ports.queue.pending() > 0) return { ok: false, reason: BUSY_MESSAGE };
      const [boards, ui] = await Promise.allSettled([
        Promise.resolve().then(ports.saveBoards), Promise.resolve().then(ports.saveUi),
      ]);
      if (boards.status === "rejected") return { ok: false, reason: `保存画板失败：${text(boards.reason)}` };
      if (ui.status === "rejected") return { ok: false, reason: `保存界面状态失败：${text(ui.reason)}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `更新准备失败：${text(e)}` };
    }
  }

  const preparation: UpdatePreparation = {
    prepare() {
      if (current) return current;
      if (ports.queue.pending() > 0) return Promise.resolve({ ok: false, reason: BUSY_MESSAGE });
      protectedNow = true;
      generation++;
      ports.queue.setSubmissionGuard(() => undefined);
      ports.onProtectionChange?.(true);
      current = run().then((result) => {
        if (!result.ok) release();
        return result;
      });
      return current;
    },
    release,
    async restartGuard() {
      const result = await preparation.prepare();
      return result.ok ? { allowed: true } : { allowed: false, reason: result.reason };
    },
    track(operation) {
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    },
    active: () => protectedNow,
    blocked: () => protectedNow,
    generation: () => generation,
  };
  return preparation;
}
