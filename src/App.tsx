import { useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import { AGENTS, type Agent } from "./agents";
import { Avatar } from "./components/Avatar";
import { ManageAgents } from "./components/ManageAgents";
import { OfficeView } from "./components/OfficeView";
import "./styles.css";

type StreamEvent =
  | { kind: "session"; agent_id: string; session_id: string }
  | { kind: "delta"; agent_id: string; text: string }
  | { kind: "system"; agent_id: string; text: string }
  | { kind: "usage"; agent_id: string; cost_usd: number; input_tokens: number; output_tokens: number }
  | { kind: "done"; agent_id: string }
  | { kind: "error"; agent_id: string; message: string };

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

interface Message {
  role: "user" | "assistant" | "system";
  text: string;
}

const LS_KEY = "ai-agent-team:v1";
const LS_AGENTS = "ai-agent-team:agents:v1";
const LS_SEEN = "ai-agent-team:seen-defaults:v1"; // default id ที่เคยโผล่แล้ว

// โหลด agents: ใช้ของ user (แก้/ลบไว้) + merge default "ตัวใหม่" ที่ยังไม่เคยเห็น
// (เพิ่ม default agent ใหม่แล้ว user เก่าเห็นด้วย แต่ไม่ฟื้นตัวที่ user ลบไปแล้ว)
function loadAgents(): Agent[] {
  let stored: Agent[] | null = null;
  try {
    const raw = localStorage.getItem(LS_AGENTS);
    if (raw) {
      const a = JSON.parse(raw);
      if (Array.isArray(a) && a.length) stored = a;
    }
  } catch {
    /* corrupt */
  }
  if (!stored) return AGENTS; // ครั้งแรก = default ครบ

  let seen: string[] = [];
  try {
    seen = JSON.parse(localStorage.getItem(LS_SEEN) || "[]");
  } catch {
    /* ข้าม */
  }
  const storedIds = new Set(stored.map((a) => a.id));
  // default ที่ยังไม่เคยเห็น + ยังไม่อยู่ใน stored = ของใหม่ -> merge เข้า
  const fresh = AGENTS.filter((a) => !seen.includes(a.id) && !storedIds.has(a.id));
  const merged = fresh.length ? [...stored, ...fresh] : stored;

  // เรียงตาม workflow order ของ default (Aria->Theo->Pixie->Vee->Gopher->Testy->Lint);
  // agent ที่ user สร้างเอง (ไม่ใช่ default) ต่อท้าย คงลำดับเดิม
  const order = new Map(AGENTS.map((a, i) => [a.id, i]));
  return merged
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const ox = order.has(x.a.id) ? order.get(x.a.id)! : 1000 + x.i;
      const oy = order.has(y.a.id) ? order.get(y.a.id)! : 1000 + y.i;
      return ox - oy;
    })
    .map((x) => x.a);
}

// บันทึก default id ที่เคยเห็นทั้งหมด (กัน default ที่ user ลบ ฟื้นกลับ)
function markSeenDefaults() {
  try {
    localStorage.setItem(LS_SEEN, JSON.stringify(AGENTS.map((a) => a.id)));
  } catch {
    /* ข้าม */
  }
}

// โหลด state ที่ persist ไว้ (chats/sessions/cwds) จาก localStorage
function loadPersisted(): {
  chats: Record<string, Message[]>;
  sessions: Record<string, string>;
  cwds: Record<string, string>;
} {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { chats: p.chats ?? {}, sessions: p.sessions ?? {}, cwds: p.cwds ?? {} };
    }
  } catch {
    /* corrupt -> เริ่มใหม่ */
  }
  return { chats: {}, sessions: {}, cwds: {} };
}

export default function App() {
  const persisted = useRef(loadPersisted()).current;
  const [agents, setAgents] = useState<Agent[]>(loadAgents);
  const [showManage, setShowManage] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [activeId, setActiveId] = useState<string>(loadAgents()[0].id);
  // เก็บประวัติแชท + session ต่อ agent (persist localStorage)
  const [chats, setChats] = useState<Record<string, Message[]>>(persisted.chats);
  const [sessions, setSessions] = useState<Record<string, string>>(persisted.sessions);
  const [input, setInput] = useState("");
  // busy แยกต่อ agent -> รันหลายตัวพร้อมกันได้ (fan-out)
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // target ที่เลือกไว้ส่งต่อ (multi-select)
  const [handoffSel, setHandoffSel] = useState<string[]>([]);
  // project folder ต่อ agent (ส่งเป็น cwd) + ไฟล์แนบสำหรับข้อความถัดไป
  const [cwds, setCwds] = useState<Record<string, string>>(persisted.cwds);
  const [attached, setAttached] = useState<
    { name: string; text: string; path?: string; isImage?: boolean }[]
  >([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // persist chats/sessions/cwds ทุกครั้งที่เปลี่ยน
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ chats, sessions, cwds }));
    } catch {
      /* quota เต็ม -> ข้าม */
    }
  }, [chats, sessions, cwds]);

  // persist agents
  useEffect(() => {
    try {
      localStorage.setItem(LS_AGENTS, JSON.stringify(agents));
    } catch {
      /* ข้าม */
    }
  }, [agents]);

  // ขอสิทธิ์ desktop notification + จด default ที่เห็นแล้ว ครั้งเดียวตอน mount
  useEffect(() => {
    markSeenDefaults();
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // active agent (ถ้าถูกลบ -> fallback ตัวแรก)
  const active: Agent = agents.find((a) => a.id === activeId) ?? agents[0];
  const messages = chats[active.id] ?? [];
  const isBusy = (id: string) => !!busy[id];

  // เด้ง notification เมื่อ agent ที่ "ไม่ได้เปิดดูอยู่" ทำงานเสร็จ
  function notifyDone(agentId: string, ok: boolean) {
    if (agentId === activeIdRef.current) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const ag = agents.find((a) => a.id === agentId);
    if (!ag) return;
    new Notification(`${ag.name} ${ok ? "ตอบเสร็จแล้ว" : "เจอ error"}`, {
      body: ag.role,
    });
  }

  // จัดการ event ที่ Rust ส่งกลับมาทาง Channel (เรียกต่อ 1 send)
  function handleEvent(ev: StreamEvent) {
    if (ev.kind === "session") {
      setSessions((s) => ({ ...s, [ev.agent_id]: ev.session_id }));
      return;
    }
    if (ev.kind === "delta") {
      setChats((c) => appendDelta(c, ev.agent_id, ev.text));
      return;
    }
    if (ev.kind === "system") {
      setChats((c) => ({
        ...c,
        [ev.agent_id]: [...(c[ev.agent_id] ?? []), { role: "system", text: ev.text }],
      }));
      return;
    }
    if (ev.kind === "usage") {
      const meta = `💰 $${ev.cost_usd.toFixed(4)} · ↑${fmtTok(ev.input_tokens)} ↓${fmtTok(ev.output_tokens)} tokens`;
      setChats((c) => ({
        ...c,
        [ev.agent_id]: [...(c[ev.agent_id] ?? []), { role: "system", text: meta }],
      }));
      return;
    }
    if (ev.kind === "done") {
      setBusy((b) => ({ ...b, [ev.agent_id]: false }));
      notifyDone(ev.agent_id, true);
      return;
    }
    if (ev.kind === "error") {
      setChats((c) => appendDelta(c, ev.agent_id, `\n[error] ${ev.message}`));
      setBusy((b) => ({ ...b, [ev.agent_id]: false }));
      notifyDone(ev.agent_id, false);
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // เปลี่ยน agent -> ล้าง target ที่เลือกค้างไว้ (กัน include ตัว active)
  useEffect(() => {
    setHandoffSel([]);
  }, [activeId]);

  // ถ้า active agent ถูกลบใน manage -> เด้งกลับตัวแรก
  useEffect(() => {
    if (!agents.some((a) => a.id === activeId)) {
      setActiveId(agents[0].id);
    }
  }, [agents, activeId]);

  // core: เริ่ม run 1 agent (ใช้ทั้ง send ปกติ + fan-out) — รัน parallel ได้เพราะ busy แยกต่อ agent
  // resume = session เดิม (multi-turn) หรือ null = session ใหม่ (handoff ส่ง null เพราะ inline transcript แล้ว)
  async function runFor(
    agent: Agent,
    prompt: string,
    shownText: string,
    cwd: string | null,
    resume: string | null
  ) {
    setBusy((b) => ({ ...b, [agent.id]: true }));
    setChats((c) => ({
      ...c,
      [agent.id]: [...(c[agent.id] ?? []), { role: "user", text: shownText }],
    }));
    try {
      // Channel: สร้างก่อน invoke -> ไม่มี race เรื่อง listener registration
      const onEvent = new Channel<StreamEvent>();
      onEvent.onmessage = handleEvent;
      await invoke("run_agent", {
        args: {
          agent_id: agent.id,
          persona: agent.persona,
          prompt,
          model: agent.model ?? null,
          resume,
          allowed_tools: agent.allowedTools ?? null,
          cwd,
          permission_mode: agent.permissionMode ?? null,
        },
        onEvent,
      });
    } catch (err) {
      setChats((c) => appendDelta(c, agent.id, `\n[invoke error] ${err}`));
      setBusy((b) => ({ ...b, [agent.id]: false }));
    }
  }

  function send() {
    const typed = input.trim();
    if ((!typed && attached.length === 0) || isBusy(activeId)) return;
    setInput("");

    // text files -> inline content; images -> อ้าง path ให้ agent เปิดด้วย Read tool (vision)
    const textBlock = attached
      .filter((f) => !f.isImage && f.text)
      .map((f) => `=== ${f.name} ===\n${f.text}`)
      .join("\n\n");
    const imgBlock = attached
      .filter((f) => f.isImage && f.path)
      .map((f) => `- ${f.path}`)
      .join("\n");
    let prompt = typed;
    if (textBlock) prompt = `[ไฟล์แนบ]\n${textBlock}\n\n[คำสั่ง]\n${prompt}`;
    if (imgBlock) prompt = `[รูปแนบ — เปิดดูด้วย Read tool ก่อน]\n${imgBlock}\n\n${prompt}`;
    const shownText =
      attached.length > 0
        ? `${typed}${typed ? "\n" : ""}📎 ${attached.map((f) => (f.isImage ? "🖼 " : "") + f.name).join(", ")}`
        : typed;
    setAttached([]);
    runFor(active, prompt, shownText, cwds[activeId] ?? null, sessions[activeId] ?? null);
  }

  // หยุด agent ที่กำลังรัน
  function stop(agentId: string) {
    invoke("cancel_agent", { agentId });
  }

  // ล้างแชท + reset session ของ agent ปัจจุบัน
  function resetChat() {
    if (isBusy(activeId)) stop(activeId);
    setChats((c) => ({ ...c, [activeId]: [] }));
    setSessions((s) => {
      const n = { ...s };
      delete n[activeId];
      return n;
    });
  }

  // fan-out: ส่ง thread ปัจจุบันให้ target ที่เลือกไว้ทุกตัว "พร้อมกัน" (แต่ละตัว session แยก)
  function handoffSend() {
    const thread = chats[activeId] ?? [];
    if (thread.length === 0 || handoffSel.length === 0) return;
    const transcript = thread
      .filter((m) => m.text.trim())
      .map((m) => `${m.role === "user" ? "ผู้ใช้" : active.name}: ${m.text.trim()}`)
      .join("\n\n");
    for (const tid of handoffSel) {
      if (isBusy(tid)) continue;
      const target = AGENTS.find((a) => a.id === tid)!;
      const prompt =
        `[ส่งต่อจาก ${active.name} (${active.role})]\n\n` +
        `บทสนทนาก่อนหน้า:\n${transcript}\n\n` +
        `---\n@${target.name} ช่วยรับงานต่อตามบทบาทของคุณ`;
      // handoff = session ใหม่ (resume null) เพราะ transcript inline ใน prompt แล้ว -> กัน context ซ้ำ
      runFor(target, prompt, `[รับช่วงงานจาก ${active.name}]`, cwds[tid] ?? null, null);
    }
    setHandoffSel([]);
  }

  function toggleHandoff(id: string) {
    setHandoffSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard ไม่พร้อม ข้าม */
    }
  }

  // เลือก project folder -> เก็บเป็น cwd ของ agent ปัจจุบัน
  async function pickFolder() {
    const dir = await open({
      directory: true,
      multiple: false,
      defaultPath: cwds[activeId],
    });
    if (typeof dir === "string") {
      setCwds((c) => ({ ...c, [activeId]: dir }));
    }
  }

  // แนบไฟล์: text -> อ่าน content inline; รูป -> เก็บ path ให้ agent เปิดด้วย Read tool
  async function attachFiles() {
    const sel = await open({ multiple: true });
    const paths = Array.isArray(sel) ? sel : sel ? [sel] : [];
    for (const p of paths) {
      const name = p.split("/").pop() ?? p;
      const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p);
      if (isImage) {
        setAttached((a) => [...a, { name, text: "", path: p, isImage: true }]);
        continue;
      }
      try {
        const text = await invoke<string>("read_file_text", { path: p });
        setAttached((a) => [...a, { name, text }]);
      } catch (err) {
        setAttached((a) => [...a, { name: `${name} [อ่านไม่ได้: ${err}]`, text: "" }]);
      }
    }
  }

  return (
    <div className="shell">
      <OfficeView
        agents={agents}
        busy={busy}
        chats={chats}
        activeId={chatOpen ? activeId : null}
        onSelect={(id) => {
          setActiveId(id);
          setChatOpen(true);
        }}
        onManage={() => setShowManage(true)}
      />

      {/* chat drawer — เปิดทับ office ตอนคลิกตัวละคร */}
      <div className={`chat-drawer ${chatOpen ? "open" : ""}`}>
      <main
        className="panel"
        style={{
          background: `radial-gradient(circle at 28% 0%, ${active.accent}26, #eef1f7 55%)`,
        }}
      >
        <header className="panel-head" style={{ borderColor: `${active.accent}33` }}>
          <button className="drawer-close" onClick={() => setChatOpen(false)} title="กลับไปออฟฟิศ">
            ←
          </button>
          <Avatar agent={active} size={36} />
          <div>
            <div className="panel-name" style={{ color: active.accent }}>{active.name}</div>
            <div className="panel-role">{active.role}</div>
          </div>
          {messages.length > 0 && (
            <div className="handoff">
              <button className="reset-btn" onClick={resetChat} title="ล้างแชท + reset session">
                🗑 ล้าง
              </button>
              <span className="handoff-label">ส่งต่อ →</span>
              {agents.filter((a) => a.id !== activeId).map((a) => {
                const sel = handoffSel.includes(a.id);
                return (
                  <button
                    key={a.id}
                    className="handoff-btn"
                    onClick={() => toggleHandoff(a.id)}
                    title={`เลือก ${a.name} รับช่วงงาน`}
                    style={
                      sel
                        ? { background: a.accent, borderColor: a.accent, color: "#0a0f1e" }
                        : { borderColor: `${a.accent}66`, color: a.accent }
                    }
                  >
                    {sel ? "✓ " : ""}
                    {a.name}
                    {isBusy(a.id) ? " ⏳" : ""}
                  </button>
                );
              })}
              <button
                className="handoff-go"
                onClick={handoffSend}
                disabled={handoffSel.length === 0}
              >
                ส่ง ({handoffSel.length})
              </button>
            </div>
          )}
        </header>

        <div className="messages" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="empty">เริ่มสั่งงาน {active.name} ได้เลย</div>
          )}
          {messages.map((m, i) =>
            m.role === "system" ? (
              <div key={i} className="msg system">
                <span className="sys-line">{m.text}</span>
              </div>
            ) : (
              <div key={i} className={`msg ${m.role}`}>
                {m.role === "assistant" ? (
                  <div className="bubble md" style={{ borderColor: `${active.accent}55` }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                      {m.text}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <pre>{m.text}</pre>
                )}
                {m.text.trim() && (
                  <button className="copy-btn" onClick={() => copyText(m.text)} title="คัดลอก">
                    ⧉
                  </button>
                )}
              </div>
            )
          )}
          {isBusy(activeId) && (
            <div className="msg assistant">
              <div className="bubble thinking" style={{ borderColor: `${active.accent}55` }}>
                <span className="dot" /> <span className="dot" /> <span className="dot" />
              </div>
            </div>
          )}
        </div>

        <div className="composer">
          <div className="composer-tools">
            <button className="tool-btn" onClick={pickFolder} title="เลือก project folder (cwd)">
              📁 {cwds[activeId] ? cwds[activeId].split("/").pop() : "เลือก folder"}
            </button>
            {cwds[activeId] && (
              <button
                className="tool-x"
                onClick={() => setCwds((c) => { const n = { ...c }; delete n[activeId]; return n; })}
                title="ล้าง folder"
              >
                ✕
              </button>
            )}
            <button className="tool-btn" onClick={attachFiles} title="แนบไฟล์">
              📎 แนบไฟล์
            </button>
            {attached.map((f, i) => (
              <span key={i} className="chip" title={f.name}>
                {f.name}
                <button
                  className="chip-x"
                  onClick={() => setAttached((a) => a.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <div className="composer-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={`สั่งงาน ${active.name}... (Enter ส่ง, Shift+Enter ขึ้นบรรทัด)`}
            />
            {isBusy(activeId) ? (
              <button
                onClick={() => stop(activeId)}
                className="stop-btn"
                aria-label="หยุด"
                title="หยุด agent"
              >
                ◼ หยุด
              </button>
            ) : (
              <button onClick={send} aria-label="ส่ง" style={{ background: active.accent }}>
                ส่ง
              </button>
            )}
          </div>
        </div>
      </main>
      </div>

      {showManage && (
        <ManageAgents
          agents={agents}
          onSave={setAgents}
          onClose={() => setShowManage(false)}
          onReset={() => setAgents(AGENTS)}
        />
      )}
    </div>
  );
}

// ต่อ text เข้า message ตัวสุดท้าย (ตัว assistant ที่กำลัง stream)
function appendDelta(
  chats: Record<string, Message[]>,
  agentId: string,
  text: string
): Record<string, Message[]> {
  const list = [...(chats[agentId] ?? [])];
  const last = list[list.length - 1];
  if (last && last.role === "assistant") {
    list[list.length - 1] = { ...last, text: last.text + text };
  } else {
    list.push({ role: "assistant", text });
  }
  return { ...chats, [agentId]: list };
}
