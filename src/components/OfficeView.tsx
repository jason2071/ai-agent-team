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

// ขอบเขตที่ตัวละครเดินเตร่ได้ (เป็น % ของห้อง) — กันออกนอกฉาก/ใต้ panel มากเกินไป
const ROOM = { lMin: 13, lMax: 87, tMin: 26, tMax: 80 };
// depth: ยิ่ง top มาก (อยู่หน้า) ยิ่ง scale ใหญ่ — แทน s ตายตัวเดิม
function scaleForTop(t: number): number {
  const k = (t - ROOM.tMin) / (ROOM.tMax - ROOM.tMin);
  return 0.82 + Math.min(1, Math.max(0, k)) * (1.22 - 0.82);
}

// ตำแหน่ง/สถานะการเดินของแต่ละ agent
interface Pos { l: number; t: number; flip: boolean; walking: boolean; ms: number; }

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

  // ── ให้ตัวละคร "เดินไปเดินมา" ตอนว่าง ───────────────────────────
  // เก็บตำแหน่งปัจจุบันต่อ agent; เริ่มจาก SLOTS เดิม แล้วสุ่มเป้าหมายใหม่เรื่อย ๆ
  const [pos, setPos] = useState<Record<string, Pos>>(() => {
    const o: Record<string, Pos> = {};
    agents.forEach((a, i) => {
      const s = SLOTS[i % SLOTS.length];
      o[a.id] = { l: s.l, t: s.t, flip: false, walking: false, ms: 0 };
    });
    return o;
  });
  const hoverRef = useRef<string | null>(null);

  // sync เมื่อ agent ถูกเพิ่ม/ลบ — ให้ตัวใหม่มีตำแหน่งเริ่ม, ตัดตัวที่หายไป
  useEffect(() => {
    setPos((prev) => {
      let changed = false;
      const next = { ...prev };
      agents.forEach((a, i) => {
        if (!next[a.id]) {
          const s = SLOTS[i % SLOTS.length];
          next[a.id] = { l: s.l, t: s.t, flip: false, walking: false, ms: 0 };
          changed = true;
        }
      });
      for (const k of Object.keys(next)) {
        if (!agents.some((a) => a.id === k)) { delete next[k]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [agents]);

  // ลูปสุ่มเดิน: ทุก ~1.5s ตัวที่ว่าง (ไม่ busy / ไม่ถูก hover) มีโอกาสเลือกจุดใหม่
  // ระยะเวลา transition คำนวณจากระยะทาง → ความเร็วเดินคงที่; flip หันตามทิศ
  useEffect(() => {
    const id = setInterval(() => {
      setPos((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const a of agents) {
          if (isBusy(a.id) || hoverRef.current === a.id) continue;
          const cur = prev[a.id];
          if (!cur || cur.walking) continue;     // กำลังเดินอยู่ก็ปล่อยให้ถึงก่อน
          if (Math.random() > 0.45) continue;    // ไม่ได้ขยับทุกครั้ง — ดูเป็นธรรมชาติ
          const nl = ROOM.lMin + Math.random() * (ROOM.lMax - ROOM.lMin);
          const nt = ROOM.tMin + Math.random() * (ROOM.tMax - ROOM.tMin);
          const dist = Math.hypot(nl - cur.l, nt - cur.t);
          const ms = Math.round(Math.max(1000, dist * 170)); // ~ความเร็วเดิน
          next[a.id] = { l: nl, t: nt, flip: nl < cur.l, walking: true, ms };
          changed = true;
        }
        return changed ? next : prev;
      });
    }, 1500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, busy]);
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
          const p = pos[a.id] ?? { l: slot.l, t: slot.t, flip: false, walking: false, ms: 0 };
          const sc = scaleForTop(p.t);
          // ตอน busy ให้หยุดทำงานกับที่ (bob); ตอนว่างเดินไปมา (walk)
          const walking = p.walking && !running;
          return (
            <button
              key={a.id}
              className={`desk ${a.id === activeId ? "sel" : ""} ${running ? "running" : ""} ${walking ? "walking" : ""}`}
              style={{
                left: `${p.l}%`,
                top: `${p.t}%`,
                transform: `translate(-50%,-50%) scale(${sc})`,
                transition: `left ${p.ms}ms linear, top ${p.ms}ms linear, transform ${Math.max(p.ms, 260)}ms linear, filter .15s`,
                ["--accent" as string]: a.accent,
              }}
              onTransitionEnd={() =>
                setPos((prev) => (prev[a.id]?.walking ? { ...prev, [a.id]: { ...prev[a.id], walking: false } } : prev))
              }
              onMouseEnter={() => { hoverRef.current = a.id; }}
              onMouseLeave={() => { if (hoverRef.current === a.id) hoverRef.current = null; }}
              onClick={() => onSelect(a.id)}
              title={`คุยกับ ${a.name}`}
            >
              <span className="sprite-flip" style={{ transform: p.flip ? "scaleX(-1)" : "none" }}>
                <img className="guild-sprite" src={a.avatar} alt={a.name} draggable={false} />
              </span>
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
