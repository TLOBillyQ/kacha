// 任务节点参数的原地展开：默认跟随选中（选中展开、未选中折叠），手动切换只在本地、不存盘，
// 且只管到该节点下一次选中状态变化为止。

/** 手动切换过的任务节点 → 是否展开。 */
export type ExpandOverrides = ReadonlyMap<string, boolean>;

/** 当前展开的任务节点；ids 为画板上现有的节点，不在其中的不算。 */
export function expandedTasks(overrides: ExpandOverrides, selected: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  return new Set(ids.filter((id) => overrides.get(id) ?? selected.has(id)));
}

export function toggleExpanded(overrides: ExpandOverrides, selected: ReadonlySet<string>, id: string): ExpandOverrides {
  return new Map([...overrides, [id, !(overrides.get(id) ?? selected.has(id))]]);
}

/** 选区从 before 变为 after：选中状态变了的节点回到默认；没有可忘的返回原对象。 */
export function forgetOnSelectionChange(overrides: ExpandOverrides, before: ReadonlySet<string>, after: ReadonlySet<string>): ExpandOverrides {
  const kept = [...overrides].filter(([id]) => before.has(id) === after.has(id));
  return kept.length === overrides.size ? overrides : new Map(kept);
}
