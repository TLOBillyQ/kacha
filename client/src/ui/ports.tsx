// 端口：按类型着色的 Handle；拖线中按画布给的拖线态加类名（合法发光 / 其余去强调）。
import { Handle, useNodeId, type HandleProps } from "@xyflow/react";
import { createContext, useContext } from "react";
import { portDragClassName, type DragState, type PortKind } from "../core/ports";

/** 画布级拖线态（拖线开始 / 结束时变化）；端口按它加拖线类名。 */
export const DragContext = createContext<DragState | null>(null);

export function Port({ kind, className = "", ...props }: { kind: PortKind; id: string; className?: string } & Omit<HandleProps, "id">) {
  const drag = useContext(DragContext);
  const nodeId = useNodeId() ?? "";
  const dragClass = portDragClassName(drag, nodeId, props.id);
  return <Handle {...props} className={`port port-${kind} ${dragClass} ${className}`.trim()} />;
}
