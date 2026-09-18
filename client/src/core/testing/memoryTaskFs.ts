// 测试用内存版任务目录文件系统：语义与壳层 IPC 一致——writeNewFile 遇已存在即抛，readFile 缺失即抛。
export function memoryTaskFs(initial: Iterable<readonly [string, Uint8Array]> = []) {
  const files = new Map<string, Uint8Array>(initial);
  return {
    files,
    text: (path: string) => new TextDecoder().decode(files.get(path)),
    writeNewFile: async (path: string, bytes: Uint8Array) => {
      if (files.has(path)) throw new Error(`${path} 已存在`);
      files.set(path, bytes);
    },
    readFile: async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`${path} 不存在`);
      return bytes;
    },
  };
}
