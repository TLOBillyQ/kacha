// 画板连线：贝塞尔 + 区域徽标；选中的用户连线在中点显示 ×，点击断开（走与 Delete 相同的删除流程）。
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps, type EdgeTypes } from "@xyflow/react";
import { memo } from "react";

const BoardEdgeView = memo(function BoardEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  selected,
  deletable,
  style,
  markerEnd,
  interactionWidth,
}: EdgeProps) {
  const flow = useReactFlow();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const showCut = selected && deletable !== false;
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
      {(label || showCut) && (
        <EdgeLabelRenderer>
          <div className="edge-midpoint nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {label && <span className="edge-badge">{label}</span>}
            {showCut && (
              <button className="edge-cut" aria-label="断开连线" onClick={() => void flow.deleteElements({ edges: [{ id }] })}>
                ×
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes: EdgeTypes = { default: BoardEdgeView };
