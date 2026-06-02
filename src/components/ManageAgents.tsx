import { useState } from "react";
import type { Agent } from "../agents";

const MODELS = [
  { v: "", label: "default (subscription)" },
  { v: "claude-opus-4-8", label: "Opus 4.8" },
  { v: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { v: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];
const PERMS = [
  { v: "", label: "default (claude)" },
  { v: "plan", label: "plan (read-only วางแผน)" },
  { v: "default", label: "default (ถามก่อนใช้ tool เสี่ยง)" },
  { v: "acceptEdits", label: "acceptEdits (แก้ไฟล์อัตโนมัติ)" },
  { v: "bypassPermissions", label: "bypass (ทำได้ทุกอย่าง)" },
];
const TOOLS = ["Read", "Write", "Edit", "Bash"];

function blank(): Agent {
  return {
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    role: "",
    gender: "male",
    accent: "#7dd3fc",
    bg: "",
    initials: "",
    persona: "Answer in Thai, keep code/technical terms in English.",
  };
}

export function ManageAgents({
  agents,
  onSave,
  onClose,
  onReset,
}: {
  agents: Agent[];
  onSave: (a: Agent[]) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<Agent | null>(null);

  function upsert(a: Agent) {
    const exists = agents.some((x) => x.id === a.id);
    const next = exists ? agents.map((x) => (x.id === a.id ? a : x)) : [...agents, a];
    onSave(next);
    setDraft(null);
  }
  function remove(id: string) {
    onSave(agents.filter((x) => x.id !== id));
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>จัดการ Agent</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        {draft ? (
          <AgentForm
            draft={draft}
            onChange={setDraft}
            onSubmit={() => upsert(draft)}
            onCancel={() => setDraft(null)}
          />
        ) : (
          <>
            <div className="agent-list">
              {agents.map((a) => (
                <div key={a.id} className="agent-row">
                  <span className="dot-accent" style={{ background: a.accent }} />
                  <div className="agent-row-meta">
                    <b>
                      {a.name} <span className="muted">{a.gender === "female" ? "♀" : "♂"}</span>
                    </b>
                    <span className="muted">{a.role}</span>
                  </div>
                  <span className="muted small">
                    {a.allowedTools?.join("/") || "read-only"} · {a.model || "default"}
                  </span>
                  <button className="mini" onClick={() => setDraft({ ...a })}>แก้</button>
                  <button className="mini danger" onClick={() => remove(a.id)} disabled={agents.length <= 1}>
                    ลบ
                  </button>
                </div>
              ))}
            </div>
            <div className="modal-foot">
              <button className="mini" onClick={() => setDraft(blank())}>+ เพิ่ม agent</button>
              <button className="mini" onClick={onReset}>คืนค่าเริ่มต้น</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AgentForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: Agent;
  onChange: (a: Agent) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const set = (p: Partial<Agent>) => onChange({ ...draft, ...p });
  const toggleTool = (t: string) => {
    const cur = draft.allowedTools ?? [];
    set({ allowedTools: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t] });
  };
  const valid = draft.name.trim() && draft.role.trim() && draft.persona.trim();

  return (
    <div className="agent-form">
      <div className="frow">
        <label>ชื่อ<input value={draft.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label>บทบาท<input value={draft.role} onChange={(e) => set({ role: e.target.value })} /></label>
      </div>
      <div className="frow">
        <label>เพศ
          <select value={draft.gender} onChange={(e) => set({ gender: e.target.value as Agent["gender"] })}>
            <option value="male">ชาย ♂</option>
            <option value="female">หญิง ♀</option>
          </select>
        </label>
        <label>สี<input type="color" value={draft.accent} onChange={(e) => set({ accent: e.target.value })} /></label>
        <label>ย่อ<input maxLength={3} value={draft.initials} onChange={(e) => set({ initials: e.target.value.toUpperCase() })} /></label>
      </div>
      <div className="frow">
        <label>Model
          <select value={draft.model ?? ""} onChange={(e) => set({ model: e.target.value || undefined })}>
            {MODELS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
          </select>
        </label>
        <label>Permission
          <select value={draft.permissionMode ?? ""} onChange={(e) => set({ permissionMode: (e.target.value || undefined) as Agent["permissionMode"] })}>
            {PERMS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
          </select>
        </label>
      </div>
      <div className="frow tools">
        <span>Tools:</span>
        {TOOLS.map((t) => (
          <label key={t} className="chk">
            <input type="checkbox" checked={draft.allowedTools?.includes(t) ?? false} onChange={() => toggleTool(t)} />
            {t}
          </label>
        ))}
        <span className="muted small">(ไม่เลือก = read-only)</span>
      </div>
      <label className="full">Persona (system prompt)
        <textarea rows={5} value={draft.persona} onChange={(e) => set({ persona: e.target.value })} />
      </label>
      <div className="form-foot">
        <button className="mini" onClick={onCancel}>ยกเลิก</button>
        <button className="mini primary" onClick={onSubmit} disabled={!valid}>บันทึก</button>
      </div>
    </div>
  );
}
