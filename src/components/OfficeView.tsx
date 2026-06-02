import { useEffect, useRef, useState } from "react";
import type { ReactNode, UIEvent } from "react";
import type { Agent } from "../agents";

// scroll container + custom themed scrollbar (WKWebView ไม่ honor native scrollbar styling)
function OpBody({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ h: 0, top: 0, show: false });

  const recalc = () => {
    const el = ref.current;
    if (!el) return;
    const { scrollHeight: sh, clientHeight: ch, scrollTop: st } = el;
    if (sh <= ch + 2) {
      setThumb((t) => (t.show ? { ...t, show: false } : t));
      return;
    }
    const trackH = ch - 12; // เว้นขอบบน/ล่าง
    const h = Math.max(28, (ch / sh) * trackH);
    const offset = (st / (sh - ch)) * (trackH - h);
    setThumb({ h, top: st + 6 + offset, show: true });
  };

  useEffect(() => {
    recalc();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(recalc);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  return (
    <div className="op-body" ref={ref} onScroll={(_e: UIEvent<HTMLDivElement>) => recalc()}>
      {children}
      {thumb.show && (
        <div className="op-scroll-thumb" style={{ height: thumb.h, top: thumb.top }} />
      )}
    </div>
  );
}

const LS_PANELS = "ai-agent-team:panels:v1";
function loadPanels(): { left: boolean; right: boolean } {
  try {
    const r = localStorage.getItem(LS_PANELS);
    if (r) { const p = JSON.parse(r); return { left: !!p.left, right: !!p.right }; }
  } catch {
    /* ข้าม */
  }
  return { left: false, right: false };
}

interface Message {
  role: "user" | "assistant" | "system";
  text: string;
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

// ยืนหน้า station ใน guild.png (left%, top%, scale) — หลบ panel ซ้าย/ขวา
// depth: top มาก = อยู่หน้า = scale ใหญ่. ต้องมี slot ≥ จำนวน agent (กันทับ)
// ลำดับ AGENTS: Serena, Rex, Mia, Kelvin, Yuri, Finn, Eve, Darius
const SLOTS = [
  { l: 50, t: 27, s: 0.82 }, // quest board (back center)
  { l: 19, t: 50, s: 0.98 }, // item storage (mid left)
  { l: 80, t: 37, s: 0.9 },  // reward (upper right)
  { l: 50, t: 49, s: 1.0 },  // reception (center)
  { l: 82, t: 58, s: 1.06 }, // rank board (mid right)
  { l: 30, t: 68, s: 1.14 }, // lower left
  { l: 50, t: 78, s: 1.22 }, // waiting area (front center)
  { l: 72, t: 76, s: 1.18 }, // lower right
];

export function OfficeView({
  agents,
  busy,
  chats,
  activeId,
  onSelect,
  onManage,
  onPipeline,
  totals,
}: {
  agents: Agent[];
  busy: Record<string, boolean>;
  chats: Record<string, Message[]>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onManage: () => void;
  onPipeline: () => void;
  totals?: { cost: number; in: number; out: number };
}) {
  const isBusy = (id: string) => !!busy[id];
  const runningCount = agents.filter((a) => isBusy(a.id)).length;
  // พับ panel เก็บได้ — กันบังตัวละคร (persist localStorage)
  const [collapsed, setCollapsed] = useState<{ left: boolean; right: boolean }>(loadPanels);
  useEffect(() => {
    try { localStorage.setItem(LS_PANELS, JSON.stringify(collapsed)); } catch { /* ข้าม */ }
  }, [collapsed]);

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
      {/* ฉากห้อง — bg = /assets/bg/guild.png */}
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
        <div className="office-actions">
          {totals && totals.cost > 0 && (
            <span className="cost-chip" title={`รวมทั้ง session · ↑${fmtTok(totals.in)} ↓${fmtTok(totals.out)} tokens`}>
              💰 ${totals.cost.toFixed(4)}
            </span>
          )}
          <button className="office-toggle" onClick={onPipeline}>🧭 Pipeline</button>
          <button className="office-toggle" onClick={onManage}>⚙ จัดการนักผจญภัย</button>
        </div>
      </div>

      {/* panel: สถานะกิลด์ */}
      <div className={`office-panel left ${collapsed.left ? "collapsed" : ""}`}>
        <button className="op-head" onClick={() => setCollapsed((c) => ({ ...c, left: !c.left }))}>
          <span>สมาชิกกิลด์ · {runningCount}/{agents.length} active</span>
          <span className="op-caret">{collapsed.left ? "▸" : "▾"}</span>
        </button>
        {!collapsed.left && (
          <OpBody>
            {agents.map((a) => (
              <div key={a.id} className="op-row" onClick={() => onSelect(a.id)}>
                <span className="dot-accent" style={{ background: a.accent }} />
                <span className="op-name">{a.name}</span>
                <span className={`op-stat ${isBusy(a.id) ? "run" : ""}`}>
                  {isBusy(a.id) ? "RUNNING" : "IDLE"}
                </span>
              </div>
            ))}
          </OpBody>
        )}
      </div>

      {/* panel: activity feed */}
      <div className={`office-panel right ${collapsed.right ? "collapsed" : ""}`}>
        <button className="op-head" onClick={() => setCollapsed((c) => ({ ...c, right: !c.right }))}>
          <span>GUILD ACTIVITY</span>
          <span className="op-caret">{collapsed.right ? "▸" : "▾"}</span>
        </button>
        {!collapsed.right && (
          <OpBody>
            {feed.length === 0 && <div className="op-empty">ยังไม่มีเควสต์ — คลิกนักผจญภัยเริ่มสั่งงาน</div>}
            {feed.slice(0, 7).map((f, i) => (
              <div key={i} className="feed-item">
                <b style={{ color: f.accent }}>{f.name}</b>
                <span>{f.text}</span>
              </div>
            ))}
          </OpBody>
        )}
      </div>
    </div>
  );
}
