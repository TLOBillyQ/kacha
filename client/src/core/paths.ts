// 路径小工具：前端只拼接与比较字符串，不访问文件系统。Windows 与 POSIX 风格都要支持。

const isWindowsStyle = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
const isAbsolute = (p: string) => isWindowsStyle(p) || p.startsWith("/");
const sepOf = (p: string) => (isWindowsStyle(p) ? "\\" : "/");

export function joinPath(root: string, ...parts: string[]): string {
  const sep = sepOf(root);
  const trimmed = root.replace(/[\\/]+$/, "");
  return [trimmed, ...parts.map((p) => p.replace(/[\\/]+/g, sep))].join(sep);
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? p : p.slice(0, i);
}

export const BOARDS_DIR_NAME = "画板";

export function boardsDir(outputRoot: string): string {
  return joinPath(outputRoot, BOARDS_DIR_NAME);
}

/** 根目录内的文件记为相对路径（正斜杠，跨平台可读），根目录外保留绝对路径。 */
export function toRootRelative(root: string, abs: string): string {
  const windows = isWindowsStyle(root);
  const norm = (p: string) => {
    const s = p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
    return windows ? s.toLowerCase() : s;
  };
  const r = norm(root);
  const a = norm(abs);
  if (a.startsWith(`${r}/`)) return abs.replace(/[\\/]+/g, "/").slice(r.length + 1);
  return abs;
}

export function resolveFromRoot(root: string, path: string): string {
  return isAbsolute(path) ? path : joinPath(root, path);
}
