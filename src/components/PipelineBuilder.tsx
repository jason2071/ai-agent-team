import { useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Agent } from "../agents";
import {
  graphToWorkflow,
  isGateRole,
  type PipelinePreset,
  type PipelineGraph,
  type WFHistory,
} from "../workflow";

function uid(p = "pl") {
  return `${p}-${Math.random().toString(36).slice(2, 8)}`;
}

// ===== custom node =====
interface AgentData {
  agent: string;
  review?: boolean;
  name: string;
  role: string;
  accent: string;
  [k: string]: unknown;
}

function AgentNode({ id, data }: NodeProps) {
  const rf = useReactFlow();
  const d = data as AgentData;
  const isGate = isGateRole(d.role); // reviewer / QA-tester = gate อัตโนมัติ
  return (
    <div className={`rf-agent-node ${isGate ? "review" : ""}`} style={{ borderColor: d.accent }}>
      <Handle type="target" position={Position.Left} />
      <div className="rf-an-name" style={{ color: d.accent }}>
        {isGate ? "🛡 " : ""}{d.name}
      </div>
      <div className="rf-an-role">{isGate ? `${d.role} · gate` : d.role}</div>
      <div className="rf-an-actions">
        <button className="rf-an-x" onClick={() => rf.deleteElements({ nodes: [{ id }] })}>✕ ลบ</button>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const EDGE_OPTS = { markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2 } };

export function PipelineBuilder({
  agents,
  pipelines,
  projectDir,
  onSave,
  onClose,
  onRun,
  onPickProject,
  onAttachDocs,
  history = [],
  onClearHistory,
}: {
  agents: Agent[];
  pipelines: PipelinePreset[];
  projectDir: string | null;
  onSave: (p: PipelinePreset[]) => void;
  onClose: () => void;
  onRun: (preset: PipelinePreset, task: string) => void;
  onPickProject: () => void;
  onAttachDocs: () => Promise<string[]>;
  history?: WFHistory[];
  onClearHistory?: () => void;
}) {
  const [draft, setDraft] = useState<PipelinePreset | null>(null);
  const [runTarget, setRunTarget] = useState<PipelinePreset | null>(null);
  const [task, setTask] = useState("");
  const [docs, setDocs] = useState<string[]>([]);
  const [histOpen, setHistOpen] = useState(false);
  const [openLog, setOpenLog] = useState<string | null>(null);

  const label = (id: string) => {
    const a = agents.find((x) => x.id === id);
    return { name: a?.name ?? id, role: a?.role ?? "" };
  };
  const summary = (p: PipelinePreset) => {
    if (p.graph) {
      const rev = p.graph.nodes.some((n) => isGateRole(label(n.agent).role));
      return `${p.graph.nodes.length} node · ${p.graph.edges.length} เส้น${rev ? " · มี gate" : ""}`;
    }
    return (p.steps ?? [])
      .map((s) => (s.gate ? `[review ${label(s.agent).name}]` : s.par ? `∥ ${label(s.agent).name}` : label(s.agent).name))
      .join(" → ") || "(ว่าง)";
  };

  function upsert(p: PipelinePreset) {
    const exists = pipelines.some((x) => x.id === p.id);
    onSave(exists ? pipelines.map((x) => (x.id === p.id ? p : x)) : [...pipelines, p]);
    setDraft(null);
  }
  function remove(id: string) {
    onSave(pipelines.filter((x) => x.id !== id));
  }

  return (
    <div className="modal-backdrop">
      <div className={`modal ${draft ? "wide" : ""}`}>
        <div className="modal-head">
          <h2>Pipeline Builder</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        {draft ? (
          <PipelineEditor
            draft={draft}
            agents={agents}
            label={label}
            onSubmit={upsert}
            onCancel={() => setDraft(null)}
          />
        ) : runTarget ? (
          <div className="agent-form">
            <div className="pl-summary">▶ {runTarget.name}: {summary(runTarget)}</div>

            <div className="frow tools">
              <span>Root project:</span>
              <button className="tool-btn" onClick={onPickProject}>
                📁 {projectDir ? projectDir.split("/").pop() : "เลือก project (จำเป็น)"}
              </button>
            </div>
            {!projectDir && (
              <div className="muted small">⚠ ต้องตั้ง root project ก่อน — agent ถึงจะอ่าน/เขียนไฟล์ใน repo ได้</div>
            )}

            <div className="frow tools">
              <span>เอกสาร:</span>
              <button
                className="tool-btn ghost"
                disabled={!projectDir}
                onClick={async () => {
                  const added = await onAttachDocs();
                  if (added.length) setDocs((d) => [...new Set([...d, ...added])]);
                }}
              >
                📎 แนบ docs → docs/
              </button>
              {docs.map((d) => <span key={d} className="chip" title={d}>{d}</span>)}
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
            <div className="agent-list scroll">
              {pipelines.length === 0 && (
                <div className="muted small">ยังไม่มี pipeline — กด "+ สร้าง" เพื่อวาดกราฟ agent</div>
              )}
              {pipelines.map((p) => (
                <div key={p.id} className="agent-row">
                  <div className="agent-row-meta" style={{ minWidth: 90 }}>
                    <b>{p.name}</b>
                    <span className="muted small">{p.graph ? "graph" : "list"}</span>
                  </div>
                  <span className="muted small pl-row-sum">{summary(p)}</span>
                  <button className="mini" onClick={() => { setRunTarget(p); setTask(""); setDocs([]); }}>▶ รัน</button>
                  <button className="mini" onClick={() => setDraft({ ...p, graph: p.graph ?? { nodes: [], edges: [] } })}>แก้</button>
                  <button className="mini danger" onClick={() => remove(p.id)}>ลบ</button>
                </div>
              ))}
            </div>

            {history.length > 0 && (
              <div className="wf-history">
                <button className="wf-hist-head" onClick={() => setHistOpen((o) => !o)}>
                  <span>ประวัติการรัน · {history.length}</span>
                  <span className="op-caret">{histOpen ? "▾" : "▸"}</span>
                </button>
                {histOpen && (
                  <>
                    {history.map((h) => (
                      <div key={h.id} className="wf-hist-row">
                        <div className="wf-hist-line" onClick={() => setOpenLog((x) => (x === h.id ? null : h.id))}>
                          <span className={`wf-hist-stat ${h.status}`}>{h.status === "done" ? "✓" : "✗"}</span>
                          <b>{h.name}</b>
                          <span className="muted small">${h.cost.toFixed(4)}</span>
                          <span className="muted small">{new Date(h.finishedAt).toLocaleString()}</span>
                        </div>
                        {openLog === h.id && (
                          <div className="wf-hist-log">
                            {h.log.map((l, i) => <div key={i} className="wf-line">{l}</div>)}
                          </div>
                        )}
                      </div>
                    ))}
                    {onClearHistory && (
                      <button className="mini danger" onClick={onClearHistory}>ล้างประวัติ</button>
                    )}
                  </>
                )}
              </div>
            )}

            <div className="modal-foot">
              <button
                className="mini primary"
                onClick={() => setDraft({ id: uid(), name: "", graph: { nodes: [], edges: [] } })}
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

// ===== graph editor (react-flow) =====
function PipelineEditor(props: {
  draft: PipelinePreset;
  agents: Agent[];
  label: (id: string) => { name: string; role: string };
  onSubmit: (p: PipelinePreset) => void;
  onCancel: () => void;
}) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}

function EditorInner({
  draft,
  agents,
  label,
  onSubmit,
  onCancel,
}: {
  draft: PipelinePreset;
  agents: Agent[];
  label: (id: string) => { name: string; role: string };
  onSubmit: (p: PipelinePreset) => void;
  onCancel: () => void;
}) {
  const accentOf = (id: string) => agents.find((a) => a.id === id)?.accent ?? "#94a3b8";
  const toRfNode = (g: { id: string; agent: string; review?: boolean; x: number; y: number }): Node => ({
    id: g.id,
    type: "agent",
    position: { x: g.x, y: g.y },
    data: { agent: g.agent, review: g.review, name: label(g.agent).name, role: label(g.agent).role, accent: accentOf(g.agent) },
  });

  const initNodes: Node[] = (draft.graph?.nodes ?? []).map(toRfNode);
  const initEdges: Edge[] = (draft.graph?.edges ?? []).map((e) => ({ id: e.id, source: e.source, target: e.target, ...EDGE_OPTS }));

  const [name, setName] = useState(draft.name);
  const [nodes, setNodes, onNodesChange] = useNodesState(initNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initEdges);
  const [error, setError] = useState<string | null>(null);
  const [palQ, setPalQ] = useState("");

  const pq = palQ.trim().toLowerCase();
  const palAgents = pq
    ? agents.filter((a) => a.name.toLowerCase().includes(pq) || a.role.toLowerCase().includes(pq))
    : agents;
  const rf = useReactFlow();
  const nodeTypes = useMemo(() => ({ agent: AgentNode }), []);

  function onConnect(c: Connection) {
    setEdges((es) => addEdge({ ...c, ...EDGE_OPTS }, es));
  }
  function addNode(agent: string, pos: { x: number; y: number }) {
    const a = agents.find((x) => x.id === agent);
    setNodes((ns) => [
      ...ns,
      {
        id: uid("g"),
        type: "agent",
        position: pos,
        data: { agent, review: false, name: a?.name ?? agent, role: a?.role ?? "", accent: a?.accent ?? "#94a3b8" },
      },
    ]);
  }
  // click palette = เพิ่มแบบ cascade (กัน WebKit/Tauri block HTML5 drag)
  function addNodeCascade(agent: string) {
    setNodes((ns) => {
      const i = ns.length;
      const a = agents.find((x) => x.id === agent);
      return [
        ...ns,
        {
          id: uid("g"),
          type: "agent",
          position: { x: 40 + (i % 4) * 190, y: 30 + Math.floor(i / 4) * 130 },
          data: { agent, review: false, name: a?.name ?? agent, role: a?.role ?? "", accent: a?.accent ?? "#94a3b8" },
        },
      ];
    });
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const agent = e.dataTransfer.getData("application/agent");
    if (!agent) return;
    addNode(agent, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }

  function save() {
    const graph: PipelineGraph = {
      nodes: nodes.map((n) => {
        const d = n.data as AgentData;
        return { id: n.id, agent: d.agent, review: !!d.review, x: Math.round(n.position.x), y: Math.round(n.position.y) };
      }),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    };
    try {
      graphToWorkflow(name || "pipeline", graph, label); // validate
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      return;
    }
    onSubmit({ id: draft.id, name: name || "pipeline", graph });
  }

  const valid = !!name.trim() && nodes.length > 0;

  return (
    <div className="agent-form">
      <label className="full">
        ชื่อ pipeline
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="pl-palette">
        <div className="pl-palette-head">
          <span>คลิกเพิ่ม agent:</span>
          {agents.length > 8 && (
            <input
              className="pl-pal-search"
              placeholder="ค้นหา agent…"
              value={palQ}
              onChange={(e) => setPalQ(e.target.value)}
            />
          )}
          <span className="muted small">{palAgents.length}/{agents.length}</span>
        </div>
        <div className="pl-palette-chips">
          {palAgents.map((a) => (
            <button
              key={a.id}
              className="handoff-btn"
              draggable
              style={{ borderColor: `${a.accent}66`, color: a.accent }}
              onClick={() => addNodeCascade(a.id)}
              onDragStart={(e) => e.dataTransfer.setData("application/agent", a.id)}
              title={`คลิก/ลาก ${a.name} (${a.role}) ลง canvas`}
            >
              + {a.name}
            </button>
          ))}
          {palAgents.length === 0 && <span className="muted small">ไม่พบ agent</span>}
        </div>
      </div>
      <div className="muted small">
        คลิกปุ่ม agent = เพิ่ม node · ลากจากจุดขวาของ node ไปจุดซ้ายอีก node = ต่อเส้น (แตก 2 เส้น = ขนาน) · เอา <b>🛡 reviewer/tester (Darius, Eve)</b> มาคั่น = gate ตรวจ/เทสงานตัวก่อนหน้า (ไม่ผ่าน→ตีกลับ ≤3) · ลบ: คลิก node แล้วกด Backspace
      </div>

      <div className="pl-canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          deleteKeyCode={["Backspace", "Delete"]}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>

      {error && <div className="pl-error">⚠ {error}</div>}

      <div className="form-foot sticky-foot">
        <button className="mini" onClick={onCancel}>ยกเลิก</button>
        <button className="mini primary" onClick={save} disabled={!valid}>💾 บันทึก</button>
      </div>
    </div>
  );
}
