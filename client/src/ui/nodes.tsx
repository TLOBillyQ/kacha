// 节点四型的渲染。节点数据只来自画板文件模型；派生信息（露出端口、标红原因、校验规则）由画布计算后传入。
import { openUrl } from "@tauri-apps/plugin-opener";
import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from "@xyflow/react";
import { memo, useEffect, useState, type ReactNode } from "react";
import type { PromptNode as PromptModel, ReferenceNode as ReferenceModel, ResultNode as ResultModel, TaskNode as TaskModel } from "../core/board";
import {
  findModel,
  isSupported,
  modelsByTier,
  TIER_LABELS,
  untestedCapabilities,
  type InputImageRule,
  type WorkflowName,
} from "../core/capabilities";
import type { TaskStatus } from "../core/run";
import { CHAIN_DEPTH_HINT, IMAGE_PORT_PREFIX, imageRuleViolations, type TaskPorts } from "../core/graph";
import { resolveFromRoot } from "../core/paths";
import { ratiosForSizeTier, sizeTiersOf } from "../core/size";
import { fileUrl } from "../shell/ipc";
import { useBoardActions, useImageInfo } from "./context";

/** recorded：直接下游有已提交过的任务，编辑时三选。 */
export type PromptFlowNode = Node<{ node: PromptModel; recorded: boolean }, "prompt">;
export type ReferenceFlowNode = Node<{ node: ReferenceModel; rules: InputImageRule[] }, "reference">;
export type ResultFlowNode = Node<{ node: ResultModel }, "result">;
export interface ImagePortInfo {
  label: string;
  /** 源图片绝对路径，用于判断透明背景前提（是否带 alpha）。 */
  absPath: string | null;
}
export type TaskFlowNode = Node<
  {
    node: TaskModel;
    ports: TaskPorts;
    issues: string[];
    /** 黄色提示，不阻断。 */
    warnings: string[];
    /** 已接线但提示词没引用的图序号（从 1 起）。 */
    unreferenced: number[];
    chainDepth: number;
    /** 排队 / 执行中：参数与连线锁定。 */
    locked: boolean;
    workflow: WorkflowName;
    images: ImagePortInfo[];
    hasPositive: boolean;
    status: TaskStatus | null;
  },
  "task"
>;

function Shell({ kind, title, className = "", children }: { kind: string; title: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={`node node-${kind} ${className}`}>
      <div className="node-title">{title}</div>
      {children}
    </div>
  );
}

function Thumb({ absPath, alt }: { absPath: string; alt: string }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [absPath]);
  return missing ? (
    <div className="thumb thumb-missing">图片缺失</div>
  ) : (
    <img className="thumb" src={fileUrl(absPath)} alt={alt} draggable={false} onError={() => setMissing(true)} />
  );
}

export const PromptNodeView = memo(function PromptNodeView({ data }: NodeProps<PromptFlowNode>) {
  const { updateNode, forkPrompt } = useBoardActions();
  const { node, recorded } = data;
  // 下游有执行记录时，本次聚焦内第一次改动先三选；选「不断开」后到失焦前不再问。
  const [pending, setPending] = useState<string | null>(null);
  const [keep, setKeep] = useState(false);
  const fork = () => {
    if (pending !== null) forkPrompt(node.id, pending);
    setPending(null);
  };
  const noFork = () => {
    if (pending !== null) updateNode(node.id, { text: pending });
    setPending(null);
    setKeep(true);
  };
  const holdFocus = (e: React.MouseEvent) => e.preventDefault();
  return (
    <Shell kind="prompt" title="提示词">
      <textarea
        className="nodrag nowheel prompt-text"
        value={pending ?? node.text}
        placeholder="输入提示词…"
        onBlur={() => setKeep(false)}
        onKeyDown={(e) => {
          if (pending === null) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            fork();
          } else if (e.key === "Escape") setPending(null);
        }}
        onChange={(e) => {
          if (pending !== null || (recorded && !keep)) setPending(e.target.value);
          else updateNode(node.id, { text: e.target.value });
        }}
      />
      {pending !== null && (
        <div className="popover nodrag fork-choice" onMouseDown={holdFocus}>
          <div>下游任务已执行过，这次修改：</div>
          <button className="primary" onClick={fork} title="旧文本留在新提示词节点并连着已执行的任务；新文本留在这里（Enter）">
            断开并分叉
          </button>
          <button onClick={noFork} title="保持连线，下游任务全部变脏">
            不断开
          </button>
          <button onClick={() => setPending(null)} title="放弃这次修改（Esc）">
            取消编辑
          </button>
        </div>
      )}
      <Handle type="source" position={Position.Right} id="out" />
    </Shell>
  );
});

export const ReferenceNodeView = memo(function ReferenceNodeView({ data }: NodeProps<ReferenceFlowNode>) {
  const { outputRoot } = useBoardActions();
  const { node, rules } = data;
  const abs = resolveFromRoot(outputRoot, node.path);
  const info = useImageInfo(abs);
  const warnings = info ? [...new Set(rules.flatMap((rule) => imageRuleViolations(info, rule)))] : [];
  return (
    <Shell kind="reference" title="参考图" className={warnings.length ? "node-warn" : ""}>
      <Thumb absPath={abs} alt={node.display_name} />
      <div className="caption" title={node.path}>
        {info?.has_alpha && <span className="badge">透明</span>}
        {node.display_name}
      </div>
      {warnings.length > 0 && (
        <ul className="warn-list">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <Handle type="source" position={Position.Right} id="out" />
    </Shell>
  );
});

export const ResultNodeView = memo(function ResultNodeView({ data }: NodeProps<ResultFlowNode>) {
  const { outputRoot, table } = useBoardActions();
  const { node } = data;
  const abs = resolveFromRoot(outputRoot, node.path);
  const info = useImageInfo(abs);
  const { record } = node;
  const size = record.size_spec.tier ? `${record.size_spec.tier} · ${record.size_spec.ratio}` : `${record.size_spec.width}×${record.size_spec.height}`;
  const time = new Date(record.submitted_at);
  return (
    <Shell kind="result" title="结果">
      <Handle type="target" position={Position.Left} id="in" isConnectable={false} />
      <Thumb absPath={abs} alt={node.file} />
      <div className="badges">
        {info?.has_alpha && <span className="badge">透明</span>}
        {node.layer_count > 0 && <span className="badge">{node.layer_count} 图层</span>}
      </div>
      <dl className="record">
        <dt>模型</dt>
        <dd>{findModel(table, record.model)?.display_name ?? record.model}</dd>
        <dt>提示词</dt>
        <dd className="clamp" title={record.prompt}>
          {record.prompt}
        </dd>
        <dt>尺寸</dt>
        <dd>{size}</dd>
        <dt>时间</dt>
        <dd>{Number.isNaN(time.getTime()) ? record.submitted_at : time.toLocaleString()}</dd>
        <dt>任务</dt>
        <dd className="mono" title={node.task_id}>
          {node.task_id}
        </dd>
      </dl>
      <Handle type="source" position={Position.Right} id="out" />
    </Shell>
  );
});

function ModelInfo({ modelId, onClose }: { modelId: string; onClose: () => void }) {
  const { table } = useBoardActions();
  const model = findModel(table, modelId);
  if (!model) return null;
  const untested = untestedCapabilities(model);
  return (
    <div className="popover nodrag">
      <div className="popover-head">
        <strong>{model.display_name}</strong>
        <button className="link" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="mono muted">{model.model_id}</div>
      <div>档位：{model.tier ? TIER_LABELS[model.tier] : "未上架"}</div>
      <div>参考图上限：{model.workflows.image_edit.max_references}</div>
      {untested.length > 0 && (
        <>
          <div>待测（当前按不支持处理）：</div>
          <ul>
            {untested.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </>
      )}
      {model.help_url && (
        <button className="link" onClick={() => void openUrl(model.help_url!)}>
          查看官方文档
        </button>
      )}
    </div>
  );
}

export const CANCELLED_HINT = "已取消本地等待，网关侧计算可能仍在继续";

function StatusBadge({ status }: { status: TaskStatus }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status.kind !== "running" && status.kind !== "backoff") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);
  switch (status.kind) {
    case "queued":
      return <span className="status status-queued">排队中</span>;
    case "failed":
      return <span className="status status-failed">失败 · {status.label}</span>;
    case "cancelled":
      return (
        <span className="status status-queued" title={status.gatewayMayContinue ? CANCELLED_HINT : undefined}>
          已取消
        </span>
      );
    case "interrupted":
      return (
        <span className="status status-queued" title="上次程序异常退出时仍在执行，可重新生成">
          已中断
        </span>
      );
    case "backoff":
      return <span className="status status-backoff">网关限流，{Math.max(0, Math.ceil((status.retryAt - now) / 1000))} 秒后重试</span>;
    case "running": {
      const seconds = Math.max(0, Math.floor((now - status.startedAt) / 1000));
      return (
        <span className="status status-running">
          <span className="spinner" />
          执行中 {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
      );
    }
  }
}

function PortRow({
  id,
  label,
  children,
  className = "",
  connectable = true,
  ...drag
}: { id: string; label: ReactNode; children?: ReactNode; className?: string; connectable?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`port-row ${className}`} {...drag}>
      <Handle type="target" position={Position.Left} id={id} isConnectable={connectable} />
      <span className="port-label">{label}</span>
      {children}
    </div>
  );
}

export const TaskNodeView = memo(function TaskNodeView({ data }: NodeProps<TaskFlowNode>) {
  const { table, updateNode, moveImagePort, availableModels, setTaskModel, cancelTask, regenerate } = useBoardActions();
  const { node, ports, issues, warnings, unreferenced, chainDepth, locked, workflow, images, hasPositive, status } = data;
  const [infoOpen, setInfoOpen] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const updateInternals = useUpdateNodeInternals();
  const model = findModel(table, node.model);
  const rule = model?.workflows[workflow].size_rule;
  const availableIds = new Set(availableModels.map((m) => m.model_id));
  const groups = modelsByTier(table)
    .map((g) => ({ ...g, models: g.models.filter((m) => availableIds.has(m.model_id)) }))
    .filter((g) => g.models.length > 0);
  const listed = availableIds.has(node.model);
  const shelved = modelsByTier(table).some((g) => g.models.some((m) => m.model_id === node.model));

  // 端口重排用 pointer 事件：窗口开启了文件拖入（dragDropEnabled），Windows 上收不到 HTML5 drop。
  // 拖动中全局换成 grabbing 指针，悬停在可放的行上高亮该行，其余位置显示 no-drop。
  const [dropTo, setDropTo] = useState<number | null>(null);
  useEffect(() => {
    if (dragFrom === null) return;
    const targetAt = (e: PointerEvent) => {
      const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-port-index]");
      if (!row || row.closest(".react-flow__node")?.getAttribute("data-id") !== node.id) return null;
      const to = Number(row.dataset.portIndex);
      return to === dragFrom ? null : to;
    };
    const move = (e: PointerEvent) => {
      const to = targetAt(e);
      setDropTo(to);
      document.body.dataset.portDrag = to === null ? "none" : "ok";
    };
    const up = (e: PointerEvent) => {
      const to = targetAt(e);
      if (to !== null) moveImagePort(node.id, dragFrom, to);
      setDragFrom(null);
    };
    document.body.dataset.portDrag = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      delete document.body.dataset.portDrag;
      setDropTo(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragFrom, node.id, moveImagePort]);

  // 端口数量或顺序变化后，React Flow 需要重新测量 Handle 位置。
  const portSignature = `${ports.negative}|${ports.imageSlots}|${images.map((i) => i.label).join(",")}`;
  useEffect(() => updateInternals(node.id), [portSignature, node.id, updateInternals]);

  const tiers = rule ? sizeTiersOf(rule) : [];
  const tier = node.size_spec.tier;
  const ratios = rule && tier ? ratiosForSizeTier(rule, tier) : [];
  const setTier = (next: string) => {
    const available = rule ? ratiosForSizeTier(rule, next) : [];
    const ratio = node.size_spec.ratio && available.includes(node.size_spec.ratio) ? node.size_spec.ratio : (available[0] ?? null);
    updateNode(node.id, { size_spec: { ...node.size_spec, tier: next, ratio, width: null, height: null } });
  };

  const singleImage = images.length === 1 ? images[0].absPath : null;
  const singleInfo = useImageInfo(singleImage);
  const transparentReady = images.length === 1 && !!singleInfo?.has_alpha;
  const transparentHint = images.length !== 1 ? "需要恰好一条图片线" : singleInfo?.has_alpha ? "" : "该图不带透明通道";
  const blocking = issues.filter((i) => i !== "正向提示词未连接");

  return (
    <Shell
      kind="task"
      className={blocking.length ? "node-error" : ""}
      title={
        <>
          生成任务<span className="muted">{workflow === "image_edit" ? " · 图片编辑" : " · 文生图"}</span>
          {chainDepth >= CHAIN_DEPTH_HINT && (
            <span className="badge badge-chain" title={`已连续编辑 ${chainDepth} 轮，建议回到原图重新编辑`}>
              链深 {chainDepth}
            </span>
          )}
          {status && <StatusBadge status={status} />}
        </>
      }
    >
      <div className="field nodrag">
        <select value={node.model} onChange={(e) => setTaskModel(node.id, e.target.value)} disabled={locked}>
          {!listed && (
            <option value={node.model}>
              {!model ? `${node.model}（未知模型）` : shelved ? `${model.display_name}（网关未提供）` : `${model.display_name}（未上架）`}
            </option>
          )}
          {groups.map((g) => (
            <optgroup key={g.tier} label={TIER_LABELS[g.tier]}>
              {g.models.map((m) => (
                <option key={m.model_id} value={m.model_id}>
                  {m.display_name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button className="icon" title="模型说明" onClick={() => setInfoOpen((v) => !v)} disabled={!model}>
          ⓘ
        </button>
      </div>
      {infoOpen && <ModelInfo modelId={node.model} onClose={() => setInfoOpen(false)} />}

      <div className="field nodrag">
        <select value={tier ?? ""} onChange={(e) => setTier(e.target.value)} title="尺寸档" disabled={locked}>
          {tier !== null && !tiers.includes(tier) && <option value={tier}>{tier}（不支持）</option>}
          {tier === null && <option value="">自定义</option>}
          {tiers.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select
          value={node.size_spec.ratio ?? ""}
          onChange={(e) => updateNode(node.id, { size_spec: { ...node.size_spec, ratio: e.target.value } })}
          title="比例"
          disabled={locked || tier === null}
        >
          {node.size_spec.ratio !== null && !ratios.includes(node.size_spec.ratio) && (
            <option value={node.size_spec.ratio}>{node.size_spec.ratio}（不支持）</option>
          )}
          {ratios.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </div>

      {(ports.layerDecomposition || ports.transparentBackground) && (
        <div className="toggles nodrag">
          {ports.layerDecomposition && (
            <label>
              <input
                type="checkbox"
                checked={node.layer_decomposition}
                disabled={locked}
                onChange={(e) => updateNode(node.id, { layer_decomposition: e.target.checked })}
              />
              拆分图层
            </label>
          )}
          {ports.transparentBackground && (
            <label title={transparentHint} className={!transparentReady && !node.transparent_background ? "disabled" : ""}>
              <input
                type="checkbox"
                checked={node.transparent_background}
                disabled={locked || (!transparentReady && !node.transparent_background)}
                onChange={(e) => updateNode(node.id, { transparent_background: e.target.checked })}
              />
              透明背景{transparentHint && <span className="muted">（{transparentHint}）</span>}
            </label>
          )}
        </div>
      )}

      <div className="ports">
        <PortRow id="positive" label="正向提示词" className={hasPositive ? "" : "port-required"} connectable={!locked} />
        {ports.negative && <PortRow id="negative" label="负向提示词" connectable={!locked} />}
        {Array.from({ length: ports.imageSlots }, (_, i) => {
          const image = images[i];
          return (
            <PortRow
              key={i}
              id={`${IMAGE_PORT_PREFIX}${i}`}
              connectable={!locked}
              className={`nodrag ${image ? "port-filled" : "port-empty"} ${unreferenced.includes(i + 1) ? "port-unreferenced" : ""} ${dragFrom === i ? "port-dragging" : ""} ${dropTo === i ? "port-drop" : ""}`}
              label={image ? `图${i + 1} · ${image.label}` : `图${i + 1}（空）`}
              data-port-index={image ? i : undefined}
              onPointerDown={(e) => {
                if (!image || locked || e.button !== 0 || (e.target as HTMLElement).closest(".react-flow__handle")) return;
                e.preventDefault();
                setDragFrom(i);
              }}
            >
              {image && !locked && <span className="grip" title="拖动调整参考图顺序">⋮⋮</span>}
            </PortRow>
          );
        })}
        {model && !isSupported(model.workflows[workflow].supports_negative_prompt) && ports.negative && (
          <div className="muted small">当前模型不支持负向提示词</div>
        )}
      </div>

      {issues.length > 0 && (
        <ul className={blocking.length ? "error-list" : "hint-list"}>
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="warn-list">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {status?.kind === "cancelled" && status.gatewayMayContinue && <div className="muted small">{CANCELLED_HINT}</div>}
      <div className="task-actions nodrag">
        {locked ? (
          <button onClick={() => cancelTask(node.id)} title={status?.kind === "running" ? CANCELLED_HINT : "移出队列"}>
            取消
          </button>
        ) : (
          <button
            onClick={() => regenerate(node.id)}
            disabled={node.last_submitted === null}
            title={node.last_submitted === null ? "还没有提交过" : "按上次提交的参数再生成一张（新任务、新结果节点）"}
          >
            重新生成
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Right} id="result" isConnectable={false} />
    </Shell>
  );
});

export const nodeTypes = {
  prompt: PromptNodeView,
  reference: ReferenceNodeView,
  task: TaskNodeView,
  result: ResultNodeView,
};
