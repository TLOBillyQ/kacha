// 项目预设（规格第 11 节）：内置预设只读，可复制为个人预设；个人预设可新建 / 编辑 / 删除，存 app-data 目录 presets.json。
// 「使用」由调用方在画布中央落成正向、负向两个提示词节点。
import { useEffect, useState } from "react";
import {
  BUILTIN_PRESETS,
  copyBuiltin,
  createPersonal,
  deletePersonal,
  parsePersonalPresets,
  PROJECTS,
  serializePersonalPresets,
  updatePersonal,
  validatePresetDraft,
  type Preset,
  type PresetDraft,
  type PresetProject,
} from "../core/presets";
import { ipc } from "../shell/ipc";

interface Props {
  onUse: (preset: Preset) => void;
  onClose: () => void;
}

type Loaded = { status: "loading" } | { status: "ready"; personal: Preset[]; problem: string | null; readOnly: boolean };

const EMPTY_DRAFT: PresetDraft = { name: "", project: "egg_party", prompt: "", negative_prompt: "" };

export function PresetDialog({ onUse, onClose }: Props) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [project, setProject] = useState<PresetProject | "all">("all");
  const [editing, setEditing] = useState<{ id: string | null; draft: PresetDraft } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ipc
      .readPresets()
      .catch(() => null)
      .then((text) => {
        const parsed = parsePersonalPresets(text);
        if (parsed.kind === "ok") setLoaded({ status: "ready", personal: parsed.presets, problem: null, readOnly: false });
        else if (parsed.kind === "newer")
          setLoaded({ status: "ready", personal: [], readOnly: true, problem: `presets.json 由更新版本的工具写入（format_version ${parsed.version}），个人预设暂不可用，也不会覆盖该文件` });
        else setLoaded({ status: "ready", personal: [], readOnly: false, problem: `presets.json 已损坏（${parsed.reason}），个人预设为空；新建或复制后会覆盖该文件` });
      });
  }, []);

  if (loaded.status === "loading") return null;
  const { personal, readOnly } = loaded;

  const persist = async (next: Preset[]) => {
    try {
      await ipc.writePresets(serializePersonalPresets(next));
      setLoaded({ ...loaded, personal: next, problem: null });
      setError(null);
      return true;
    } catch (e) {
      setError(`保存个人预设失败：${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  const newId = () => crypto.randomUUID();
  const saveDraft = async () => {
    if (!editing) return;
    const problem = validatePresetDraft(editing.draft);
    if (problem) return setError(problem);
    const next = editing.id ? updatePersonal(personal, editing.id, editing.draft) : createPersonal(personal, editing.draft, newId);
    if (await persist(next)) setEditing(null);
  };

  const remove = async (preset: Preset) => {
    if (window.confirm(`删除个人预设「${preset.name}」？`)) await persist(deletePersonal(personal, preset.id));
  };

  const visible = (list: readonly Preset[]) => list.filter((p) => project === "all" || p.project === project);

  const row = (preset: Preset) => (
    <li key={preset.id} className="preset-row">
      <div className="preset-main">
        <strong>{preset.name}</strong>
        <span className="badge">{PROJECTS[preset.project]}</span>
        {preset.builtin && <span className="muted small">内置 · 只读</span>}
        <div className="muted small preset-text" title={preset.prompt}>
          正向：{preset.prompt}
        </div>
        {preset.negative_prompt.trim() && (
          <div className="muted small preset-text" title={preset.negative_prompt}>
            负向：{preset.negative_prompt}
          </div>
        )}
      </div>
      <div className="preset-actions">
        <button className="primary" onClick={() => onUse(preset)}>
          使用
        </button>
        {preset.builtin ? (
          <button onClick={() => void persist(copyBuiltin(personal, preset, newId))} disabled={readOnly}>
            复制为个人
          </button>
        ) : (
          <>
            <button onClick={() => setEditing({ id: preset.id, draft: preset })} disabled={readOnly}>
              编辑
            </button>
            <button className="link" onClick={() => void remove(preset)} disabled={readOnly}>
              删除
            </button>
          </>
        )}
      </div>
    </li>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-label="项目预设">
        <div className="modal-head">
          <strong>项目预设</strong>
          <select value={project} onChange={(e) => setProject(e.target.value as PresetProject | "all")}>
            <option value="all">全部项目</option>
            {Object.entries(PROJECTS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>
        {loaded.problem && <div className="notice notice-warn">{loaded.problem}</div>}
        <div className="muted small">选取预设后在画布中央落成正向、负向两个提示词节点，连到任务的对应端口即可使用。</div>

        {editing ? (
          <div className="preset-editor">
            <label className="form-row">
              <span>名称</span>
              <input value={editing.draft.name} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })} autoFocus />
            </label>
            <label className="form-row">
              <span>项目</span>
              <select value={editing.draft.project} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, project: e.target.value as PresetProject } })}>
                {Object.entries(PROJECTS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-col">
              <span>正向提示词</span>
              <textarea rows={4} value={editing.draft.prompt} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, prompt: e.target.value } })} />
            </label>
            <label className="form-col">
              <span>负向提示词（可空）</span>
              <textarea rows={3} value={editing.draft.negative_prompt} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, negative_prompt: e.target.value } })} />
            </label>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-foot">
              <button
                onClick={() => {
                  setEditing(null);
                  setError(null);
                }}
              >
                取消
              </button>
              <button className="primary" onClick={() => void saveDraft()}>
                保存
              </button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <strong className="small">内置预设</strong>
              {visible(BUILTIN_PRESETS).length ? <ul className="preset-list">{visible(BUILTIN_PRESETS).map(row)}</ul> : <div className="empty-small">暂无内置预设</div>}
            </div>
            <div>
              <div className="modal-head">
                <strong className="small">个人预设</strong>
                <button onClick={() => setEditing({ id: null, draft: { ...EMPTY_DRAFT, project: project === "all" ? EMPTY_DRAFT.project : project } })} disabled={readOnly}>
                  ＋ 新建
                </button>
              </div>
              {visible(personal).length ? <ul className="preset-list">{visible(personal).map(row)}</ul> : <div className="empty-small">暂无个人预设</div>}
            </div>
            {error && <div className="form-error">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
