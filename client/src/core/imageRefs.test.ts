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

describe("@图N 校验", () => {
  it("引用序号 > 已接端口数 = 红；有线未被引用 = 黄", () => {
    expect(checkImageRefs("把@图3 的颜色用到@图1 上", 2)).toEqual({ outOfRange: [3], unreferenced: [2] });
  });

  it("不带 @ 的「图N」/ Image N 也算引用；注入句里的引用也算", () => {
    expect(checkImageRefs("把图2的帽子戴到 Image 1 头上", 3, { injected: ["只修改图3 高亮区域"] })).toEqual({ outOfRange: [], unreferenced: [] });
  });

  it("红只看 @图N：不带 @ 的「地图5」「image 5 of」不算越界", () => {
    expect(checkImageRefs("沿着地图5 的路线，image 5 of the series，@图1", 1)).toEqual({ outOfRange: [], unreferenced: [] });
  });

  it("豁免的端口（区域端口）不参与黄检查；图0 越界", () => {
    expect(checkImageRefs("@图0 @图1", 2, { exempt: [2] })).toEqual({ outOfRange: [0], unreferenced: [] });
  });
});
