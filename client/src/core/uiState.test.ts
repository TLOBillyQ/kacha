import { describe, expect, it } from "vitest";
import { DEFAULT_UI_STATE, parseUiState, serializeUiState } from "./uiState";

describe("界面状态 ui-state.json", () => {
  it("往返：窗口尺寸、上次打开列表与当前页", () => {
    const state = { window: { width: 1200, height: 800 }, open_boards: ["/r/画板/a.ugcboard.json", "/r/画板/b.ugcboard.json"], active_board: "/r/画板/b.ugcboard.json" };
    expect(parseUiState(serializeUiState(state))).toEqual(state);
  });

  it("缺失或损坏静默重置为默认", () => {
    expect(parseUiState(null)).toEqual(DEFAULT_UI_STATE);
    expect(parseUiState("{oops")).toEqual(DEFAULT_UI_STATE);
    expect(parseUiState('{"window": "big", "open_boards": [1]}')).toEqual(DEFAULT_UI_STATE);
  });

  it("当前页不在打开列表里时取第一个", () => {
    const text = JSON.stringify({ window: null, open_boards: ["/a"], active_board: "/zzz" });
    expect(parseUiState(text).active_board).toBe("/a");
  });
});
