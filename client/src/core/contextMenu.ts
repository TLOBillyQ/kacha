// 画板上下文菜单：按右键对象给条目（动作 + 文案 + 置灰原因）。执行由画布按 action 分派到与工具栏 / 节点按钮相同的逻辑；
// 悬浮动作条、拖线建节点的多候选菜单复用同一组 action。
import type { Board, BoardEdge, TaskNode } from "./board";
import { findModel, type CapabilityTable } from "./capabilities";
import { imagePortIndex } from "./graph";
import { countLabel } from "./history";
import { effectiveRegionRender } from "./region";
import { addAsReferenceTarget, producerOf } from "./iterate";

export type MenuTarget = { kind: "pane" } | { kind: "node"; nodeId: string } | { kind: "edge"; edge: BoardEdge };

export type BoardAction =
  | "newPrompt"
  | "newTask"
  | "addReferences"
  | "undo"
  | "redo"
  | "preview"
  | "continueEditing"
  | "addAsReference"
  | "generateVariant"
  | "delete"
  | "run"
  | "cancel"
  | "regenerate"
  | "disconnect"
  | "editRegion";

export interface MenuItem {
  action: BoardAction;
  label: string;
  /** 非空 = 置灰，并作为不可用原因显示。 */
  disabledReason: string | null;
}

export interface MenuFacts {
  board: Board;
  table: CapabilityTable;
  /** 弹菜单时的选区（已按 selectionForMenu 换过）。 */
  selected: ReadonlySet<string>;
  /** 排队 / 执行中的任务节点。 */
  locked: ReadonlySet<string>;
  undoLabel: string | null;
  redoLabel: string | null;
}

const item = (action: BoardAction, label: string, disabledReason: string | null = null): MenuItem => ({ action, label, disabledReason });

export function menuItems(target: MenuTarget, facts: MenuFacts): MenuItem[] {
  switch (target.kind) {
    case "pane":
      return [
        item("newPrompt", "新建提示词"),
        item("newTask", "新建生成任务"),
        item("addReferences", "添加参考图…"),
        facts.undoLabel ? item("undo", `撤销 ${facts.undoLabel}`) : item("undo", "撤销", "没有可撤销的操作"),
        facts.redoLabel ? item("redo", `重做 ${facts.redoLabel}`) : item("redo", "重做", "没有可重做的操作"),
      ];
    case "node": {
      const { board, selected, locked } = facts;
      const node = board.nodes.find((n) => n.id === target.nodeId);
      if (selected.size > 1 && selected.has(target.nodeId)) {
        const hasImage = board.nodes.some((n) => selected.has(n.id) && (n.type === "reference" || n.type === "result"));
        return [...(hasImage ? [item("continueEditing", "以此继续编辑")] : []), item("delete", countLabel("删除", selected.size))];
      }
      switch (node?.type) {
        case "reference":
          return [item("preview", "放大预览"), item("continueEditing", "以此继续编辑"), item("delete", "删除")];
        case "result": {
          const refTarget = addAsReferenceTarget(board, [...selected]);
          return [
            item("preview", "放大预览"),
            item("continueEditing", "以此继续编辑"),
            item("addAsReference", "加为参考图", refTarget.ok ? (locked.has(refTarget.taskId) ? LOCKED_HINT : null) : refTarget.reason),
            item("generateVariant", "生成变体", variantBlocker(board, node.id, locked)),
            item("delete", "删除"),
          ];
        }
        case "task": {
          const busy = locked.has(node.id);
          return [
            item("run", "运行", busy ? TASK_BUSY : null),
            item("cancel", "取消", busy ? null : "任务不在排队 / 执行中"),
            item("regenerate", "重新生成", busy ? TASK_BUSY : regenerateBlocker(node)),
            item("delete", "删除"),
          ];
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
      return [item("disconnect", "断开", reason), ...(regionable ? [item("editRegion", "框选修改区域", reason)] : [])];
    }
  }
}

export const LOCKED_HINT = "任务排队 / 执行中：模型、尺寸、开关、图片端口与连线已锁定";

const TASK_BUSY = "任务正在排队 / 执行";

/** 「重新生成」不可用的原因（锁定之外）；null = 可用。节点按钮与菜单共用。 */
export function regenerateBlocker(task: TaskNode): string | null {
  return task.last_submitted === null ? "还没有提交过" : null;
}

/** 「生成变体」不可用的原因；null = 可用。节点按钮与菜单共用。 */
export function variantBlocker(board: Board, resultId: string, locked: ReadonlySet<string>): string | null {
  const parent = producerOf(board, resultId);
  return !parent ? "父任务已删除" : locked.has(parent.id) ? "父任务正在排队 / 执行" : null;
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
