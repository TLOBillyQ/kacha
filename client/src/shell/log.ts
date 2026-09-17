// 脱敏日志的前端入口（规格第 12 节）：只经 IPC log_event 交给 Rust 壳，脱敏、轮转、容量都在壳里。
// 调用方只传类别、编号、状态码等结构化字段，不传提示词、图片、密钥与下载地址；写失败静默忽略。
import { ipc } from "./ipc";

// 与 src-tauri/src/logger.rs 的 EVENT_KINDS 保持一致；未知类别会被外壳拒绝。
export type LogKind = "task" | "connection" | "download" | "system" | "board_save_failed" | "relocate" | "rate_limit" | "queue_dispatch";

export function logEvent(kind: LogKind, fields: Record<string, unknown>): void {
  void ipc.logEvent(kind, fields).catch(() => undefined);
}
