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
import { IMAGE_PORT_PREFIX, imageRuleViolations, type TaskPorts } from "../core/graph";
import { resolveFromRoot } from "../core/paths";
import { ratiosForTier, tiersOf } from "../core/size";
import { fileUrl } from "../shell/ipc";
import { useBoardActions, useImageInfo } from "./context";

export type PromptFlowNode = Node<{ node: PromptModel }, "prompt">;
export type ReferenceFlowNode = Node<{ node: ReferenceModel; rules: InputImageRule[] }, "reference">;
export type ResultFlowNode = Node<{ node: ResultModel }, "result">;
export interface ImagePortInfo {
  label: string;
  /** 源图片绝对路径，用于判断透明背景前提（是否带 alpha）。 */
  absPath: string | null;
}
export type TaskFlowNode = Node<
  { node: TaskModel; ports: TaskPorts; issues: string[]; workflow: WorkflowName; images: ImagePortInfo[]; hasPositive: boolean },
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
  const { updateNode } = useBoardActions();
  const { node } = data;
  return (
    <Shell kind="prompt" title="提示词">
      <textarea
        className="nodrag nowheel prompt-text"
        value={node.text}
        placeholder="输入提示词…"
        onChange={(e) => updateNode(node.id, { text: e.target.value })}
      />
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

function PortRow({ id, label, children, className = "", ...drag }: { id: string; label: ReactNode; children?: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`port-row ${className}`} {...drag}>
      <Handle type="target" position={Position.Left} id={id} />
      <span className="port-label">{label}</span>
      {children}
    </div>
  );
}

export const TaskNodeView = memo(function TaskNodeView({ data }: NodeProps<TaskFlowNode>) {
  const { table, updateNode, moveImagePort } = useBoardActions();
  const { node, ports, issues, workflow, images, hasPositive } = data;
  const [infoOpen, setInfoOpen] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const updateInternals = useUpdateNodeInternals();
  const model = findModel(table, node.model);
  const rule = model?.workflows[workflow].size_rule;
  const groups = modelsByTier(table);
  const shelved = groups.some((g) => g.models.some((m) => m.model_id === node.model));

  // 端口数量或顺序变化后，React Flow 需要重新测量 Handle 位置。
  const portSignature = `${ports.negative}|${ports.imageSlots}|${images.map((i) => i.label).join(",")}`;
  useEffect(() => updateInternals(node.id), [portSignature, node.id, updateInternals]);

  const tiers = rule ? tiersOf(rule) : [];
  const tier = node.size_spec.tier;
  const ratios = rule && tier ? ratiosForTier(rule, tier) : [];
  const setTier = (next: string) => {
    const available = rule ? ratiosForTier(rule, next) : [];
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
        </>
      }
    >
      <div className="field nodrag">
        <select value={node.model} onChange={(e) => updateNode(node.id, { model: e.target.value })}>
          {!shelved && <option value={node.model}>{model ? `${model.display_name}（未上架）` : `${node.model}（未知模型）`}</option>}
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
        <select value={tier ?? ""} onChange={(e) => setTier(e.target.value)} title="档位">
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
          disabled={tier === null}
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
                disabled={!transparentReady && !node.transparent_background}
                onChange={(e) => updateNode(node.id, { transparent_background: e.target.checked })}
              />
              透明背景{transparentHint && <span className="muted">（{transparentHint}）</span>}
            </label>
          )}
        </div>
      )}

      <div className="ports">
        <PortRow id="positive" label="正向提示词" className={hasPositive ? "" : "port-required"} />
        {ports.negative && <PortRow id="negative" label="负向提示词" />}
        {Array.from({ length: ports.imageSlots }, (_, i) => {
          const image = images[i];
          return (
            <PortRow
              key={i}
              id={`${IMAGE_PORT_PREFIX}${i}`}
              className={`nodrag ${image ? "port-filled" : "port-empty"} ${dragFrom !== null && dragFrom !== i && image ? "port-drop" : ""}`}
              label={image ? `图${i + 1} · ${image.label}` : `图${i + 1}（空）`}
              draggable={!!image}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                setDragFrom(i);
              }}
              onDragEnd={() => setDragFrom(null)}
              onDragOver={(e) => image && dragFrom !== null && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null && image) moveImagePort(node.id, dragFrom, i);
                setDragFrom(null);
              }}
            >
              {image && <span className="grip" title="拖动调整参考图顺序">⋮⋮</span>}
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
