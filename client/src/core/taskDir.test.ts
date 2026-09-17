import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE } from "./capabilities";
import { layersExportJson, newTaskId, parseOutcome, saveLayers, saveResult, sha256Hex, sniffImage, tableDigest, taskDirOf, taskDirOfTaskId, writeOutcome, writeSubmission, type SubmissionPlan } from "./taskDir";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const WEBP = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");

function memoryFs() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    text: (path: string) => new TextDecoder().decode(files.get(path)),
    writeNewFile: async (path: string, bytes: Uint8Array) => {
      if (files.has(path)) throw new Error(`${path} 已存在`);
      files.set(path, bytes);
    },
  };
}

const now = new Date("2026-09-16T09:15:00.123Z");

describe("任务编号与目录", () => {
  it("task_id = UTC 时间戳 + 8 位十六进制；目录 = <UTC 日期>/<task_id>", () => {
    const id = newTaskId(now, () => 0x3f9c2a1b);
    expect(id).toBe("20260916T091500Z-3f9c2a1b");
    expect(taskDirOf(now, id)).toBe("2026-09-16/20260916T091500Z-3f9c2a1b");
    // 本地已是次日也按 UTC 日期归档。
    expect(taskDirOf(new Date("2026-09-16T23:30:00Z"), "x")).toBe("2026-09-16/x");
    expect(newTaskId(now, () => 5)).toMatch(/-00000005$/);
    expect(taskDirOfTaskId(id)).toBe("2026-09-16/20260916T091500Z-3f9c2a1b");
    expect(taskDirOfTaskId("not-a-task")).toBeNull();
  });
});

describe("图片格式识别", () => {
  it("按文件头识别扩展名与媒体类型", () => {
    expect(sniffImage(PNG)).toEqual({ ext: "png", mediaType: "image/png" });
    expect(sniffImage(JPEG)).toEqual({ ext: "jpg", mediaType: "image/jpeg" });
    expect(sniffImage(WEBP)).toEqual({ ext: "webp", mediaType: "image/webp" });
    expect(sniffImage(new TextEncoder().encode("BM\0\0"))).toEqual({ ext: "bmp", mediaType: "image/bmp" });
    expect(sniffImage(new TextEncoder().encode("<html>"))).toBeNull();
  });
});

describe("sha256", () => {
  it("十六进制摘要；能力表摘要基于生效表的 JSON", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await tableDigest(BUILTIN_TABLE)).toBe(await sha256Hex(new TextEncoder().encode(JSON.stringify(BUILTIN_TABLE))));
  });
});

describe("提交时写任务目录", () => {
  const plan = (patch: Partial<SubmissionPlan> = {}): SubmissionPlan => ({
    taskId: "20260916T091500Z-3f9c2a1b",
    submittedAt: now,
    model: "qwen-image-3.0-pro",
    prompt: "把图2的帽子戴到图1头上",
    negativePrompt: "模糊",
    sendText: "本次提供 2 张参考图，按顺序为图1、图2。\n把图2的帽子戴到图1头上\n避免出现：模糊",
    regionPhrases: [],
    sizeSpec: { tier: "1K", ratio: "1:1", width: null, height: null },
    size: { width: 1024, height: 1024 },
    layerDecomposition: false,
    transparentBackground: false,
    capabilityFormatVersion: 1,
    capabilityTableSha256: "c".repeat(64),
    references: [
      { bytes: PNG, source: { kind: "reference", path: "refs/a.png", sha256: "a".repeat(64) } },
      { bytes: JPEG, source: { kind: "result", task_id: "old", file: "result.png" } },
    ],
    ...patch,
  });

  it("reference-N.ext 快照 + task.json 完整记录，返回可发送的参考图", async () => {
    const fs = memoryFs();
    const refs = await writeSubmission(fs, "/root", plan());
    const dir = "/root/2026-09-16/20260916T091500Z-3f9c2a1b";
    expect([...fs.files.keys()]).toEqual([`${dir}/reference-1.png`, `${dir}/reference-2.jpg`, `${dir}/task.json`]);
    expect(fs.files.get(`${dir}/reference-1.png`)).toEqual(PNG);
    expect(refs).toEqual([
      { mediaType: "image/png", bytes: PNG },
      { mediaType: "image/jpeg", bytes: JPEG },
    ]);
    const record = JSON.parse(fs.text(`${dir}/task.json`));
    expect(record).toEqual({
      task_id: "20260916T091500Z-3f9c2a1b",
      submitted_at: "2026-09-16T09:15:00.123Z",
      workflow: "image_edit",
      model: "qwen-image-3.0-pro",
      capability_format_version: 1,
      capability_table_sha256: "c".repeat(64),
      prompt: "把图2的帽子戴到图1头上",
      negative_prompt: "模糊",
      send_text: plan().sendText,
      size_spec: { tier: "1K", ratio: "1:1", width: null, height: null },
      size: { width: 1024, height: 1024 },
      layer_decomposition: false,
      transparent_background: false,
      references: [
        { file: "reference-1.png", media_type: "image/png", sha256: await sha256Hex(PNG), source: { kind: "reference", path: "refs/a.png", sha256: "a".repeat(64) } },
        { file: "reference-2.jpg", media_type: "image/jpeg", sha256: await sha256Hex(JPEG), source: { kind: "result", task_id: "old", file: "result.png" } },
      ],
    });
  });

  it("文生图没有参考图文件", async () => {
    const fs = memoryFs();
    await writeSubmission(fs, "/root", plan({ references: [] }));
    expect([...fs.files.keys()]).toEqual(["/root/2026-09-16/20260916T091500Z-3f9c2a1b/task.json"]);
    expect(JSON.parse(fs.text("/root/2026-09-16/20260916T091500Z-3f9c2a1b/task.json")).workflow).toBe("text_to_image");
  });

  it("无法识别的参考图格式在写任何文件前就拒绝", async () => {
    const fs = memoryFs();
    const bad = plan({ references: [{ bytes: new TextEncoder().encode("nope"), source: { kind: "reference", path: "x.txt", sha256: "" } }] });
    await expect(writeSubmission(fs, "/root", bad)).rejects.toThrow("图1 不是可识别的图片格式");
    expect(fs.files.size).toBe(0);
  });

  it("Windows 输出根目录用反斜杠拼接", async () => {
    const fs = memoryFs();
    await writeSubmission(fs, "D:\\出图", plan({ references: [] }));
    expect([...fs.files.keys()]).toEqual(["D:\\出图\\2026-09-16\\20260916T091500Z-3f9c2a1b\\task.json"]);
  });
});

describe("保存结果图", () => {
  it("按文件头定扩展名，返回相对输出根目录的正斜杠路径", async () => {
    const fs = memoryFs();
    const saved = await saveResult(fs, "D:\\出图", "2026-09-16/t1", PNG);
    expect(saved).toEqual({ file: "result.png", path: "2026-09-16/t1/result.png" });
    expect(fs.files.has("D:\\出图\\2026-09-16\\t1\\result.png")).toBe(true);
  });

  it("不是图片时拒绝，不写文件", async () => {
    const fs = memoryFs();
    await expect(saveResult(fs, "/root", "d/t", new TextEncoder().encode("<html>"))).rejects.toThrow("结果不是可识别的图片");
    expect(fs.files.size).toBe(0);
  });
});

describe("结局记录 outcome.json", () => {
  it("失败记脱敏类别，取消记网关侧是否可能仍在计算；读回一致", async () => {
    const fs = memoryFs();
    await writeOutcome(fs, "/root", "2026-09-16/t1", { kind: "failed", label: "网关限流" });
    await writeOutcome(fs, "/root", "2026-09-16/t2", { kind: "cancelled", gatewayMayContinue: false });
    expect(JSON.parse(fs.text("/root/2026-09-16/t1/outcome.json"))).toEqual({ outcome: "failed", label: "网关限流" });
    expect(parseOutcome(fs.files.get("/root/2026-09-16/t1/outcome.json")!)).toEqual({ kind: "failed", label: "网关限流" });
    expect(parseOutcome(fs.files.get("/root/2026-09-16/t2/outcome.json")!)).toEqual({ kind: "cancelled", gatewayMayContinue: false });
  });

  it("读不懂的内容当作没有记录", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(parseOutcome(bytes("{"))).toBeNull();
    expect(parseOutcome(bytes('{"outcome":"exploded"}'))).toBeNull();
    expect(parseOutcome(bytes('{"outcome":"failed"}'))).toBeNull();
  });
});

describe("图层落盘与导出", () => {
  it("按 z_index 升序写 layers/NN.<ext>，返回图层记录", async () => {
    const fs = memoryFs();
    const layers = await saveLayers(fs, "/root", "2026-09-16/t", [
      { bytes: JPEG, zIndex: 2, boundingBox: [0, 0, 10, 10] },
      { bytes: PNG, zIndex: 1, boundingBox: [5, 5, 20, 20] },
    ]);
    expect([...fs.files.keys()]).toEqual(["/root/2026-09-16/t/layers/01.png", "/root/2026-09-16/t/layers/02.jpg"]);
    expect(layers).toEqual([
      { file: "layers/01.png", z_index: 1, bounding_box: [5, 5, 20, 20] },
      { file: "layers/02.jpg", z_index: 2, bounding_box: [0, 0, 10, 10] },
    ]);
  });

  it("不是图片的图层报错且不落盘", async () => {
    const fs = memoryFs();
    await expect(saveLayers(fs, "/root", "d", [{ bytes: new TextEncoder().encode("x"), zIndex: 1, boundingBox: [] }])).rejects.toThrow("图层1 不是可识别的图片");
    expect(fs.files.size).toBe(0);
  });

  it("layers.json 导出内容与图层记录一致", () => {
    const text = layersExportJson([{ file: "layers/01.png", z_index: 1, bounding_box: [5, 5, 20, 20] }]);
    expect(JSON.parse(text)).toEqual({ layers: [{ file: "layers/01.png", z_index: 1, bounding_box: [5, 5, 20, 20] }] });
  });
});
