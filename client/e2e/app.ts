// spec 侧辅助：PNG 生成、画板构造、带场景启动应用。
import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { OUTPUT_ROOT, scenario, type Scenario } from "./scenario";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** 纯色 PNG（base64）。alpha = true 时颜色类型 6（带透明通道），否则 2。 */
export function png(width: number, height: number, opts: { alpha?: boolean; rgb?: [number, number, number] } = {}): string {
  const [r, g, b] = opts.rgb ?? [80, 120, 200];
  const bpp = opts.alpha ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opts.alpha ? 6 : 2;
  const row = Buffer.alloc(1 + width * bpp);
  for (let x = 0; x < width; x++) row.set(opts.alpha ? [r, g, b, 128] : [r, g, b], 1 + x * bpp);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

type Json = Record<string, unknown>;
export const boardPath = (title: string) => `${OUTPUT_ROOT}/画板/${title}.ugcboard.json`;

export const promptNode = (id: string, text: string, pos: [number, number] = [0, 0]) => ({ id, type: "prompt", pos, size: [240, 140], text });
export const referenceNode = (id: string, path: string, pos: [number, number] = [0, 200]) => ({
  id, type: "reference", pos, size: [200, 200], path, sha256: "0".repeat(64), display_name: path.split("/").pop(),
});
export const taskNode = (id: string, over: Json = {}, pos: [number, number] = [400, 0]) => ({
  id, type: "task", pos, size: [320, 360], model: "qwen-image-3.0-pro",
  size_spec: { tier: "1K", ratio: "1:1", width: null, height: null },
  image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null, ...over,
});
export const edge = (from: string, to: string, port: string, over: Json = {}) => ({ from: [from, "out"], to: [to, port], source_layer: null, region: null, ...over });

export function board(title: string, nodes: unknown[], edges: unknown[]) {
  return JSON.stringify({ format_version: 1, title, viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges }, null, 2);
}

export const MODELS = ["qwen-image-3.0-pro", "qwen-image-3.0", "doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-lite-260128"];
export const GW = "http://localhost:1421/gw";

/** 打开单个画板的场景：画板文件 + ui_state + 网关设置 + 模型缓存 + API 密钥。 */
export function boardScenario(title: string, boardText: string, partial: Partial<Scenario> = {}): Scenario {
  const path = boardPath(title);
  return scenario({
    settings: JSON.stringify({ format_version: 1, base_url: GW, output_root: null, concurrency: 4 }),
    modelsCache: JSON.stringify({ base_url: GW, model_ids: MODELS, fetched_at: new Date().toISOString() }),
    uiState: JSON.stringify({ window: null, open_boards: [path], active_board: path }),
    secret: "sk-e2e",
    ...partial,
    files: { [path]: { text: boardText }, ...partial.files },
  });
}

export async function openApp(page: Page, scn: Scenario) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // 网关默认：模型列表；更新检查等其他请求一律 404。
  await page.route(`${GW}/**`, (route) => {
    if (route.request().url().endsWith("/v1/models")) return route.fulfill({ json: { data: MODELS.map((id) => ({ id })) } });
    return route.fulfill({ status: 404, body: "not mocked" });
  });
  await page.addInitScript((s) => ((window as unknown as { __E2E_SCENARIO__: Scenario }).__E2E_SCENARIO__ = s), scn);
  await page.goto("/e2e/app.html");
  return errors;
}

export const task = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
