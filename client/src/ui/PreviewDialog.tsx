// 放大预览弹窗：纯预览、编辑图片连线的指示区域（拖拽画矩形）、结果节点的图层侧栏与导出。
// 弹窗必须挂在画布根（BoardCanvas），不能挂进 React Flow 节点内：变换容器里 position:fixed 会失效。
import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import type { PortRef, RegionRender } from "../core/board";
import { basename, dirname, joinPath } from "../core/paths";
import { layersExportJson, type LayerRecord } from "../core/taskDir";
import { fileUrl, ipc } from "../shell/ipc";
import { useBoardActions, useImageInfos } from "./context";
import { dragRect, isMeaningful, moveRect, resizeRect, type Corner, type Point01, type Rect01 } from "./rects";

export interface PreviewLayer {
  record: LayerRecord;
  absPath: string;
}

/** 弹窗里可编辑区域的一条目标连线（任务端口行单条，或参考图 / 结果扇出的多条）。 */
export interface RegionTarget {
  label: string;
  edgeRef: { from: PortRef; to: PortRef };
  rects: Rect01[];
  render: RegionRender;
}

export interface PreviewRequest {
  title: string;
  /** 主图（底图）绝对路径。 */
  absPath: string;
  /** 结果节点的图层（z 升序）；有则露出图层侧栏。 */
  layers?: PreviewLayer[];
  /** 结果节点 id：图层侧栏露出「加为参考图 / 以此继续编辑」。 */
  resultId?: string;
  /** 可编辑区域的连线目标；空 = 纯预览。 */
  regionTargets?: RegionTarget[];
  /** 打开即进入该连线的区域编辑（任务端口行入口）。 */
  edit?: RegionTarget;
  /** 本次编辑用到的区域轮廓（结果节点：产出任务提交快照里的 region，只读描边回显）；空 = 不露出开关。 */
  regionOutlines?: Rect01[];
}

interface Props {
  req: PreviewRequest;
  toast: (message: string) => void;
  onClose: () => void;
}

type Drag =
  | { kind: "draw"; start: Point01; current: Point01 }
  | { kind: "move"; index: number; start: Point01; origin: Rect01; current: Point01 }
  | { kind: "resize"; index: number; corner: Corner; origin: Rect01; current: Point01 };

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const OVERLAY = "rgba(128,0,255,0.5)";

function suffixed(path: string, n: number): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return joinPath(dirname(path), `${stem} (${n})${ext}`);
}

/** writeNewFile 只新建不覆盖：重名时在文件名后加序号再试；非重名错误直接抛出。 */
async function writeNew(bytes: Uint8Array, target: string): Promise<string> {
  for (let n = 1; n <= 99; n++) {
    const path = n === 1 ? target : suffixed(target, n);
    try {
      await ipc.writeNewFile(path, bytes);
      return path;
    } catch (e) {
      if (await ipc.isFile(path).catch(() => false)) continue;
      throw e;
    }
  }
  throw new Error("同名文件太多");
}

export function PreviewDialog({ req, toast, onClose }: Props) {
  const { setEdgeRegion, addAsReference, continueEditing } = useBoardActions();
  const stage = useRef<HTMLImageElement>(null);
  const [editing, setEditing] = useState<RegionTarget | null>(req.edit ?? null);
  const [rects, setRects] = useState<Rect01[]>(() => (req.edit ? req.edit.rects.map((r) => [...r] as Rect01) : []));
  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [solo, setSolo] = useState<number | null>(null);
  const [showOutlines, setShowOutlines] = useState(false);
  const [pickSource, setPickSource] = useState(0);
  const [busy, setBusy] = useState(false);
  const layers = req.layers ?? [];
  const targets = req.regionTargets ?? [];
  const outlines = req.regionOutlines ?? [];
  const layerInfos = useImageInfos(layers.map((l) => l.absPath));

  const pointAt = (e: PointerEvent | React.PointerEvent): Point01 => {
    const box = stage.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)) };
  };

  const startEdit = (target: RegionTarget) => {
    setEditing(target);
    setRects(target.rects.map((r) => [...r] as Rect01));
    setSelected(null);
    setSolo(null);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!editing || e.button !== 0 || !stage.current) return;
    const p = pointAt(e);
    const handle = (e.target as HTMLElement).closest<HTMLElement>("[data-rect-index]");
    const index = handle ? Number(handle.dataset.rectIndex) : null;
    const corner = handle?.dataset.corner as Corner | undefined;
    e.preventDefault();
    if (index !== null && corner) setDrag({ kind: "resize", index, corner, origin: rects[index], current: p });
    else if (index !== null) {
      setSelected(index);
      setDrag({ kind: "move", index, start: p, origin: rects[index], current: p });
    } else {
      setSelected(null);
      setDrag({ kind: "draw", start: p, current: p });
    }
  };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => setDrag((d) => (d ? { ...d, current: pointAt(e) } : d));
    const up = (e: PointerEvent) => {
      const p = pointAt(e);
      if (drag.kind === "draw") {
        const r = dragRect(drag.start, p);
        if (isMeaningful(r)) {
          setRects((rs) => [...rs, r]);
          setSelected(rects.length);
        }
      } else if (drag.kind === "move") {
        setRects((rs) => rs.map((r, i) => (i === drag.index ? moveRect(drag.origin, p.x - drag.start.x, p.y - drag.start.y) : r)));
      } else {
        setRects((rs) => rs.map((r, i) => (i === drag.index ? resizeRect(drag.origin, drag.corner, p) : r)));
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [drag, rects.length]);

  const shown: Rect01[] = rects.map((r, i) => {
    if (drag?.kind === "move" && drag.index === i) return moveRect(drag.origin, drag.current.x - drag.start.x, drag.current.y - drag.start.y);
    if (drag?.kind === "resize" && drag.index === i) return resizeRect(drag.origin, drag.corner, drag.current);
    return r;
  });
  if (drag?.kind === "draw") shown.push(dragRect(drag.start, drag.current));
  const removeSelected = () => {
    if (selected === null) return;
    setRects((rs) => rs.filter((_, i) => i !== selected));
    setSelected(null);
  };
  const saveRegion = () => {
    if (!editing) return;
    setEdgeRegion(editing.edgeRef, rects.length ? { rects, render: editing.render } : null);
    onClose();
  };

  const runExport = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    try {
      const done = await fn();
      if (done) toast(done);
    } catch (e) {
      toast(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const exportOne = (absPath: string) =>
    runExport(async () => {
      const target = await save({ defaultPath: basename(absPath) });
      if (!target) return null;
      const bytes = await ipc.readFileBytes(absPath);
      return `已保存：${await writeNew(bytes, target)}`;
    });
  const exportAll = () =>
    runExport(async () => {
      const dir = await open({ directory: true });
      if (!dir) return null;
      await writeNew(await ipc.readFileBytes(req.absPath), joinPath(dir, basename(req.absPath)));
      for (const layer of layers) await writeNew(await ipc.readFileBytes(layer.absPath), joinPath(dir, basename(layer.record.file)));
      const json = await writeNew(new TextEncoder().encode(layersExportJson(layers.map((l) => l.record))), joinPath(dir, "layers.json"));
      return `已保存底图、${layers.length} 个图层与 ${basename(json)}`;
    });

  const layerIndex = pickSource > 0 && pickSource <= layers.length ? pickSource : null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal modal-preview ${layers.length ? "modal-preview-wide" : ""}`} role="dialog" aria-label={req.title}>
        <div className="modal-head">
          <strong>{req.title}</strong>
          {editing && <span className="badge">编辑区域：{editing.label}</span>}
          {solo !== null && <span className="badge">单层：图层{solo + 1}</span>}
          {outlines.length > 0 && !editing && (
            <label className="small" title="本次编辑用到的指示区域（只读描边，来自产出任务的提交快照）">
              <input type="checkbox" checked={showOutlines} onChange={(e) => setShowOutlines(e.target.checked)} />
              区域轮廓
            </label>
          )}
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="preview-body">
          <div className="preview-stage nodrag" onPointerDown={onPointerDown}>
            <div className="preview-canvas">
              {solo !== null ? (
                <img ref={stage} src={fileUrl(layers[solo].absPath)} alt={layers[solo].record.file} draggable={false} />
              ) : (
                <img ref={stage} src={fileUrl(req.absPath)} alt={req.title} draggable={false} />
              )}
              {solo === null &&
                layers.map((layer, i) =>
                  checked.has(i) ? <img key={layer.record.file} className="preview-layer" src={fileUrl(layer.absPath)} alt={layer.record.file} draggable={false} /> : null,
                )}
              {solo === null &&
                showOutlines &&
                outlines.map((r, i) => (
                  <div
                    key={`outline-${i}`}
                    className="preview-outline"
                    style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${(r[2] - r[0]) * 100}%`, height: `${(r[3] - r[1]) * 100}%` }}
                  />
                ))}
              {solo === null &&
                shown.map((r, i) => (
                  <div
                    key={i}
                    className={`preview-rect ${editing && selected === i ? "preview-rect-selected" : ""}`}
                    data-rect-index={editing ? i : undefined}
                    style={{
                      left: `${r[0] * 100}%`,
                      top: `${r[1] * 100}%`,
                      width: `${(r[2] - r[0]) * 100}%`,
                      height: `${(r[3] - r[1]) * 100}%`,
                      background: OVERLAY,
                    }}
                  >
                    {editing && selected === i &&
                      CORNERS.map((c) => <span key={c} className={`preview-handle preview-handle-${c}`} data-rect-index={i} data-corner={c} />)}
                  </div>
                ))}
            </div>
          </div>
          {layers.length > 0 && (
            <div className="preview-side">
              <div className="muted small">图层（点缩略图看单层，勾选叠加显示）</div>
              <ul className="layer-list">
                {layers.map((layer, i) => (
                  <li key={layer.record.file}>
                    <label>
                      <input
                        type="checkbox"
                        checked={checked.has(i)}
                        onChange={() =>
                          setChecked((s) => {
                            const next = new Set(s);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          })
                        }
                      />
                      <img
                        src={fileUrl(layer.absPath)}
                        alt={layer.record.file}
                        draggable={false}
                        className={solo === i ? "layer-solo" : ""}
                        title="点选只显示该层（再点取消）"
                        onClick={(e) => {
                          e.preventDefault();
                          setSolo((s) => (s === i ? null : i));
                        }}
                      />
                      <span>
                        图层{i + 1}
                        {layerInfos.get(layer.absPath)?.has_alpha && <span className="badge">透明</span>}
                      </span>
                    </label>
                    <button className="link small" disabled={busy} onClick={() => void exportOne(layer.absPath)}>
                      保存
                    </button>
                  </li>
                ))}
              </ul>
              {req.resultId && (
                <div className="preview-pick">
                  <select value={pickSource} onChange={(e) => setPickSource(Number(e.target.value))}>
                    <option value={0}>底图（合成结果）</option>
                    {layers.map((layer, i) => (
                      <option key={layer.record.file} value={i + 1}>
                        图层{i + 1}
                      </option>
                    ))}
                  </select>
                  <button disabled={busy} onClick={() => continueEditing(req.resultId!, layerIndex)}>
                    以此继续编辑
                  </button>
                  <button disabled={busy} onClick={() => addAsReference(req.resultId!, layerIndex)}>
                    加为参考图
                  </button>
                </div>
              )}
              <div className="preview-export">
                <button disabled={busy} onClick={() => void exportOne(req.absPath)}>
                  保存底图
                </button>
                <button disabled={busy} onClick={() => void exportAll()} title="选一个目录，写入底图、全部图层文件与 layers.json（重名自动加序号）">
                  保存全部图层 + layers.json
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          {editing ? (
            <>
              <span className="muted">拖拽空白处画新矩形；拖动矩形移动，拖动角柄缩放</span>
              <button disabled={selected === null} onClick={removeSelected}>
                删除选中
              </button>
              <button disabled={rects.length === 0} onClick={() => (setRects([]), setSelected(null))}>
                清空
              </button>
              <button onClick={onClose}>取消</button>
              <button className="primary" onClick={saveRegion}>
                保存区域
              </button>
            </>
          ) : (
            <>
              <span className="muted">
                {targets.length > 0 && (
                  <>
                    指示区域：
                    {targets.map((t) => (
                      <button key={`${t.edgeRef.from.join(":")}->${t.edgeRef.to.join(":")}`} className="link" onClick={() => startEdit(t)}>
                        {t.label}
                        {t.rects.length > 0 ? `（${t.rects.length} 区域）` : ""}
                      </button>
                    ))}
                  </>
                )}
              </span>
              <button onClick={onClose}>关闭</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
