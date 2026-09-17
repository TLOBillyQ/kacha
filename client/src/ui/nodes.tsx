// 节点四型的渲染。节点数据只来自画板文件模型；派生信息（露出端口、标红原因、校验规则）由画布计算后传入。
import { openUrl } from "@tauri-apps/plugin-opener";
import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from "@xyflow/react";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  PromptNode as PromptModel,
  PortRef,
  ReferenceNode as ReferenceModel,
  ResultNode as ResultModel,
  RegionRender,
  TaskNode as TaskModel,
} from "../core/board";
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
import { regenerateBlocker } from "../core/contextMenu";
import { CHAIN_DEPTH_HINT, IMAGE_PORT_PREFIX, imageRuleViolations, type TaskPorts } from "../core/graph";
import { resolveFromRoot } from "../core/paths";
import { ratiosForSizeTier, sizeTiersOf } from "../core/size";
import { fileUrl } from "../shell/ipc";
import { useBoardActions, useImageInfo } from "./context";
import type { Rect01 } from "./rects";

/** recorded：直接下游有已提交过的任务，编辑时三选；autoFocus：「以此继续编辑」刚新建的空提示词。 */
export type PromptFlowNode = Node<{ node: PromptModel; recorded: boolean; autoFocus: boolean }, "prompt">;
/** missing：图片文件读不到，显示占位与「重新定位」。 */
export type ReferenceFlowNode = Node<{ node: ReferenceModel; rules: InputImageRule[]; missing: boolean }, "reference">;
export type ResultFlowNode = Node<
  {
    node: ResultModel;
    missing: boolean;
    /** 「加为参考图」的目标：恰好选中一个生成任务节点，否则给出置灰原因。 */
    referenceTarget: { ok: true; taskId: string } | { ok: false; reason: string };
    /** 非空 = 「生成变体」不可用的原因。 */
    variantBlocker: string | null;
  },
  "result"
>;
export interface ImagePortInfo {
  label: string;
  /** 源图片绝对路径，用于判断透明背景前提（是否带 alpha）。 */
  absPath: string | null;
}
/** 端口行按 imagePortSlots 展开口径：带区域的线在 highlight_overlay 下多出紧随的「叠加」锁定行。 */
export interface ImageSlotInfo {
  kind: "image" | "overlay";
  /** 图N 的 N（1 起，展开后发送序）。 */
  port: number;
  label: string;
  absPath: string | null;
  /** 用户图片端口序号（0 起）；叠加行没有连线，为 null。 */
  handleIndex: number | null;
  /** 该区域连线的矩形（归一化）；叠加行为空。 */
  rects: Rect01[];
  edgeRef: { from: PortRef; to: PortRef } | null;
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
    /** 展开后的端口槽（含区域叠加锁定行）。 */
    slots: ImageSlotInfo[];
    /** 当前模型生效的区域渲染方式；null = 不支持区域指示。 */
    regionRender: RegionRender | null;
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

function Thumb({ absPath, alt, onOpen }: { absPath: string; alt: string; onOpen?: () => void }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [absPath]);
  return missing ? (
    <div className="thumb thumb-missing">图片缺失</div>
  ) : (
    <img className="thumb" src={fileUrl(absPath)} alt={alt} draggable={false} onError={() => setMissing(true)} onDoubleClick={onOpen} title={onOpen ? "双击放大预览" : undefined} />
  );
}

/** 缺图占位：文件名 + 「重新定位」（选文件，或在输出根目录内按身份找）。 */
function MissingImage({ nodeId, name }: { nodeId: string; name: string }) {
  const { relocate } = useBoardActions();
  return (
    <div className="thumb thumb-missing nodrag" onClick={(e) => e.stopPropagation()}>
      <div>图片缺失</div>
      <div className="mono small" title={name}>
        {name}
      </div>
      <div className="relocate">
        <button onClick={() => relocate(nodeId, "search")} title="在输出根目录内按任务编号 / 文件哈希查找，不扫描整个磁盘">
          重新定位
        </button>
        <button onClick={() => relocate(nodeId, "pick")}>选文件…</button>
      </div>
    </div>
  );
}

/** 图片节点上的迭代动作；点按钮不改变选中（「加为参考图」依赖当前选中的任务节点）。 */
function ImageActions({ children }: { children: ReactNode }) {
  return (
    <div className="image-actions nodrag" onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

export const PromptNodeView = memo(function PromptNodeView({ data }: NodeProps<PromptFlowNode>) {
  const { updateNode, forkPrompt } = useBoardActions();
  const { node, recorded, autoFocus } = data;
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus]);
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
        ref={textarea}
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
  const { outputRoot, continueEditing, previewNode } = useBoardActions();
  const { node, rules, missing } = data;
  const abs = resolveFromRoot(outputRoot, node.path);
  const info = useImageInfo(abs);
  const warnings = info ? [...new Set(rules.flatMap((rule) => imageRuleViolations(info, rule)))] : [];
  return (
    <Shell kind="reference" title="参考图" className={warnings.length ? "node-warn" : ""}>
      {missing ? <MissingImage nodeId={node.id} name={node.display_name} /> : <Thumb absPath={abs} alt={node.display_name} onOpen={() => previewNode(node.id)} />}
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
      <ImageActions>
        <button onClick={() => previewNode(node.id)} title="放大查看（也可双击图片）；若下游任务支持，可在预览里框选修改区域">
          放大预览
        </button>
        <button onClick={() => continueEditing(node.id)} title="新建生成任务，以这张图为图1（多选时按选中顺序接入）">
          以此继续编辑
        </button>
      </ImageActions>
      <Handle type="source" position={Position.Right} id="out" />
    </Shell>
  );
});

export const ResultNodeView = memo(function ResultNodeView({ data }: NodeProps<ResultFlowNode>) {
  const { outputRoot, table, continueEditing, addAsReference, generateVariant, previewNode } = useBoardActions();
  const { node, missing, referenceTarget, variantBlocker } = data;
  const abs = resolveFromRoot(outputRoot, node.path);
  const info = useImageInfo(abs);
  const { record } = node;
  const size = record.size_spec.tier ? `${record.size_spec.tier} · ${record.size_spec.ratio}` : `${record.size_spec.width}×${record.size_spec.height}`;
  const time = new Date(record.submitted_at);
  return (
    <Shell kind="result" title="结果">
      <Handle type="target" position={Position.Left} id="in" isConnectable={false} />
      {missing ? <MissingImage nodeId={node.id} name={node.file} /> : <Thumb absPath={abs} alt={node.file} onOpen={() => previewNode(node.id)} />}
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
      <ImageActions>
        <button
          onClick={() => previewNode(node.id)}
          title={node.layer_count > 0 ? "放大查看（也可双击图片）；可勾选图层叠加显示、按图层继续编辑 / 加为参考图、导出图层" : "放大查看（也可双击图片）"}
        >
          放大预览
        </button>
        <button onClick={() => continueEditing(node.id)} title="新建生成任务，以这张图为图1（多选时按选中顺序接入）">
          以此继续编辑
        </button>
        <button
          onClick={() => addAsReference(node.id)}
          disabled={!referenceTarget.ok}
          title={referenceTarget.ok ? "接到选中生成任务的下一个空图片端口" : referenceTarget.reason}
        >
          加为参考图
        </button>
        <button onClick={() => generateVariant(node.id)} disabled={variantBlocker !== null} title={variantBlocker ?? "父任务按这张图的参数再生成一张"}>
          生成变体
        </button>
      </ImageActions>
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
  const { table, updateNode, moveImagePort, availableModels, setTaskModel, cancelTask, regenerate, editRegion } = useBoardActions();
  const { node, ports, issues, warnings, unreferenced, chainDepth, locked, workflow, images, slots, regionRender, hasPositive, status } = data;
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
  const portSignature = `${ports.negative}|${ports.imageSlots}|${slots.map((s) => `${s.kind}:${s.port}:${s.label}`).join(",")}`;
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
        {slots.map((slot) => {
          if (slot.kind === "overlay") {
            return (
              <PortRow
                key={`overlay-${slot.port}`}
                id={`overlay:${slot.port}`}
                connectable={false}
                className="nodrag port-overlay"
                label={`图${slot.port} · 叠加`}
              >
                <span className="muted small" title="区域叠加图由系统按紧随的原图自动生成，不可重排、不可断开">
                  锁定
                </span>
              </PortRow>
            );
          }
          const i = slot.handleIndex!;
          return (
            <PortRow
              key={`image-${i}`}
              id={`${IMAGE_PORT_PREFIX}${i}`}
              connectable={!locked}
              className={`nodrag port-filled ${unreferenced.includes(slot.port) ? "port-unreferenced" : ""} ${dragFrom === i ? "port-dragging" : ""} ${dropTo === i ? "port-drop" : ""}`}
              label={`图${slot.port} · ${slot.label}`}
              data-port-index={i}
              onPointerDown={(e) => {
                if (locked || e.button !== 0 || (e.target as HTMLElement).closest(".react-flow__handle, button")) return;
                e.preventDefault();
                setDragFrom(i);
              }}
            >
              {slot.absPath && (
                <span className="port-thumb" title={slot.rects.length ? `已框选 ${slot.rects.length} 个修改区域` : undefined}>
                  <img src={fileUrl(slot.absPath)} alt={slot.label} draggable={false} />
                  {slot.rects.map((r, k) => (
                    <span
                      key={k}
                      className="port-thumb-rect"
                      style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${(r[2] - r[0]) * 100}%`, height: `${(r[3] - r[1]) * 100}%` }}
                    />
                  ))}
                </span>
              )}
              {slot.edgeRef && regionRender !== null && !locked && (
                <button
                  className="link small"
                  title="在放大预览里框出希望模型修改的位置"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => editRegion(node.id, slot.edgeRef!)}
                >
                  框选修改区域{slot.rects.length > 0 ? `（${slot.rects.length}）` : ""}
                </button>
              )}
              {!locked && <span className="grip" title="拖动调整参考图顺序">⋮⋮</span>}
            </PortRow>
          );
        })}
        {ports.imageSlots > images.length && (
          <PortRow id={`${IMAGE_PORT_PREFIX}${images.length}`} connectable={!locked} className="nodrag port-empty" label={`图${slots.length + 1}（空）`} />
        )}
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
            disabled={regenerateBlocker(node) !== null}
            title={regenerateBlocker(node) ?? "按上次提交的参数再生成一张（新任务、新结果节点）"}
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
