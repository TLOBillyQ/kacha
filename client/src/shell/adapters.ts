// core 端口的真适配器集中在这里（#128）：ui 只 import 使用，不在调用点就地拼。测试侧各自就地拼伪实现。
import type { PackFs } from "../core/boardPack";
import type { RelocateFs } from "../core/relocate";
import type { RunDeps } from "../core/run";
import type { TaskFs } from "../core/taskDir";
import { imageCodec } from "./imageCodec";
import { httpFetch, ipc } from "./ipc";
import { composeOverlay } from "./overlay";

export const taskFs: TaskFs = {
  writeNewFile: ipc.writeNewFile,
};

export const runDeps: RunDeps = {
  ...taskFs,
  readBytes: ipc.readFileBytes,
  fetch: httpFetch,
  now: () => new Date(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  composeOverlay,
  imageCodec,
};

/** 哈希走 fileSha256（原始字节，不要求可解码）；候选已按扩展名过滤。 */
export const relocateFs: RelocateFs = {
  listDir: ipc.listDir,
  isFile: ipc.isFile,
  sha256: ipc.fileSha256,
};

export const packFs: PackFs = {
  isFile: ipc.isFile,
  sha256: ipc.fileSha256,
};
