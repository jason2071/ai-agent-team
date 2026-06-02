import type { Agent } from "../agents";
import { Avatar } from "./Avatar";

interface Message {
  role: "user" | "assistant" | "system";
  text: string;
}

// ตำแหน่งกระจายในห้อง (left%, top%, scale) — depth ด้วย scale+top
const SLOTS = [
  { l: 30, t: 30, s: 0.92 },
  { l: 52, t: 22, s: 0.86 },
  { l: 70, t: 30, s: 0.92 },
  { l: 20, t: 52, s: 1.0 },
  { l: 44, t: 56, s: 1.05 },
  { l: 66, t: 54, s: 1.02 },
  { l: 84, t: 46, s: 0.96 },
  { l: 36, t: 74, s: 1.1 },
  { l: 58, t: 76, s: 1.12 },
  { l: 78, t: 70, s: 1.06 },
];

export function OfficeView({
  agents,
  busy,
  chats,
  activeId,
  onSelect,
  onManage,
}: {
  agents: Agent[];
  busy: Record<string, boolean>;
  chats: Record<string, Message[]>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onManage: () => void;
}) {
  const isBusy = (id: string) => !!busy[id];
  const runningCount = agents.filter((a) => isBusy(a.id)).length;

  // activity feed: ข้อความ assistant ล่าสุดข้ามทุก agent
  const feed: { name: string; accent: string; text: string }[] = [];
  for (const a of agents) {
    const list = chats[a.id] ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.role === "assistant" && m.text.trim()) {
        feed.push({ name: a.name, accent: a.accent, text: m.text.trim().slice(0, 90) });
        break;
      }
    }
  }

  return (
    <div className="office">
      {/* ฉากห้อง — bg = /assets/guild.png */}
      <div className="office-room">

        {agents.map((a, i) => {
          const slot = SLOTS[i % SLOTS.length];
          const running = isBusy(a.id);
          return (
            <button
              key={a.id}
              className={`desk ${a.id === activeId ? "sel" : ""}`}
              style={{ left: `${slot.l}%`, top: `${slot.t}%`, transform: `translate(-50%,-50%) scale(${slot.s})` }}
              onClick={() => onSelect(a.id)}
              title={`คุยกับ ${a.name}`}
            >
              <div className="desk-monitor" style={{ borderColor: `${a.accent}aa`, boxShadow: `0 0 12px ${a.accent}55` }}>
                <span className="scan" style={{ background: a.accent }} />
              </div>
              <div className="desk-char">
                <Avatar agent={a} size={40} active={running} />
              </div>
              <div className="desk-tag" style={{ borderColor: `${a.accent}55` }}>
                <span className={`stat-dot ${running ? "on" : ""}`} style={{ background: running ? a.accent : "#475569" }} />
                {a.name}
              </div>
            </button>
          );
        })}
      </div>

      {/* top bar */}
      <div className="office-top">
        <h1 className="brand">GUILD<span>นักผจญภัย</span></h1>
        <button className="office-toggle" onClick={onManage}>⚙ จัดการนักผจญภัย</button>
      </div>

      {/* panel: สถานะกิลด์ */}
      <div className="office-panel left">
        <div className="op-head">สมาชิกกิลด์ · {runningCount}/{agents.length} active</div>
        {agents.map((a) => (
          <div key={a.id} className="op-row" onClick={() => onSelect(a.id)}>
            <span className="dot-accent" style={{ background: a.accent }} />
            <span className="op-name">{a.name}</span>
            <span className={`op-stat ${isBusy(a.id) ? "run" : ""}`}>
              {isBusy(a.id) ? "RUNNING" : "IDLE"}
            </span>
          </div>
        ))}
      </div>

      {/* panel: activity feed */}
      <div className="office-panel right">
        <div className="op-head">GUILD ACTIVITY</div>
        {feed.length === 0 && <div className="op-empty">ยังไม่มีเควสต์ — คลิกนักผจญภัยเริ่มสั่งงาน</div>}
        {feed.slice(0, 7).map((f, i) => (
          <div key={i} className="feed-item">
            <b style={{ color: f.accent }}>{f.name}</b>
            <span>{f.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
