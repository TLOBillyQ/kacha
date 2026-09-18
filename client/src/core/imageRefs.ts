// 提示词里的参考图序号：「图N」改写与校验。
// 用户写 `@图N`；发送时中文提示词改写为「图N」、英文改写为 `Image N`。只改发送文本，绝不改写用户文本。
// 「图N」按用户序号（只数用户接的图片连线）；区域叠加图插在原图之后，发送时把用户序号换算成发送序号（#113）。

export type PromptLanguage = "zh" | "en";

const TAG = /@图\s*(\d+)/g;
/** 以「图」结尾的常见词：后面跟数字也不是在引用参考图（「地图2」「截图3」「示意图2」）。 */
const NOT_A_REF = "地|插|配|附|草|截|蓝|构|视|贴|拼|制|绘|作|底|示意|效果|线稿|素材|分镜|流程";
/**
 * 算作引用的写法：`@图N`、不带 @ 的「图N」（前面是 NOT_A_REF 里的词时不算）、`Image N`（不区分大小写）。
 * 换算与黄检查共用，保证「算作引用」的就一定被换算。
 */
const REFERENCE = new RegExp(`@图\\s*(?<tagged>\\d+)|(?<!${NOT_A_REF})(?<zhWord>图\\s*)(?<zhN>\\d+)|(?<enWord>\\bimage\\s*)(?<enN>\\d+)`, "gi");

export function promptLanguage(prompt: string): PromptLanguage {
  return /\p{Script=Han}/u.test(prompt.replace(TAG, "")) ? "zh" : "en";
}

/**
 * @param imageRefMap 用户序号 → 发送序号（第 N-1 项为用户图N 的发送序号）；缺省 = 恒等。越界序号原样保留。
 */
export function rewriteImageRefs(prompt: string, imageRefMap?: number[]): string {
  const word = promptLanguage(prompt) === "zh" ? "图" : "Image ";
  const send = (n: number) => imageRefMap?.[n - 1] ?? n;
  return prompt.replace(REFERENCE, (match, ...args) => {
    const { tagged, zhWord, zhN, enWord, enN } = args[args.length - 1] as Record<string, string | undefined>;
    if (tagged !== undefined) return `${word}${send(Number(tagged))}`;
    const [prefix, digits] = zhN !== undefined ? [zhWord, zhN] : [enWord, enN];
    const n = Number(digits);
    return send(n) === n ? match : `${prefix}${send(n)}`;
  });
}

function referencedIndexes(texts: string[]): Set<number> {
  const out = new Set<number>();
  for (const text of texts) for (const m of text.matchAll(REFERENCE)) out.add(Number(m.groups!.tagged ?? m.groups!.zhN ?? m.groups!.enN));
  return out;
}

export interface ImageRefCheck {
  /** 红：@图N 序号越界（> 已接端口数，或为 0）。 */
  outOfRange: number[];
  /** 黄：有线但提示词没提到的序号。 */
  unreferenced: number[];
}

/**
 * 全部按用户序号判断；区域叠加图没有用户序号，不参与黄检查，也不能被用户引用。
 * @param portCount 用户图片连线数（不含区域端口）
 * @param options.injected 系统注入句（区域指示固定句等），按发送序号书写，其中的引用也算
 * @param options.imageRefMap 用户序号 → 发送序号，用于把注入句里的引用换回用户序号；缺省 = 恒等
 */
export function checkImageRefs(prompt: string, portCount: number, options: { injected?: string[]; imageRefMap?: number[] } = {}): ImageRefCheck {
  const map = options.imageRefMap;
  const injected = [...referencedIndexes(options.injected ?? [])].flatMap((s) => {
    if (!map) return [s];
    const user = map.indexOf(s);
    return user < 0 ? [] : [user + 1];
  });
  const referenced = new Set([...referencedIndexes([prompt]), ...injected]);
  // 红是硬阻断，只认用户明确写的 @图N；「地图5」之类的普通文字不拦。
  const tagged = new Set([...prompt.matchAll(TAG)].map((m) => Number(m[1])));
  const outOfRange = [...tagged].filter((n) => n < 1 || n > portCount).sort((a, b) => a - b);
  const unreferenced = Array.from({ length: portCount }, (_, i) => i + 1).filter((n) => !referenced.has(n));
  return { outOfRange, unreferenced };
}
