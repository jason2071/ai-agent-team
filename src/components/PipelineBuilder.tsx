import { useState } from "react";
import type { Agent } from "../agents";
import type { PipelinePreset, PipelineStep } from "../workflow";

function uid() {
  return `pl-${Math.random().toString(36).slice(2, 8)}`;
}
function move<T>(arr: T[], from: number, to: number): T[] {
  const a = [...arr];
  const [x] = a.splice(from, 1);
  a.splice(to, 0, x);
  return a;
}

export function PipelineBuilder({
  agents,
  pipelines,
  projectDir,
  onSave,
  onClose,
  onRun,
  onPickProject,
  onAttachDocs,
}: {
  agents: Agent[];
  pipelines: PipelinePreset[];
  projectDir: string | null;
  onSave: (p: PipelinePreset[]) => void;
  onClose: () => void;
  onRun: (preset: PipelinePreset, task: string) => void;
  onPickProject: () => void;
  onAttachDocs: () => Promise<string[]>;
}) {
  const [draft, setDraft] = useState<PipelinePreset | null>(null);
  const [runTarget, setRunTarget] = useState<PipelinePreset | null>(null);
  const [task, setTask] = useState("");
  const [docs, setDocs] = useState<string[]>([]);

  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const roleOf = (id: string) => agents.find((a) => a.id === id)?.role ?? "";
  const summary = (steps: PipelineStep[]) =>
    steps.map((s) => (s.gate ? `[review ${nameOf(s.agent)}]` : nameOf(s.agent))).join(" → ") || "(ว่าง)";

  function upsert(p: PipelinePreset) {
    const exists = pipelines.some((x) => x.id === p.id);
    onSave(exists ? pipelines.map((x) => (x.id === p.id ? p : x)) : [...pipelines, p]);
    setDraft(null);
  }
  function remove(id: string) {
    onSave(pipelines.filter((x) => x.id !== id));
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Pipeline Builder</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        {draft ? (
          <PipelineEditor
            draft={draft}
            agents={agents}
            nameOf={nameOf}
            roleOf={roleOf}
            onChange={setDraft}
            onSubmit={() => upsert(draft)}
            onCancel={() => setDraft(null)}
          />
        ) : runTarget ? (
          <div className="agent-form">
            <div className="pl-summary">▶ {runTarget.name}: {summary(runTarget.steps)}</div>

            {/* root project (cwd) — agent ทุกตัวทำงาน + อ่านไฟล์ใน folder นี้ */}
            <div className="frow tools">
              <span>Root project:</span>
              <button className="tool-btn" onClick={onPickProject}>
                📁 {projectDir ? projectDir.split("/").pop() : "เลือก project (จำเป็น)"}
              </button>
            </div>
            {!projectDir && (
              <div className="muted small">⚠ ต้องตั้ง root project ก่อน — agent ถึงจะอ่าน/เขียนไฟล์ใน repo ได้</div>
            )}

            {/* แนบ docs -> เขียนลง {project}/docs/ */}
            <div className="frow tools">
              <span>เอกสาร:</span>
              <button
                className="tool-btn ghost"
                disabled={!projectDir}
                title={projectDir ? "แนบไฟล์ → เขียนลง docs/" : "ตั้ง project ก่อน"}
                onClick={async () => {
                  const added = await onAttachDocs();
                  if (added.length) setDocs((d) => [...new Set([...d, ...added])]);
                }}
              >
                📎 แนบ docs → docs/
              </button>
              {docs.map((d) => (
                <span key={d} className="chip" title={d}>{d}</span>
              ))}
            </div>

            <label className="full">
              Requirements / โจทย์
              <textarea
                rows={4}
                value={task}
                placeholder="พิมพ์สิ่งที่อยากให้ทีมทำ เช่น ทำ feature login ด้วย Go + React"
                onChange={(e) => setTask(e.target.value)}
              />
            </label>
            <div className="form-foot">
              <button className="mini" onClick={() => { setRunTarget(null); setTask(""); setDocs([]); }}>ยกเลิก</button>
              <button
                className="mini primary"
                disabled={!task.trim() || !projectDir}
                onClick={() => {
                  const note = docs.length
                    ? `\n\n[เอกสารอ้างอิงใน repo — อ่านก่อนเริ่ม]\n${docs.map((d) => `- ${d}`).join("\n")}`
                    : "";
                  onRun(runTarget, task.trim() + note);
                }}
              >
                ▶ รัน
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="agent-list">
              {pipelines.length === 0 && (
                <div className="muted small">ยังไม่มี pipeline — กด "+ สร้าง" เพื่อเรียงลำดับ agent เอง</div>
              )}
              {pipelines.map((p) => (
                <div key={p.id} className="agent-row">
                  <div className="agent-row-meta" style={{ minWidth: 90 }}>
                    <b>{p.name}</b>
                    <span className="muted small">{p.steps.length} ขั้น</span>
                  </div>
                  <span className="muted small pl-row-sum">{summary(p.steps)}</span>
                  <button className="mini" onClick={() => { setRunTarget(p); setTask(""); }}>▶ รัน</button>
                  <button className="mini" onClick={() => setDraft({ ...p, steps: [...p.steps] })}>แก้</button>
                  <button className="mini danger" onClick={() => remove(p.id)}>ลบ</button>
                </div>
              ))}
            </div>
            <div className="modal-foot">
              <button
                className="mini primary"
                onClick={() => setDraft({ id: uid(), name: "", steps: [] })}
              >
                + สร้าง pipeline
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PipelineEditor({
  draft,
  agents,
  nameOf,
  roleOf,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: PipelinePreset;
  agents: Agent[];
  nameOf: (id: string) => string;
  roleOf: (id: string) => string;
  onChange: (p: PipelinePreset) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const set = (steps: PipelineStep[]) => onChange({ ...draft, steps });

  const addStep = (agent: string) => set([...draft.steps, { agent }]);
  const removeStep = (i: number) => set(draft.steps.filter((_, j) => j !== i));
  const toggleGate = (i: number) =>
    set(draft.steps.map((s, j) => (j === i ? { ...s, gate: !s.gate } : s)));

  function onDrop(to: number) {
    if (dragIdx === null || dragIdx === to) return;
    set(move(draft.steps, dragIdx, to));
    setDragIdx(null);
  }

  // valid: มีชื่อ + อย่างน้อย 1 ขั้น + step แรกไม่ใช่ gate
  const valid =
    draft.name.trim() && draft.steps.length > 0 && !draft.steps[0]?.gate;

  return (
    <div className="agent-form">
      <label className="full">
        ชื่อ pipeline
        <input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
      </label>

      <div className="frow tools">
        <span>เพิ่ม agent:</span>
        {agents.map((a) => (
          <button
            key={a.id}
            className="handoff-btn"
            style={{ borderColor: `${a.accent}66`, color: a.accent }}
            onClick={() => addStep(a.id)}
            title={`เพิ่ม ${a.name} (${a.role})`}
          >
            + {a.name}
          </button>
        ))}
      </div>

      <div className="pl-steps">
        {draft.steps.length === 0 && (
          <div className="muted small">คลิก agent ด้านบนเพื่อเพิ่มขั้น แล้วลากเรียงลำดับ</div>
        )}
        {draft.steps.map((s, i) => (
          <div
            key={i}
            className={`pipeline-step ${dragIdx === i ? "dragging" : ""} ${s.gate ? "gate" : ""}`}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(i)}
            onDragEnd={() => setDragIdx(null)}
          >
            <span className="pl-handle" title="ลากเรียง">⠿</span>
            <span className="pl-idx">{i + 1}</span>
            <span className="pl-name">
              {nameOf(s.agent)}
              <span className="muted small"> · {s.gate ? "review gate" : roleOf(s.agent)}</span>
            </span>
            <label className="chk" title={i === 0 ? "step แรกเป็น gate ไม่ได้" : "ให้ step นี้ review ขั้นก่อนหน้า"}>
              <input
                type="checkbox"
                checked={!!s.gate}
                disabled={i === 0}
                onChange={() => toggleGate(i)}
              />
              review
            </label>
            <button className="mini danger" onClick={() => removeStep(i)}>ลบ</button>
          </div>
        ))}
      </div>

      <div className="form-foot">
        <button className="mini" onClick={onCancel}>ยกเลิก</button>
        <button className="mini primary" onClick={onSubmit} disabled={!valid}>บันทึก</button>
      </div>
    </div>
  );
}
