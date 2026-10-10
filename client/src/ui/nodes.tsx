// 节点四型的渲染。节点数据只来自画板文件模型；派生信息（露出端口、标红原因、校验规则）由画布计算后传入。
import { openUrl } from "@tauri-apps/plugin-opener";
import { NodeResizer, Position, useUpdateNodeInternals, type Node, type NodeProps } from "@xyflow/react";
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
  type CapabilityTable,
  type InputImageRule,
  type ModelCapability,
  type SizeRule,
  type WorkflowName,
} from "../core/capabilities";
import type { MenuItem } from "../core/contextMenu";
import type { PortKind } from "../core/ports";
import { actionHoverInfo, CANCELLED_HINT, portThumbHoverInfo, referenceHoverInfo, resultHoverInfo, taskHoverInfo, textHoverInfo } from "../core/hoverInfo";
import type { TaskStatus } from "../core/run";
import { inputImageAdviceAll } from "../core/fitImage";
import { IMAGE_PORT_PREFIX, type TaskPorts } from "../core/graph";
import { imageMinSize } from "../core/nodeSize";
import { regionCss } from "../core/overlay";
import { resolveFromRoot } from "../core/paths";
import {
  autoRatioLabel,
  commitRatioInput,
  isAutoRatio,
  ratioRangeText,
  ratiosForSizeTier,
  ratioText,
  sizeTiersOf,
  type SizeSpec,
} from "../core/size";
import type { TaskView } from "../core/taskView";
import { fileUrl } from "../shell/ipc";
import { useBoardActions, useImageInfo } from "./context";
import { HoverButton, HoverSpan, useHover } from "./hoverInfo";
import { Port } from "./ports";
import type { Rect01 } from "./rects";

/** recorded：直接下游有已提交过的任务，编辑时三选；autoFocus：「以此继续编辑」刚新建的空提示词。 */
/** portKind：输出端口类型色（只连负向端口 = 负向色）。 */
export interface PromptReferenceGuideItem {
  /** 用户序号，即该任务提示词里的「图N」。 */
  port: number;
  label: string;
  absPath: string | null;
  /** 该线框出的矩形；叠加图不会成为可点击条目。 */
  rects: Rect01[];
}
export interface PromptReferenceGuideTask {
  taskId: string;
  /** 生成任务的可识别标签（当前为模型展示名）。 */
  label: string;
  images: PromptReferenceGuideItem[];
}
export type PromptFlowNode = Node<{ node: PromptModel; recorded: boolean; autoFocus: boolean; portKind: PortKind; guides: PromptReferenceGuideTask[] }, "prompt">;
/** missing：图片文件读不到，显示占位与「重新定位」。 */
export type ReferenceFlowNode = Node<{ node: ReferenceModel; rules: InputImageRule[]; missing: boolean }, "reference">;
/** rules = 下游任务模型的输入规则；没接任务时为空。 */
export type ResultFlowNode = Node<{ node: ResultModel; rules: InputImageRule[]; missing: boolean }, "result">;
export interface ImagePortInfo {
  label: string;
  /** 源图片绝对路径（端口槽缩略图用）；源节点不存在时为 null。 */
  absPath: string | null;
}
/** 端口行按 imagePortSlots 展开口径：带区域的线在 highlight_overlay 下多出紧随的「叠加」锁定行（从属于原图，不占用户序号）。 */
export interface ImageSlotInfo {
  kind: "image" | "overlay";
  /** 发送序号（1 起，展开后）。 */
  port: number;
  /** 用户序号，即「图N」的 N；叠加行为其原图的序号。 */
  userPort: number;
  label: string;
  absPath: string | null;
  /** 用户图片端口序号（0 起）；叠加行没有连线，为 null。 */
  handleIndex: number | null;
  /** 该区域连线的矩形（归一化）；叠加行为空。 */
  rects: Rect01[];
  /** 第一个矩形的区域编号（0 起）。 */
  firstRegion: number;
  edgeRef: { from: PortRef; to: PortRef } | null;
}
export type TaskFlowNode = Node<
  {
    node: TaskModel;
    ports: TaskPorts;
    /** 生成任务视图：不可运行原因、警告、模型标签、生成尺寸、开关可用性（与运行时二次确认同一份）。 */
    view: TaskView;
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
    /** 设置原地展开（不存盘）。 */
    expanded: boolean;
    /** 运行按钮：与上下文菜单同一条目（同一置灰原因）。 */
    run: MenuItem;
  },
  "task"
>;

/** 宽高比控件里「自动」项的 value。 */
const AUTO_RATIO = "auto";
/** 手填越界后范围提示的停留时间。 */
const RATIO_HINT_MS = 4000;

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
    <img className="thumb" src={fileUrl(absPath)} alt={alt} draggable={false} onError={() => setMissing(true)} onDoubleClick={onOpen} />
  );
}

/** 缺图占位：文件名 + 「重新定位」（选文件，或在输出根目录内按身份找）。 */
function MissingImage({ nodeId, name }: { nodeId: string; name: string }) {
  const { relocate } = useBoardActions();
  return (
    <div className="thumb thumb-missing nodrag" onClick={(e) => e.stopPropagation()}>
      <div>图片缺失</div>
      <div className="mono small">{name}</div>
      <div className="relocate">
        <HoverButton onClick={() => relocate(nodeId, "search")} info={textHoverInfo("在输出根目录内按任务编号 / 文件哈希查找，不扫描整个磁盘")}>
          重新定位
        </HoverButton>
        <button onClick={() => relocate(nodeId, "pick")}>选文件…</button>
      </div>
    </div>
  );
}

/**
 * 精简图片节点：只有图片、端口与角标；选中时可拖角等比缩放（尺寸由画布写回 size）。
 * 显示宽高由画布按 size 与图片比例给到 React Flow 节点上；缺图时高度随占位内容。
 */
function ImageNode({
  id,
  absPath,
  name,
  missing,
  selected,
  width,
  height,
  className = "",
  badges,
  hover,
  children,
}: {
  id: string;
  absPath: string;
  name: string;
  missing: boolean;
  selected: boolean;
  width: number | undefined;
  height: number | undefined;
  className?: string;
  badges: string[];
  hover: ReturnType<typeof useHover>;
  children: ReactNode;
}) {
  const { previewNode } = useBoardActions();
  const aspect = width && height ? height / width : null;
  return (
    <div className={`node node-image ${className}`} {...hover}>
      {aspect !== null && !missing && <NodeResizer isVisible={selected} keepAspectRatio {...imageMinSize(aspect)} />}
      {missing ? <MissingImage nodeId={id} name={name} /> : <Thumb absPath={absPath} alt={name} onOpen={() => previewNode(id)} />}
      {badges.length > 0 && (
        <div className="image-badges">
          {badges.map((b) => (
            <span key={b} className="badge">
              {b}
            </span>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

export const PromptNodeView = memo(function PromptNodeView({ data }: NodeProps<PromptFlowNode>) {
  const { apply } = useBoardActions();
  const { node, recorded, autoFocus, portKind, guides } = data;
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus]);
  // 下游有执行记录时，本次聚焦内第一次改动先三选；选「不断开」后到失焦前不再问。
  const [pending, setPending] = useState<string | null>(null);
  const [keep, setKeep] = useState(false);
  const fork = () => {
    if (pending !== null) apply({ kind: "forkPrompt", promptId: node.id, text: pending });
    setPending(null);
  };
  const noFork = () => {
    if (pending !== null) apply({ kind: "editPrompt", promptId: node.id, text: pending });
    setPending(null);
    setKeep(true);
  };
  const holdFocus = (e: React.MouseEvent) => e.preventDefault();
  const change = (text: string, cursor: number | null = null) => {
    if (pending !== null || (recorded && !keep)) setPending(text);
    else apply({ kind: "editPrompt", promptId: node.id, text });
    if (cursor !== null) requestAnimationFrame(() => {
      const el = textarea.current;
      if (el) {
        el.focus();
        el.setSelectionRange(cursor, cursor);
      }
    });
  };
  const insertReference = (port: number) => {
    const el = textarea.current;
    const current = pending ?? node.text;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? start;
    const tag = `@图${port}`;
    change(current.slice(0, start) + tag + current.slice(end), start + tag.length);
  };
  return (
    <Shell kind="prompt" title={portKind === "negative" ? "负向提示词" : "提示词"}>
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
        onChange={(e) => change(e.target.value)}
      />
      {guides.length > 0 && (
        <div className="reference-guide nodrag">
          {guides.length > 1 && <div className="muted small">此提示词供多个任务使用，图片编号按各任务的连接分别解释。</div>}
          {guides.map((guide) => (
            <div key={guide.taskId} className="reference-guide-task">
              {guides.length > 1 && <div className="reference-guide-task-label">{guide.label}</div>}
              <div className="reference-guide-help">点击参考图，将引用插入提示词。</div>
              <div className="reference-guide-thumbs">
                {guide.images.map((image) => (
                  <button key={`${guide.taskId}:${image.port}`} type="button" className="reference-guide-thumb" title={image.label} onMouseDown={holdFocus} onClick={() => insertReference(image.port)}>
                    {image.absPath && (
                      <>
                        <img src={fileUrl(image.absPath)} alt="" draggable={false} />
                        {image.rects.map((r, k) => (
                          <span key={k} className="reference-guide-rect" style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${(r[2] - r[0]) * 100}%`, height: `${(r[3] - r[1]) * 100}%` }} />
                        ))}
                      </>
                    )}
                    <span className="reference-guide-port">图{image.port}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {pending !== null && (
        <div className="popover nodrag fork-choice" onMouseDown={holdFocus}>
          <div>下游任务已执行过，这次修改：</div>
          <HoverButton className="primary" onClick={fork} info={textHoverInfo("旧文本留在新提示词节点并连着已执行的任务；新文本留在这里（Enter）")}>
            断开并分叉
          </HoverButton>
          <HoverButton onClick={noFork} info={textHoverInfo("保持连线，下游任务全部变脏")}>
            不断开
          </HoverButton>
          <HoverButton onClick={() => setPending(null)} info={textHoverInfo("放弃这次修改（Esc）")}>
            取消编辑
          </HoverButton>
        </div>
      )}
      <Port kind={portKind} type="source" position={Position.Right} id="out" />
    </Shell>
  );
});

export const ReferenceNodeView = memo(function ReferenceNodeView({ data, selected, width, height }: NodeProps<ReferenceFlowNode>) {
  const { outputRoot } = useBoardActions();
  const { node, rules, missing } = data;
  const abs = resolveFromRoot(outputRoot, node.path);
  const info = useImageInfo(abs);
  const { warnings, notes } = inputImageAdviceAll(info, rules);
  const hover = useHover(referenceHoverInfo({ node, image: info, missing, warnings, notes }));
  return (
    <ImageNode
      id={node.id}
      absPath={abs}
      name={node.display_name}
      missing={missing}
      selected={selected}
      width={width}
      height={height}
      className={warnings.length ? "node-warn" : ""}
      badges={info?.has_alpha ? ["透明"] : []}
      hover={hover}
    >
      <Port kind="image" type="source" position={Position.Right} id="out" />
    </ImageNode>
  );
});

export const ResultNodeView = memo(function ResultNodeView({ data, selected, width, height }: NodeProps<ResultFlowNode>) {
  const { outputRoot, table } = useBoardActions();
  const { node, rules, missing } = data;
  const abs = resolveFromRoot(outputRoot, node.path);
  const info = useImageInfo(abs);
  const modelName = findModel(table, node.record.model)?.display_name ?? node.record.model;
  const { warnings, notes } = inputImageAdviceAll(info, rules);
  const hover = useHover(resultHoverInfo({ node, modelName, image: info, missing, warnings, notes }));
  const badges = [...(info?.has_alpha ? ["透明"] : []), ...(node.layer_count > 0 ? [`${node.layer_count} 图层`] : [])];
  return (
    <ImageNode
      id={node.id}
      absPath={abs}
      name={node.file}
      missing={missing}
      selected={selected}
      width={width}
      height={height}
      className={warnings.length ? "node-warn" : ""}
      badges={badges}
      hover={hover}
    >
      <Port kind="image" type="target" position={Position.Left} id="in" isConnectable={false} />
      <Port kind="image" type="source" position={Position.Right} id="out" />
    </ImageNode>
  );
});

/** 按模型档位分组的可用模型选项；任务节点与工具栏的模型选择共用。 */
export function ModelOptions({ table, available }: { table: CapabilityTable; available: ModelCapability[] }) {
  const ids = new Set(available.map((m) => m.model_id));
  return (
    <>
      {modelsByTier(table).map((g) => {
        const models = g.models.filter((m) => ids.has(m.model_id));
        return (
          models.length > 0 && (
            <optgroup key={g.tier} label={TIER_LABELS[g.tier]}>
              {models.map((m) => (
                <option key={m.model_id} value={m.model_id}>
                  {m.display_name}
                </option>
              ))}
            </optgroup>
          )
        );
      })}
    </>
  );
}

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
      <div>模型档位：{model.tier ? TIER_LABELS[model.tier] : "未上架"}</div>
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
      return <span className="status status-queued">已取消</span>;
    case "interrupted":
      return <span className="status status-queued">已中断</span>;
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
  kind,
  ...drag
}: { id: string; label: ReactNode; children?: ReactNode; className?: string; connectable?: boolean; kind: PortKind } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`port-row ${className}`} {...drag}>
      <Port kind={kind} type="target" position={Position.Left} id={id} isConnectable={connectable} />
      <span className="port-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * 宽高比组合框（模型允许任意宽高比时）：首项「自动」、预设作快捷项，也能手填 W:H。
 * 手填在失焦 / Enter 时才提交（连续键入只有一个撤销步）：越界钳制到模型边界并提示范围，读不出恢复原值；Esc 放弃。
 */
function RatioCombo({
  rule,
  spec,
  ratios,
  unsupported,
  disabled,
  onPick,
}: {
  rule: SizeRule;
  spec: SizeSpec;
  ratios: string[];
  unsupported: boolean;
  disabled: boolean;
  /** AUTO_RATIO 或具体宽高比。 */
  onPick: (value: string) => void;
}) {
  const isAuto = isAutoRatio(spec);
  /** 非 null = 正在手填。 */
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  /** 选了列表项或按了 Esc：随后的失焦不提交手填内容。 */
  const discard = useRef(false);
  /** 聚焦时填入的文本：没改过就失焦不提交（越界的「（不支持）」值点一下不会被钳制）。 */
  const initial = useRef("");
  // 手填途中任务被锁定（禁用的输入框不触发失焦）：丢掉草稿。
  useEffect(() => {
    if (!disabled) return;
    setDraft(null);
    setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (hint === null) return;
    const timer = setTimeout(() => setHint(null), RATIO_HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);
  const shown = isAuto ? autoRatioLabel(rule, spec) : unsupported ? `${spec.ratio}（不支持）` : (spec.ratio ?? "");
  const commit = () => {
    const result = draft === null || draft === initial.current || discard.current ? null : commitRatioInput(rule, draft);
    discard.current = false;
    setDraft(null);
    setOpen(false);
    if (!result) return;
    if (result.clamped) setHint(`该模型宽高比范围 ${ratioRangeText(rule)}`);
    if (isAuto || result.ratio !== spec.ratio) onPick(result.ratio);
  };
  const pick = (value: string) => {
    discard.current = document.activeElement === input.current;
    input.current?.blur();
    setOpen(false);
    setHint(null);
    if (value === AUTO_RATIO ? !isAuto : isAuto || value !== spec.ratio) onPick(value);
  };
  return (
    <div className={`ratio-combo ${unsupported ? "ratio-unsupported" : ""}`}>
      <input
        ref={input}
        role="combobox"
        aria-label="宽高比"
        aria-expanded={open}
        aria-invalid={unsupported}
        className="nowheel"
        value={draft ?? shown}
        title={draft ?? shown}
        placeholder="W:H"
        disabled={disabled}
        spellCheck={false}
        onFocus={(e) => {
          initial.current = isAuto ? "" : (spec.ratio ?? "");
          setDraft(initial.current);
          setHint(null);
          const el = e.currentTarget;
          requestAnimationFrame(() => el.select());
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            discard.current = true;
            e.currentTarget.blur();
          } else if (e.key === "ArrowDown") setOpen(true);
        }}
      />
      <button
        className="icon ratio-combo-toggle"
        aria-label="宽高比预设"
        tabIndex={-1}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          input.current?.focus();
          setOpen((v) => !v);
        }}
      >
        ▾
      </button>
      {open && !disabled && (
        <ul className="ratio-combo-list nowheel" role="listbox" aria-label="宽高比预设" onMouseDown={(e) => e.preventDefault()}>
          {[AUTO_RATIO, ...ratios].map((r) => {
            const selected = r === AUTO_RATIO ? isAuto : !isAuto && r === spec.ratio;
            return (
              <li key={r} role="option" aria-selected={selected} className={selected ? "selected" : ""} onClick={() => pick(r)}>
                {r === AUTO_RATIO ? (isAuto ? shown : "自动") : r}
              </li>
            );
          })}
        </ul>
      )}
      {hint !== null && (
        <div className="ratio-combo-hint" role="status">
          {hint}
        </div>
      )}
    </div>
  );
}

export const TaskNodeView = memo(function TaskNodeView({ data }: NodeProps<TaskFlowNode>) {
  const { table, apply, availableModels, editRegion, previewNode, perform } = useBoardActions();
  const { node, ports, view, locked, workflow, images, slots, regionRender, hasPositive, status, expanded, run } = data;
  const { reasons, warnings, unreferenced, toggles } = view;
  const [infoOpen, setInfoOpen] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const updateInternals = useUpdateNodeInternals();
  const model = findModel(table, node.model);
  const rule = model?.workflows[workflow].size_rule;
  const modelLabel = view.model.label;
  const listed = view.model.state === "ok";

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
      if (to !== null) apply({ kind: "moveImagePort", taskId: node.id, from: dragFrom, to });
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
  }, [dragFrom, node.id, apply]);

  // 端口数量、顺序或展开状态变化后，React Flow 需要重新测量 Handle 位置。
  const portSignature = `${expanded}|${ports.negative}|${ports.imageSlots}|${hasPositive}|${slots.map((s) => `${s.kind}:${s.port}:${s.userPort}:${s.label}`).join(",")}`;
  useEffect(() => updateInternals(node.id), [portSignature, node.id, updateInternals]);

  const tiers = rule ? sizeTiersOf(rule) : [];
  const tier = node.size_spec.tier;
  const ratios = rule && tier ? ratiosForSizeTier(rule, tier) : [];
  const isAuto = isAutoRatio(node.size_spec);
  const setTier = (next: string) => apply({ kind: "setTier", taskId: node.id, tier: next });
  /** 最终发送的像素（与提交时同一换算）；发不出去或模型缺失时为 null。 */
  const pixels = view.size;
  /** 手动的宽高比在当前模型 / 分辨率档下发不出去：标「（不支持）」，值不动。 */
  const ratioUnsupported = view.ratioUnsupported;
  /** 节点标红只看错误；未就绪（如正向提示词未连接）不标红，但运行时同样被拦。 */
  const hasError = reasons.some((r) => r.category === "error");
  /** 宽高比：选「自动」转为跟随参考图（当场重算），选具体值转为手动；两者都是一个撤销步。 */
  const setRatio = (next: string) => apply({ kind: "setRatio", taskId: node.id, ratio: next === AUTO_RATIO ? null : next });
  const ratioNote = rule && node.size_spec.ratio !== null ? (isAuto ? autoRatioLabel(rule, node.size_spec) : ratioText(rule, node.size_spec.ratio)) : null;
  const hover = useHover(taskHoverInfo({ modelName: modelLabel, sizeSpec: node.size_spec, ratioNote, reasons, warnings, status }));
  const target = { kind: "node", nodeId: node.id } as const;

  return (
    <div className={`node node-task ${hasError ? "node-error" : ""}`} {...hover}>
      <div className="node-title task-title">
        <HoverButton
          className="icon nodrag expand-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "收起" : "展开"}
          info={textHoverInfo(expanded ? "收起参数" : "展开参数")}
          onClick={() => perform("toggleSettings", target)}
        >
          {expanded ? "▾" : "▸"}
        </HoverButton>
        <span>
          生成任务<span className="muted">{workflow === "image_edit" ? " · 图片编辑" : " · 文生图"}</span>
        </span>
        {status && <StatusBadge status={status} />}
      </div>

      {expanded ? (
        <>
          <div className="field nodrag">
            <span className="field-label">模型</span>
            <select value={node.model} onChange={(e) => apply({ kind: "setModel", taskId: node.id, model: e.target.value })} disabled={locked} aria-label="模型">
              {!listed && <option value={node.model}>{modelLabel}</option>}
              <ModelOptions table={table} available={availableModels} />
            </select>
            <HoverButton className="icon" aria-label="模型说明" info={textHoverInfo("模型说明")} onClick={() => setInfoOpen((v) => !v)} disabled={!model}>
              ⓘ
            </HoverButton>
          </div>
          {model?.request_shape === "seedream_flash_images_generations" && (
            <div className="field nodrag">
              <label>输出格式 <select aria-label="输出格式" value={node.output_options?.output_format ?? "png"} disabled={locked} onChange={(e) => apply({ kind: "setOutputOptions", taskId: node.id, options: { output_format: e.target.value as "png" | "jpeg", response_format: node.output_options?.response_format ?? "url", watermark: node.output_options?.watermark ?? false } })}><option value="png">PNG</option><option value="jpeg">JPEG</option></select></label>
              <label><input type="checkbox" checked={node.output_options?.watermark ?? false} disabled={locked} onChange={(e) => apply({ kind: "setOutputOptions", taskId: node.id, options: { output_format: node.output_options?.output_format ?? "png", response_format: node.output_options?.response_format ?? "url", watermark: e.target.checked } })} />水印</label>
            </div>
          )}
          {infoOpen && <ModelInfo modelId={node.model} onClose={() => setInfoOpen(false)} />}

          {(ports.layerDecomposition || ports.transparentBackground) && (
            <div className="toggles nodrag">
              {ports.layerDecomposition && (
                <label>
                  <input
                    type="checkbox"
                    checked={node.layer_decomposition}
                    disabled={locked || (!toggles.layerDecomposition.canEnable && !node.layer_decomposition)}
                    onChange={(e) => apply({ kind: "setTaskFlag", taskId: node.id, flag: "layer_decomposition", value: e.target.checked })}
                  />
                  拆分图层
                </label>
              )}
              {ports.transparentBackground && (
                <label className={!toggles.transparentBackground.canEnable && !node.transparent_background ? "disabled" : ""}>
                  <input
                    type="checkbox"
                    checked={node.transparent_background}
                    disabled={locked || (!toggles.transparentBackground.canEnable && !node.transparent_background)}
                    onChange={(e) => apply({ kind: "setTaskFlag", taskId: node.id, flag: "transparent_background", value: e.target.checked })}
                  />
                  透明背景{toggles.transparentBackground.hint && <span className="muted">（{toggles.transparentBackground.hint}）</span>}
                </label>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="task-summary">
          <div>{modelLabel}</div>
        </div>
      )}

      {/* 分辨率档与宽高比常驻：收起时也能改；模型与开关只在展开区。 */}
      <div className="field size-field nodrag">
        <select value={tier ?? ""} onChange={(e) => setTier(e.target.value)} aria-label="分辨率档" disabled={locked}>
          {tier !== null && !tiers.includes(tier) && <option value={tier}>{tier}（不支持）</option>}
          {tier === null && <option value="">自定义</option>}
          {tiers.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        {rule && rule.custom !== null && tier !== null ? (
          <RatioCombo rule={rule} spec={node.size_spec} ratios={ratios} unsupported={ratioUnsupported} disabled={locked} onPick={setRatio} />
        ) : (
          <select
            className={ratioUnsupported ? "ratio-unsupported" : ""}
            value={isAuto ? AUTO_RATIO : (node.size_spec.ratio ?? "")}
            onChange={(e) => setRatio(e.target.value)}
            aria-label="宽高比"
            disabled={locked || tier === null}
          >
            {rule && <option value={AUTO_RATIO}>{isAuto ? autoRatioLabel(rule, node.size_spec) : "自动"}</option>}
            {!isAuto && node.size_spec.ratio !== null && !ratios.includes(node.size_spec.ratio) && (
              <option value={node.size_spec.ratio}>{node.size_spec.ratio}（不支持）</option>
            )}
            {ratios.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        )}
        {pixels && (
          <span className="size-pixels" aria-label="发送像素">
            {pixels.width}×{pixels.height}
          </span>
        )}
      </div>

      <div className="ports">
        <PortRow id="positive" kind="positive" label={ports.negative ? "正向提示词" : "提示词"} className={hasPositive ? "" : "port-required"} connectable={!locked}>
          {!hasPositive && <span className="port-hint">拖提示词进来</span>}
        </PortRow>
        {ports.negative && <PortRow id="negative" kind="negative" label="负向提示词" connectable={!locked} />}
        {slots.map((slot) => {
          if (slot.kind === "overlay") {
            return (
              <PortRow
                key={`overlay-${slot.port}`}
                id={`overlay:${slot.port}`}
                kind="image"
                connectable={false}
                className="nodrag port-overlay"
                label={`↳ 图${slot.userPort} 的叠加图`}
              >
                <HoverSpan className="muted small" info={textHoverInfo(`叠加图由系统按图${slot.userPort} 的区域指示自动生成，发送时紧随原图；不占「图N」序号，但占 1 个参考图名额；不可重排、不可断开`)}>
                  自动生成 · 占 1 个名额
                </HoverSpan>
              </PortRow>
            );
          }
          const i = slot.handleIndex!;
          const canRegion = !!slot.edgeRef && regionRender !== null && !locked;
          return (
            <PortRow
              key={`image-${i}`}
              id={`${IMAGE_PORT_PREFIX}${i}`}
              kind="image"
              connectable={!locked}
              className={`nodrag port-filled ${unreferenced.includes(slot.userPort) ? "port-unreferenced" : ""} ${dragFrom === i ? "port-dragging" : ""} ${dropTo === i ? "port-drop" : ""}`}
              label={`图${slot.userPort}`}
              title={slot.label}
              data-port-index={i}
              onPointerDown={(e) => {
                if (locked || e.button !== 0 || (e.target as HTMLElement).closest(".react-flow__handle, button")) return;
                e.preventDefault();
                setDragFrom(i);
              }}
            >
              {slot.absPath && (
                <HoverButton
                  className="port-thumb nodrag"
                  aria-label={canRegion ? "框选修改区域" : "放大预览"}
                  info={portThumbHoverInfo(slot.label, canRegion ? "在放大预览里框出希望模型修改的位置" : "放大预览")}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => (canRegion ? editRegion(node.id, slot.edgeRef!) : slot.edgeRef && previewNode(slot.edgeRef.from[0]))}
                >
                  <img src={fileUrl(slot.absPath)} alt={slot.label} draggable={false} />
                  {slot.rects.map((r, k) => (
                    <span
                      key={k}
                      className="port-thumb-rect"
                      style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${(r[2] - r[0]) * 100}%`, height: `${(r[3] - r[1]) * 100}%`, background: regionCss(slot.firstRegion + k, 0.5), borderColor: regionCss(slot.firstRegion + k, 0.9) }}
                      title={`区域${slot.firstRegion + k + 1}`}
                    />
                  ))}
                </HoverButton>
              )}
              {slot.edgeRef && regionRender !== null && (
                <HoverButton
                  className="icon port-region"
                  aria-label="框选修改区域"
                  disabled={locked}
                  info={textHoverInfo(locked ? "任务排队 / 执行中，不能改区域" : slot.rects.length > 0 ? `已框选 ${slot.rects.length} 个修改区域，点击修改` : "在放大预览里框出希望模型修改的位置")}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => editRegion(node.id, slot.edgeRef!)}
                >
                  ▭{slot.rects.length > 0 && <span className="port-region-count">{slot.rects.length}</span>}
                </HoverButton>
              )}
              {!locked && (
                <HoverSpan className="grip" info={textHoverInfo("拖动调整参考图顺序")}>
                  ⋮⋮
                </HoverSpan>
              )}
            </PortRow>
          );
        })}
        {ports.imageSlots > images.length && (
          <PortRow id={`${IMAGE_PORT_PREFIX}${images.length}`} kind="image" connectable={!locked} className="nodrag port-empty" label={`图${images.length + 1}`}>
            <span className="port-hint">拖图进来</span>
          </PortRow>
        )}
        {expanded && model && !isSupported(model.workflows[workflow].supports_negative_prompt) && ports.negative && (
          <div className="muted small">当前模型不支持负向提示词</div>
        )}
      </div>

      {expanded && reasons.length > 0 && (
        <ul className={hasError ? "error-list" : "hint-list"}>
          {reasons.map((r) => (
            <li key={`${r.kind}:${r.text}`}>{r.text}</li>
          ))}
        </ul>
      )}
      {expanded && warnings.length > 0 && (
        <ul className="warn-list">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {expanded && status?.kind === "cancelled" && status.gatewayMayContinue && <div className="muted small">{CANCELLED_HINT}</div>}
      <div className="task-actions nodrag">
        <HoverButton className="primary" disabled={run.disabledReason !== null} info={actionHoverInfo(run)} onClick={() => perform(run.action, target)}>
          ▶ {run.label}
        </HoverButton>
      </div>
      <Port kind="image" type="source" position={Position.Right} id="result" isConnectable={false} />
    </div>
  );
});

export const nodeTypes = {
  prompt: PromptNodeView,
  reference: ReferenceNodeView,
  task: TaskNodeView,
  result: ResultNodeView,
};
