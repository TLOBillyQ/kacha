// 重新定位（规格第 9.4 节）：画板引用的图片缺失时，在输出根目录内按身份找回；不扫全盘。
// 结果按 task_id 找任务目录，参考图按 sha256 找文件。文件系统由调用方注入。
import { BOARDS_DIR_NAME, joinPath } from "./paths";
import { taskDirOfTaskId } from "./taskDir";

export interface RelocateFs {
  listDir(absDir: string): Promise<{ name: string; is_dir: boolean }[]>;
  exists(absPath: string): Promise<boolean>;
  sha256(absPath: string): Promise<string>;
}

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "heic", "heif"];

const isImageName = (name: string) => IMAGE_EXTENSIONS.includes(name.slice(name.lastIndexOf(".") + 1).toLowerCase());
const quiet = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

/** 结果：先看 task_id 推导出的任务目录，再看根目录各一级子目录下的同名任务目录。 */
export async function findResultFile(fs: RelocateFs, root: string, ref: { task_id: string; file: string }): Promise<string | null> {
  const dir = taskDirOfTaskId(ref.task_id);
  if (dir) {
    const expected = joinPath(root, ...dir.split("/"), ref.file);
    if (await quiet(fs.exists(expected), false)) return expected;
  }
  for (const entry of await quiet(fs.listDir(root), [])) {
    if (!entry.is_dir || entry.name === BOARDS_DIR_NAME) continue;
    const candidate = joinPath(root, entry.name, ref.task_id, ref.file);
    if (await quiet(fs.exists(candidate), false)) return candidate;
  }
  return null;
}

/** 参考图：递归列出根目录内的图片文件（跳过画板目录），与原文件名同名的先算哈希。 */
export async function findReferenceFile(fs: RelocateFs, root: string, ref: { sha256: string; display_name: string }): Promise<string | null> {
  const images: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of await quiet(fs.listDir(dir), [])) {
      const path = joinPath(dir, entry.name);
      if (entry.is_dir) {
        if (!(dir === root && entry.name === BOARDS_DIR_NAME)) stack.push(path);
      } else if (isImageName(entry.name)) {
        images.push(path);
      }
    }
  }
  const wanted = ref.display_name.toLowerCase();
  const nameOf = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1).toLowerCase();
  const ordered = [...images.filter((p) => nameOf(p) === wanted), ...images.filter((p) => nameOf(p) !== wanted)];
  for (const path of ordered) {
    if ((await quiet(fs.sha256(path), "")) === ref.sha256) return path;
  }
  return null;
}
