import { describe, expect, it } from "vitest";
import { basename, boardsDir, dirname, joinPath, resolveFromRoot, toRootRelative } from "./paths";

describe("路径", () => {
  it("按根目录风格拼接", () => {
    expect(joinPath("C:\\Users\\a\\Pictures\\UGC", "画板", "x.ugcboard.json")).toBe("C:\\Users\\a\\Pictures\\UGC\\画板\\x.ugcboard.json");
    expect(joinPath("/Users/a/UGC/", "画板")).toBe("/Users/a/UGC/画板");
    expect(boardsDir("/r")).toBe("/r/画板");
  });

  it("文件名与目录", () => {
    expect(basename("C:\\a\\b\\猫.png")).toBe("猫.png");
    expect(basename("/a/b/猫.png")).toBe("猫.png");
    expect(dirname("C:\\a\\b\\猫.png")).toBe("C:\\a\\b");
    expect(dirname("/a/b/猫.png")).toBe("/a/b");
  });

  it("根目录内转相对路径（正斜杠），根目录外保留绝对路径", () => {
    expect(toRootRelative("C:\\Out", "c:\\out\\2026-09-16\\t\\result.png")).toBe("2026-09-16/t/result.png");
    expect(toRootRelative("/out", "/out/refs/a.png")).toBe("refs/a.png");
    expect(toRootRelative("/out", "/output/a.png")).toBe("/output/a.png");
    expect(toRootRelative("D:\\Out", "E:\\素材\\a.png")).toBe("E:\\素材\\a.png");
  });

  it("相对路径按根目录解析，绝对路径原样", () => {
    expect(resolveFromRoot("C:\\Out", "2026-09-16/t/result.png")).toBe("C:\\Out\\2026-09-16\\t\\result.png");
    expect(resolveFromRoot("/out", "2026-09-16/t/result.png")).toBe("/out/2026-09-16/t/result.png");
    expect(resolveFromRoot("C:\\Out", "E:\\素材\\a.png")).toBe("E:\\素材\\a.png");
    expect(resolveFromRoot("/out", "/abs/a.png")).toBe("/abs/a.png");
  });
});
