import { describe, expect, it } from "vitest";
import { findReferenceFile, findResultFile, type RelocateFs } from "./relocate";

/** 内存文件树：路径 → 内容哈希（目录由路径推导）。 */
function memoryFs(files: Record<string, string>) {
  const hashed: string[] = [];
  const listed: string[] = [];
  const fs: RelocateFs = {
    async listDir(dir) {
      listed.push(dir);
      const prefix = `${dir}/`;
      const names = new Map<string, boolean>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const [name, ...rest] = path.slice(prefix.length).split("/");
        names.set(name, rest.length > 0 || names.get(name) === true);
      }
      if (!names.size && !Object.keys(files).some((p) => p.startsWith(prefix))) throw new Error("ENOENT");
      return [...names].map(([name, is_dir]) => ({ name, is_dir }));
    },
    async isFile(path) {
      return path in files;
    },
    async sha256(path) {
      hashed.push(path);
      if (!(path in files)) throw new Error("ENOENT");
      return files[path];
    },
  };
  return { fs, hashed, listed };
}

const ROOT = "/out";

describe("重新定位：结果按 task_id 找", () => {
  it("先看 task_id 推导出的任务目录", async () => {
    const { fs } = memoryFs({ "/out/2026-09-16/20260916T091500Z-0000abcd/result.png": "h" });
    expect(await findResultFile(fs, ROOT, { task_id: "20260916T091500Z-0000abcd", file: "result.png" })).toBe("/out/2026-09-16/20260916T091500Z-0000abcd/result.png");
  });

  it("任务目录被挪到别的日期目录下：在根目录里找同名任务目录", async () => {
    const { fs } = memoryFs({ "/out/归档/20260916T091500Z-0000abcd/result.png": "h", "/out/2026-09-17/x.png": "y" });
    expect(await findResultFile(fs, ROOT, { task_id: "20260916T091500Z-0000abcd", file: "result.png" })).toBe("/out/归档/20260916T091500Z-0000abcd/result.png");
  });

  it("任务目录被挪到更深的目录里：递归找，跳过画板目录", async () => {
    const { fs } = memoryFs({ "/out/画板/20260916T091500Z-0000abcd/result.png": "h", "/out/归档/2026/09/20260916T091500Z-0000abcd/result.png": "h" });
    expect(await findResultFile(fs, ROOT, { task_id: "20260916T091500Z-0000abcd", file: "result.png" })).toBe("/out/归档/2026/09/20260916T091500Z-0000abcd/result.png");
  });

  it("找不到为 null", async () => {
    const { fs } = memoryFs({ "/out/2026-09-16/other/result.png": "h" });
    expect(await findResultFile(fs, ROOT, { task_id: "20260916T091500Z-0000abcd", file: "result.png" })).toBeNull();
  });
});

describe("重新定位：参考图按 sha256 找", () => {
  it("只在输出根目录内递归找图片文件，同名文件先算哈希", async () => {
    const { fs, hashed } = memoryFs({
      "/out/a/other.png": "zzz",
      "/out/b/deep/cat.png": "want",
      "/out/b/notes.txt": "want",
    });
    expect(await findReferenceFile(fs, ROOT, { sha256: "want", display_name: "cat.png" })).toBe("/out/b/deep/cat.png");
    expect(hashed).toEqual(["/out/b/deep/cat.png"]);
  });

  it("改了名也能按哈希找到；跳过画板目录与非图片文件", async () => {
    const { fs, listed } = memoryFs({ "/out/画板/x.png": "want", "/out/renamed.JPG": "want", "/out/notes.txt": "want" });
    expect(await findReferenceFile(fs, ROOT, { sha256: "want", display_name: "cat.png" })).toBe("/out/renamed.JPG");
    expect(listed).not.toContain("/out/画板");
  });

  it("跳过隐藏目录与文件（未清理的导入临时目录、原子写临时文件）", async () => {
    const { fs, listed } = memoryFs({ "/out/.ugcpack-import.1-2-0.tmp/导入参考图/cat.png": "want", "/out/.cat.png.1-2-0.tmp": "want", "/out/导入参考图/cat.png": "want" });
    expect(await findReferenceFile(fs, ROOT, { sha256: "want", display_name: "cat.png" })).toBe("/out/导入参考图/cat.png");
    expect(listed.some((d) => d.includes(".ugcpack-import"))).toBe(false);
  });

  it("找不到为 null；读不了的目录与文件跳过", async () => {
    const { fs } = memoryFs({ "/out/a.png": "nope" });
    expect(await findReferenceFile(fs, ROOT, { sha256: "want", display_name: "cat.png" })).toBeNull();
  });
});
