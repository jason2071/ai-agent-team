import type { Agent } from "../agents";

interface Message {
  role: "user" | "assistant" | "system";
  text: string;
}

// ยืนหน้า station ใน guild.png (left%, top%, scale) — หลบ panel ซ้าย/ขวา
// depth: top มาก = อยู่หน้า = scale ใหญ่. เรียงตาม AGENTS:
// Serena, Rex, Mia, Kelvin, Yuri, Eve, Darius
const SLOTS = [
  { l: 52, t: 76, s: 1.22 }, // Serena — waiting area (foreground)
  { l: 28, t: 67, s: 1.14 }, // Rex — lower left
  { l: 50, t: 27, s: 0.82 }, // Mia — quest board (back)
  { l: 50, t: 49, s: 1.0 },  // Kelvin — reception (center)
  { l: 19, t: 50, s: 0.98 }, // Yuri — item storage (left)
  { l: 80, t: 37, s: 0.9 },  // Eve — reward/payment (right)
  { l: 82, t: 56, s: 1.06 }, // Darius — rank board (right)
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
              className={`desk ${a.id === activeId ? "sel" : ""} ${running ? "running" : ""}`}
              style={{ left: `${slot.l}%`, top: `${slot.t}%`, transform: `translate(-50%,-50%) scale(${slot.s})`, ["--accent" as string]: a.accent }}
              onClick={() => onSelect(a.id)}
              title={`คุยกับ ${a.name}`}
            >
              <img className="guild-sprite" src={a.avatar} alt={a.name} draggable={false} />
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
