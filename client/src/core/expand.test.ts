import { describe, expect, it } from "vitest";
import { expandedTasks, forgetOnSelectionChange, toggleExpanded, type ExpandOverrides } from "./expand";

const none: ExpandOverrides = new Map();
const set = (...ids: string[]) => new Set(ids);

describe("任务节点展开：默认跟随选中，手动切换只管到下次选中变化", () => {
  it("选中的展开，未选中的折叠", () => {
    expect(expandedTasks(none, set("a"), ["a", "b"])).toEqual(set("a"));
  });

  it("手动切换覆盖默认：选中的可收起，未选中的可展开", () => {
    const collapsed = toggleExpanded(none, set("a"), "a");
    expect(expandedTasks(collapsed, set("a"), ["a", "b"])).toEqual(set());
    const opened = toggleExpanded(none, set("a"), "b");
    expect(expandedTasks(opened, set("a"), ["a", "b"])).toEqual(set("a", "b"));
    expect(expandedTasks(toggleExpanded(opened, set("a"), "b"), set("a"), ["a", "b"])).toEqual(set("a"));
  });

  it("节点的选中状态变化后忘掉它的手动切换，其余节点不受影响；没有可忘的返回原对象", () => {
    const overrides = toggleExpanded(toggleExpanded(none, set("a"), "a"), set("a"), "b");
    const next = forgetOnSelectionChange(overrides, set("a"), set("c"));
    expect(expandedTasks(next, set("c"), ["a", "b", "c"])).toEqual(set("b", "c"));
    expect(forgetOnSelectionChange(overrides, set("a"), set("a", "c"))).toBe(overrides);
  });

  it("不在画板上的节点不留状态", () => {
    const overrides = toggleExpanded(none, set(), "gone");
    expect(expandedTasks(overrides, set("gone"), ["a"])).toEqual(set());
  });
});
