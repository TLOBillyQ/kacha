import { describe, expect, it } from "vitest";
import { cancel, cancelWaiting, complete, dispatch, emptyQueue, enqueue, rateLimited } from "./queue";

describe("任务队列调度", () => {
  it("按提交顺序 FIFO 派发，达并发上限后其余排队", () => {
    let q = enqueue(emptyQueue(), ["a", "b", "c", "d"]);
    const first = dispatch(q, 0, 3);
    expect(first.started).toEqual(["a", "b", "c"]);
    q = first.queue;
    expect(q.waiting).toEqual(["d"]);
    expect(dispatch(q, 0, 3).started).toEqual([]);

    q = complete(q, "b");
    const second = dispatch(q, 0, 3);
    expect(second.started).toEqual(["d"]);
    expect(second.queue.running).toEqual(["a", "c", "d"]);
  });
});

describe("429 退避", () => {
  it("回队首，等 30 / 60 / 120 s，退避期间整条队列暂停派发，第四次 429 按失败", () => {
    let q = dispatch(enqueue(emptyQueue(), ["a", "b"]), 0, 1).queue;

    const r1 = rateLimited(q, "a", 1_000);
    expect(r1.outcome).toEqual({ kind: "retry", retryAt: 31_000 });
    q = r1.queue;
    expect(q.waiting).toEqual(["a", "b"]);
    expect(q.running).toEqual([]);
    expect(dispatch(q, 30_999, 3).started).toEqual([]);

    let d = dispatch(q, 31_000, 1);
    expect(d.started).toEqual(["a"]);
    const r2 = rateLimited(d.queue, "a", 40_000);
    expect(r2.outcome).toEqual({ kind: "retry", retryAt: 100_000 });

    d = dispatch(r2.queue, 100_000, 1);
    const r3 = rateLimited(d.queue, "a", 100_000);
    expect(r3.outcome).toEqual({ kind: "retry", retryAt: 220_000 });

    d = dispatch(r3.queue, 220_000, 1);
    const r4 = rateLimited(d.queue, "a", 220_000);
    expect(r4.outcome).toEqual({ kind: "failed" });
    expect(r4.queue.waiting).toEqual(["b"]);
    expect(dispatch(r4.queue, 220_000, 1).started).toEqual(["b"]);
  });

  it("多个执行中任务先后 429：按先后回到队首，暂停到最晚的恢复时刻", () => {
    let q = dispatch(enqueue(emptyQueue(), ["a", "b", "c"]), 0, 2).queue;
    q = rateLimited(q, "a", 0).queue;
    const rb = rateLimited(q, "b", 10_000);
    expect(rb.outcome).toEqual({ kind: "retry", retryAt: 40_000 });
    expect(rb.queue.waiting).toEqual(["a", "b", "c"]);
    expect(dispatch(rb.queue, 39_000, 2).started).toEqual([]);
    expect(dispatch(rb.queue, 40_000, 2).started).toEqual(["a", "b"]);
  });
});

describe("取消", () => {
  it("排队中直接出队；执行中出执行集并报告曾在执行；不在队列里为 null", () => {
    let q = dispatch(enqueue(emptyQueue(), ["a", "b", "c"]), 0, 1).queue;
    let r = cancel(q, "b");
    expect(r.was).toBe("waiting");
    expect(r.queue.waiting).toEqual(["c"]);
    r = cancel(r.queue, "a");
    expect(r.was).toBe("running");
    expect(dispatch(r.queue, 0, 1).started).toEqual(["c"]);
    expect(cancel(r.queue, "zzz").was).toBeNull();
  });

  it("取消全部排队：执行中的不动，返回被取消的任务", () => {
    const q = dispatch(enqueue(emptyQueue(), ["a", "b", "c"]), 0, 1).queue;
    const r = cancelWaiting(q);
    expect(r.cancelled).toEqual(["b", "c"]);
    expect(r.queue).toMatchObject({ waiting: [], running: ["a"] });
  });
});
