import { useState } from "react";
import { basename } from "../core/paths";
import type { Session } from "./useBoardSessions";

interface Props {
  sessions: Session[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onRename: (key: string, title: string) => void;
  onCreate: () => void;
}

const titleOf = (s: Session) => (s.status === "ok" ? s.board.title : basename(s.path));

export function TabBar({ sessions, activeKey, onActivate, onClose, onRename, onCreate }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

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
    </nav>
  );
}
