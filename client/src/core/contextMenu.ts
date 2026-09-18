// 画板上下文菜单：按右键对象给条目（动作 + 文案 + 置灰原因）。执行由画布按 action 分派到与工具栏 / 节点按钮相同的逻辑；
// 悬浮动作条、拖线建节点的多候选菜单复用同一组 action。
import type { Board, BoardEdge } from "./board";
import { findModel, type CapabilityTable } from "./capabilities";
import { imagePortIndex } from "./graph";
import { countLabel } from "./history";
import { effectiveRegionRender } from "./region";
import { addAsReferenceTarget, LOCKED_HINT, regenerateBlocker, TASK_BUSY, variantBlocker } from "./iterate";

export type MenuTarget = { kind: "pane" } | { kind: "node"; nodeId: string } | { kind: "edge"; edge: BoardEdge };

export type BoardAction =
  | "newPrompt"
  | "newTask"
  | "addReferences"
  | "undo"
  | "redo"
  | "preview"
  | "saveAs"
  | "continueEditing"
  | "addAsReference"
  | "generateVariant"
  | "delete"
  | "run"
  | "cancel"
  | "regenerate"
  | "toggleSettings"
  | "viewSendText"
  | "disconnect"
  | "editRegion"
  | "exportPack";

export interface MenuItem {
  action: BoardAction;
  label: string;
  /** 非空 = 置灰，并作为不可用原因显示。 */
  disabledReason: string | null;
  /** 与上一条不是同类操作：在它上方画分隔线。 */
  separatorBefore?: boolean;
}

export interface MenuFacts {
  board: Board;
  table: CapabilityTable;
  /** 弹菜单时的选区（已按 selectionForMenu 换过）。 */
  selected: ReadonlySet<string>;
  /** 排队 / 执行中的任务节点。 */
  locked: ReadonlySet<string>;
  /** 设置已原地展开的任务节点（不存盘）。 */
  expanded: ReadonlySet<string>;
  undoLabel: string | null;
  redoLabel: string | null;
}

const item = (action: BoardAction, label: string, disabledReason: string | null = null): MenuItem => ({ action, label, disabledReason });

/** 各组内按常用程度排，组间加分隔线；空组跳过。删除等破坏性操作单独成组放最后。 */
const grouped = (...groups: MenuItem[][]): MenuItem[] =>
  groups.filter((g) => g.length > 0).flatMap((g, gi) => g.map((it, i) => (gi > 0 && i === 0 ? { ...it, separatorBefore: true } : it)));

export function menuItems(target: MenuTarget, facts: MenuFacts): MenuItem[] {
  switch (target.kind) {
    case "pane":
      return grouped(
        [item("newPrompt", "新建提示词"), item("newTask", "新建生成任务"), item("addReferences", "添加参考图…")],
        [
          facts.undoLabel ? item("undo", `撤销 ${facts.undoLabel}`) : item("undo", "撤销", "没有可撤销的操作"),
          facts.redoLabel ? item("redo", `重做 ${facts.redoLabel}`) : item("redo", "重做", "没有可重做的操作"),
        ],
        [item("exportPack", "导出画板包…")],
      );
    case "node": {
      const { board, selected, locked } = facts;
      const node = board.nodes.find((n) => n.id === target.nodeId);
      // 加为参考图的目标是选区里恰好一个任务；单选结果节点时必然置灰，多选（先选任务再加选结果）才可用。
      const addAsReferenceItem = () => {
        const refTarget = addAsReferenceTarget(board, [...selected]);
        return item("addAsReference", "加为参考图", refTarget.ok ? (locked.has(refTarget.taskId) ? LOCKED_HINT : null) : refTarget.reason);
      };
      if (selected.size > 1 && selected.has(target.nodeId)) {
        const hasImage = board.nodes.some((n) => selected.has(n.id) && (n.type === "reference" || n.type === "result"));
        return grouped(
          [...(hasImage ? [item("continueEditing", "以此继续编辑")] : []), ...(node?.type === "result" ? [addAsReferenceItem()] : [])],
          [item("delete", countLabel("删除", selected.size))],
        );
      }
      switch (node?.type) {
        case "reference":
          return grouped([item("continueEditing", "以此继续编辑")], [item("preview", "放大预览"), item("saveAs", "另存为…")], [item("delete", "删除")]);
        case "result": {
          return grouped(
            [item("continueEditing", "以此继续编辑"), addAsReferenceItem(), item("generateVariant", "生成变体", variantBlocker(board, node.id, locked))],
            [item("preview", "放大预览"), item("saveAs", "另存为…")],
            [item("delete", "删除")],
          );
        }
        case "task": {
          const busy = locked.has(node.id);
          // 查看发送文本按当前画板现算；排队 / 执行中时看到的不是正在执行的那份输入，故置灰。
          return grouped(
            [
              item("run", "运行", busy ? TASK_BUSY : null),
              item("regenerate", "重新生成", busy ? TASK_BUSY : regenerateBlocker(node)),
              item("cancel", "取消", busy ? null : "任务不在排队 / 执行中"),
            ],
            [item("toggleSettings", facts.expanded.has(node.id) ? "收起设置" : "展开设置"), item("viewSendText", "查看发送文本", busy ? TASK_BUSY : null)],
            [item("delete", "删除")],
          );
        }
        case "prompt":
          return [item("delete", "删除")];
        default:
          return [];
      }
    }
    case "edge": {
      const { edge } = target;
      if (edge.system) return [];
      const reason = facts.locked.has(edge.to[0]) ? LOCKED_HINT : null;
      const task = facts.board.nodes.find((n) => n.id === edge.to[0]);
      const regionable = imagePortIndex(edge.to[1]) !== null && task?.type === "task" && effectiveRegionRender(findModel(facts.table, task.model)) !== null;
      return grouped(regionable ? [item("editRegion", "框选修改区域", reason)] : [], [item("disconnect", "断开", reason)]);
    }
  }
}

/** 动作条自有顺序（放大预览在最前），不跟菜单的常用程度排序；也不画分隔线。 */
const ACTION_BAR_ACTIONS: readonly BoardAction[] = ["preview", "saveAs", "continueEditing", "addAsReference", "generateVariant"];

/**
 * 悬浮动作条：图片节点的放大预览与迭代动作，取自同一节点的菜单条目（同一组置灰原因）。
 * 悬浮不改选区：悬浮在多选内的节点上给多选条目，否则按单个节点给（加为参考图仍以当前选中的任务为目标）。
 */
export function actionBarItems(nodeId: string, facts: MenuFacts): MenuItem[] {
  const node = facts.board.nodes.find((n) => n.id === nodeId);
  if (node?.type !== "reference" && node?.type !== "result") return [];
  const items = menuItems({ kind: "node", nodeId }, facts);
  return ACTION_BAR_ACTIONS.flatMap((a) => items.filter((i) => i.action === a).map(({ separatorBefore: _, ...i }) => i));
}

/** 右键落在未选中节点上先把选区换成该节点；落在选区内保持原选区。 */
export function selectionForMenu(selected: ReadonlySet<string>, nodeId: string): ReadonlySet<string> {
  return selected.has(nodeId) ? selected : new Set([nodeId]);
}

type Size = { width: number; height: number };

/** 菜单左上角尽量落在点击处，超出窗口右 / 下边缘时推回窗口内。 */
export function clampMenuPosition(at: { x: number; y: number }, menu: Size, win: Size): { x: number; y: number } {
  return { x: Math.max(0, Math.min(at.x, win.width - menu.width)), y: Math.max(0, Math.min(at.y, win.height - menu.height)) };
}
