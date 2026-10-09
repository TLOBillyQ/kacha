import type { Board, BoardEdge, BoardNode, TaskNode } from "../board";
import { BUILTIN_TABLE } from "../capabilities";
import type { RunDeps } from "../run";
import { createRunner, type RunTarget, type RunnerChange } from "../runner";
import { memoryTaskFs } from "./memoryTaskFs";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const PNG_B64 = btoa(String.fromCharCode(...PNG));
const OK_BODY = JSON.stringify({ metadata: { output: { choices: [{ message: { content: [{ image: PNG_B64 }] } }] } } });

/** 提示词 p 接到每个任务节点；withReference 时 t1 另接参考图 r。 */
export function board(taskIds: string[] = ["t1"], withReference = false): Board {
  const nodes: BoardNode[] = [{ id: "p", type: "prompt", pos: [0, 0], size: [100, 100], extra: {}, text: "一只橘猫" }];
  const edges: BoardEdge[] = [];
  for (const [i, id] of taskIds.entries()) {
    const ports = withReference && i === 0 ? 1 : 0;
    nodes.push({ id, type: "task", pos: [200, i * 300], size: [280, 260], extra: {}, model: "qwen-image-3.0-pro", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, image_ports: ports, layer_decomposition: false, transparent_background: false, last_submitted: null } satisfies TaskNode);
    edges.push({ from: ["p", "out"], to: [id, "positive"], source_layer: null, region: null, system: false, extra: {} });
  }
  if (withReference) {
    nodes.push({ id: "r", type: "reference", pos: [0, 200], size: [100, 100], extra: {}, path: "refs/cat.png", sha256: "a".repeat(64), display_name: "cat.png" });
    edges.push({ from: ["r", "out"], to: [taskIds[0], "image:0"], source_layer: null, region: null, system: false, extra: {} });
  }
  return { format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

/** 一道闸：关着时调用挂起，开闸后逐个放行。 */
function gate() {
  const waiting: (() => void)[] = [];
  return {
    closed: false,
    pass(): Promise<void> {
      return this.closed ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve();
    },
    get held() {
      return waiting.length;
    },
    open() {
      this.closed = false;
      waiting.splice(0).forEach((f) => f());
    },
  };
}

type Reply = { status: number; body: string };

/** 内存 RunDeps + 手摇假时钟 + 记录式画板写入 / 日志；网关按 replies 依次应答（用完后一律成功）。 */
export function harness(opts: { concurrency?: number } = {}) {
  const fs = memoryTaskFs();
  const files = fs.files;
  const requests: string[] = [];
  const replies: Reply[] = [];
  const read = gate();
  const write = gate();
  const gateway = gate();
  let now = Date.parse("2026-09-16T09:15:00Z");
  let timers: { at: number; fn: () => void }[] = [];
  const deps: RunDeps = {
    readFile: async (path) => {
      await read.pass();
      return path === "/root/refs/cat.png" ? PNG : fs.readFile(path);
    },
    writeNewFile: async (path, bytes) => {
      await write.pass();
      return fs.writeNewFile(path, bytes);
    },
    fetch: async (url) => {
      requests.push(url);
      await gateway.pass();
      const r = replies.shift() ?? { status: 200, body: OK_BODY };
      return { status: r.status, headers: { get: () => null }, text: async () => r.body, arrayBuffer: async () => new TextEncoder().encode(r.body).buffer as ArrayBuffer };
    },
    now: () => new Date(now),
    schedule: (ms, fn) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
  };
  const changes: { boardKey: string; change: RunnerChange }[] = [];
  const logs: { kind: string; fields: Record<string, unknown> }[] = [];
  const runner = createRunner({ deps, apply: (boardKey, change) => changes.push({ boardKey, change }), log: (kind, fields) => logs.push({ kind, fields }), concurrency: opts.concurrency ?? 3 });
  const target = (boardKey = "A"): RunTarget => ({ boardKey, boardFile: `${boardKey}.ugcboard`, table: BUILTIN_TABLE, outputRoot: "/root", baseUrl: "http://gw", apiKey: "k" });
  return {
    runner,
    files,
    requests,
    replies,
    read,
    write,
    gateway,
    changes,
    logs,
    target,
    /** 把时钟拨到 ms 之后，触发到点的定时。 */
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      due.forEach((t) => t.fn());
    },
    statuses: (boardKey = "A") => Object.fromEntries(runner.getSnapshot().board(boardKey).statuses),
    locked: (boardKey = "A") => [...runner.getSnapshot().board(boardKey).locked],
    taskDirs: () => new Set([...files.keys()].map((k) => k.split("/").slice(0, 4).join("/"))),
    transitions: () => logs.filter((l) => l.kind === "task").map((l) => `${l.fields.task_node_id}:${l.fields.from_status}→${l.fields.to_status}`),
  };
}

/** 让挂起的 promise 链（含 crypto.subtle 摘要）走完。 */
export async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}
