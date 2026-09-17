import { useCallback, useState } from "react";
import { basename } from "../core/paths";
import { ContextMenu } from "./ContextMenu";
import type { Session } from "./useBoardSessions";

interface Props {
  sessions: Session[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onRename: (key: string, title: string) => void;
  onCreate: () => void;
  onExportPack: (key: string) => void;
  onImportPack: () => void;
}

const titleOf = (s: Session) => (s.status === "ok" ? s.board.title : basename(s.path));

export function TabBar({ sessions, activeKey, onActivate, onClose, onRename, onCreate, onExportPack, onImportPack }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ key: string; at: { x: number; y: number } } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuSession = menu && sessions.find((s) => s.key === menu.key);

  const commit = (key: string) => {
    setEditing(null);
    onRename(key, draft);
  };

  return (
    <nav className="tabs">
      {sessions.map((s) => (
        <div
          key={s.key}
          className={`tab ${s.key === activeKey ? "tab-active" : ""} ${s.status !== "ok" || s.saveError ? "tab-bad" : ""}`}
          title={s.path}
          onClick={() => onActivate(s.key)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ key: s.key, at: { x: e.clientX, y: e.clientY } });
          }}
          onDoubleClick={() => {
            if (s.status !== "ok") return;
            setDraft(s.board.title);
            setEditing(s.key);
          }}
        >
          {editing === s.key ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit(s.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit(s.key);
                if (e.key === "Escape") setEditing(null);
              }}
            />
          ) : (
            <span className="tab-title">{titleOf(s)}</span>
          )}
          <button
            className="tab-close"
            title="关闭"
            onClick={(e) => {
              e.stopPropagation();
              onClose(s.key);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button className="tab-new" title="新建画板" onClick={onCreate}>
        ＋
      </button>
      <button className="tab-import" title="导入画板包…" onClick={onImportPack}>
        导入画板包…
      </button>
      {menuSession && menu && (
        <ContextMenu
          at={menu.at}
          items={[{ action: "exportPack", label: "导出画板包…", disabledReason: menuSession.status === "ok" ? null : "画板无法打开，不能导出" }]}
          onPick={() => onExportPack(menuSession.key)}
          onClose={closeMenu}
        />
      )}
    </nav>
  );
}
