import { describe, expect, it } from "vitest";
import { checkImageRefs, promptLanguage, rewriteImageRefs } from "./imageRefs";

describe("@图N 改写", () => {
  it("中文提示词改写为「图N」，英文提示词改写为 Image N；不带 @ 的原样保留", () => {
    expect(rewriteImageRefs("把@图2的帽子戴到@图1头上，图3 不动")).toBe("把图2的帽子戴到图1头上，图3 不动");
    expect(rewriteImageRefs("Put the hat from @图2 on @图1")).toBe("Put the hat from Image 2 on Image 1");
  });

  it("语言按用户文本（去掉 @图N 标记）里是否有汉字判定", () => {
    expect(promptLanguage("@图1 in watercolor")).toBe("en");
    expect(promptLanguage("@图1 水彩风格")).toBe("zh");
  });
});

describe("用户序号 → 发送序号换算", () => {
  // 三张用户图，图1、图2 各带区域：发送序 图1 叠加 图2 叠加 图3 → 用户 1/2/3 对应发送 1/3/5。
  const map = [1, 3, 5];

  it("@图N、不带 @ 的图N、Image N 都按对应关系换算", () => {
    expect(rewriteImageRefs("把@图2的少女放入@图1，图3 当背景", map)).toBe("把图3的少女放入图1，图5 当背景");
    expect(rewriteImageRefs("Put @图2 into image 1, keep Image 3", map)).toBe("Put Image 3 into image 1, keep Image 5");
  });

  it("前面是普通汉字的「图N」照常换算（把图2、放入图1）", () => {
    expect(rewriteImageRefs("把图2的少女放入图1的框选区域", [1, 3])).toBe("把图3的少女放入图1的框选区域");
  });

  it("以「图」结尾的词（地图、截图、示意图…）后接数字不算引用，原样保留", () => {
    expect(rewriteImageRefs("沿着地图2 走，参考截图3 和示意图2，图2 放中间", map)).toBe("沿着地图2 走，参考截图3 和示意图2，图3 放中间");
  });

  it("越界序号原样保留（@ 照常去掉），交给校验标红", () => {
    expect(rewriteImageRefs("@图4 和 图0", map)).toBe("图4 和 图0");
  });

  it("恒等对应关系 / 不给对应关系：与只改 @ 标记时一致", () => {
    const text = "把@图2的帽子戴到@图1头上，图 3 不动，地图2";
    expect(rewriteImageRefs(text, [1, 2, 3])).toBe(rewriteImageRefs(text));
    expect(rewriteImageRefs(text)).toBe("把图2的帽子戴到图1头上，图 3 不动，地图2");
  });
});

describe("@图N 校验", () => {
  it("引用序号 > 已接端口数 = 红；有线未被引用 = 黄", () => {
    expect(checkImageRefs("把@图3 的颜色用到@图1 上", 2)).toEqual({ outOfRange: [3], unreferenced: [2] });
  });

  it("不带 @ 的「图N」/ Image N 也算引用；注入句里的引用也算", () => {
    expect(checkImageRefs("把图2的帽子戴到 Image 1 头上", 3, { injected: ["只修改图3 高亮区域"] })).toEqual({ outOfRange: [], unreferenced: [] });
  });

  it("换算与校验同一口径：「地图2」不算引用图2，「把图2」算", () => {
    expect(checkImageRefs("沿着地图2 走，把图1 调亮", 2)).toEqual({ outOfRange: [], unreferenced: [2] });
    expect(checkImageRefs("把图2 放进图1", 2)).toEqual({ outOfRange: [], unreferenced: [] });
  });

  it("红只看 @图N：不带 @ 的「地图5」「image 5 of」不算越界", () => {
    expect(checkImageRefs("沿着地图5 的路线，image 5 of the series，@图1", 1)).toEqual({ outOfRange: [], unreferenced: [] });
  });

  it("图0 越界", () => {
    expect(checkImageRefs("@图0 @图1", 1)).toEqual({ outOfRange: [0], unreferenced: [] });
  });

  it("注入句按发送序号书写：换回用户序号再算引用，叠加图的发送序号不对应任何用户图", () => {
    // 两张用户图，图2 带区域：发送序 图1 图2 叠加 → 对应 [1, 2]，叠加是发送图3。
    expect(checkImageRefs("@图1", 2, { injected: ["图3 是图2 的标注版"], imageRefMap: [1, 2] })).toEqual({ outOfRange: [], unreferenced: [] });
    // 图1 带区域：对应 [1, 3]，固定句「图2 是图1 的标注版」只让用户图1 算引用。
    expect(checkImageRefs("", 2, { injected: ["图2 是图1 的标注版"], imageRefMap: [1, 3] })).toEqual({ outOfRange: [], unreferenced: [2] });
  });
});
