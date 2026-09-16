// 提示词里的参考图序号（规格第 5 节「图N 改写与校验」）。
// 用户写 `@图N`；发送时中文提示词改写为「图N」、英文改写为 `Image N`。只改发送文本，绝不改写用户文本。

export type PromptLanguage = "zh" | "en";

const TAG = /@图\s*(\d+)/g;
/** 算作引用的写法：`@图N`、`图N`、`Image N`（不区分大小写）。 */
const REFERENCE = /图\s*(\d+)|\bimage\s*(\d+)/gi;

export function promptLanguage(prompt: string): PromptLanguage {
  return /\p{Script=Han}/u.test(prompt.replace(TAG, "")) ? "zh" : "en";
}

export function rewriteImageRefs(prompt: string): string {
  const word = promptLanguage(prompt) === "zh" ? "图" : "Image ";
  return prompt.replace(TAG, (_, n: string) => `${word}${Number(n)}`);
}

function referencedIndexes(texts: string[]): Set<number> {
  const out = new Set<number>();
  for (const text of texts) for (const m of text.matchAll(REFERENCE)) out.add(Number(m[1] ?? m[2]));
  return out;
}

export interface ImageRefCheck {
  /** 红：@图N 序号越界（> 已接端口数，或为 0）。 */
  outOfRange: number[];
  /** 黄：有线但提示词没提到的序号。 */
  unreferenced: number[];
}

/**
 * @param portCount 已接图片端口数（含区域端口）
 * @param options.injected 系统注入句（区域指示固定句等），其中的引用也算
 * @param options.exempt 不参与黄检查的序号（区域端口）
 */
export function checkImageRefs(prompt: string, portCount: number, options: { injected?: string[]; exempt?: number[] } = {}): ImageRefCheck {
  const referenced = referencedIndexes([prompt, ...(options.injected ?? [])]);
  const exempt = new Set(options.exempt ?? []);
  // 红是硬阻断，只认用户明确写的 @图N；「地图5」之类的普通文字不拦。
  const tagged = new Set([...prompt.matchAll(TAG)].map((m) => Number(m[1])));
  const outOfRange = [...tagged].filter((n) => n < 1 || n > portCount).sort((a, b) => a - b);
  const unreferenced = Array.from({ length: portCount }, (_, i) => i + 1).filter((n) => !referenced.has(n) && !exempt.has(n));
  return { outOfRange, unreferenced };
}
