import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import { AGENTS, type Agent } from "./agents";
import { Avatar } from "./components/Avatar";
import { ManageAgents } from "./components/ManageAgents";
import { OfficeView } from "./components/OfficeView";
// lazy: react-flow หนัก (~200KB) โหลดเฉพาะตอนเปิด Pipeline -> bundle แรกเล็กลง
const PipelineBuilder = lazy(() =>
  import("./components/PipelineBuilder").then((m) => ({ default: m.PipelineBuilder })),
);
import {
  FEATURE_WF,
  parseVerdict,
  buildWorkflow,
  graphToWorkflow,
  type Workflow,
  type WFRun,
  type WFHistory,
  type PipelinePreset,
  type PipelineGraph,
} from "./workflow";
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
const LS_PIPELINES = "ai-agent-team:pipelines:v1";
const LS_WF_HISTORY = "ai-agent-team:wf-history:v1"; // ประวัติ workflow run

type Totals = { cost: number; in: number; out: number };

function loadTotals(): Totals {
  try {
    const r = localStorage.getItem(LS_KEY);
    if (r) {
      const p = JSON.parse(r);
      if (p.totals) return { cost: +p.totals.cost || 0, in: +p.totals.in || 0, out: +p.totals.out || 0 };
    }
  } catch {
    /* ข้าม */
  }
  return { cost: 0, in: 0, out: 0 };
}

function loadWfHistory(): WFHistory[] {
  try {
    const r = localStorage.getItem(LS_WF_HISTORY);
    if (r) return JSON.parse(r);
  } catch {
    /* ข้าม */
  }
  return [];
}

function loadPipelines(): PipelinePreset[] {
  try {
    const raw = localStorage.getItem(LS_PIPELINES);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p;
    }
  } catch {
    /* corrupt -> เริ่มใหม่ */
  }
  return [];
}

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

  // เรียงตาม workflow order ของ default (Serena->Rex->Mia->Kelvin->Yuri->Eve->Darius);
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
  projectDir: string | null;
  useGitBranch: boolean;
} {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        chats: p.chats ?? {},
        sessions: p.sessions ?? {},
        cwds: p.cwds ?? {},
        projectDir: p.projectDir ?? null,
        useGitBranch: p.useGitBranch ?? false,
      };
    }
  } catch {
    /* corrupt -> เริ่มใหม่ */
  }
  return { chats: {}, sessions: {}, cwds: {}, projectDir: null, useGitBranch: false };
}

// ดึงตัวเลือกจากคำตอบ agent เพื่อทำปุ่ม quick-reply
// เงื่อนไข: ต้องดูเป็นคำถามให้เลือก + มีรายการ 2-6 ข้อ (เลข/ตัวอักษร นำหน้า)
function parseChoices(text: string): string[] {
  if (!/[?？]|เลือก|อันไหน|แบบไหน|ข้อไหน|ตัวเลือก|หรือไม่|จะเอา/.test(text)) return [];
  const opts: string[] = [];
  for (const line of text.split("\n")) {
    // "1. ..." / "2) ..." / "A) ..." / "- ..." (ขึ้นต้นรายการ) ตามด้วยข้อความสั้น
    const m = line.match(/^\s*(?:\d{1,2}|[A-Za-z])[.)]\s+(.{1,80}?)\s*$/);
    if (m) {
      // ตัด markdown bold/`code` ออกจาก label
      opts.push(m[1].replace(/[*`_]/g, "").trim());
    }
  }
  return opts.length >= 2 && opts.length <= 6 ? opts : [];
}

export default function App() {
  const persisted = useRef(loadPersisted()).current;
  const [agents, setAgents] = useState<Agent[]>(loadAgents);
  const [showManage, setShowManage] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);
  const [pipelines, setPipelines] = useState<PipelinePreset[]>(loadPipelines);
  const [chatOpen, setChatOpen] = useState(false);
  const [activeId, setActiveId] = useState<string>(loadAgents()[0].id);
  // เก็บประวัติแชท + session ต่อ agent (persist localStorage)
  const [chats, setChats] = useState<Record<string, Message[]>>(persisted.chats);
  const [sessions, setSessions] = useState<Record<string, string>>(persisted.sessions);
  const [input, setInput] = useState("");
  // busy แยกต่อ agent -> รันหลายตัวพร้อมกันได้ (fan-out)
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // tool ล่าสุดที่ agent ใช้ (transient) — โชว์สดข้าง thinking ไม่เก็บเป็น message ถาวร
  const [toolStatus, setToolStatus] = useState<Record<string, string>>({});
  // target ที่เลือกไว้ส่งต่อ (multi-select)
  const [handoffSel, setHandoffSel] = useState<string[]>([]);
  // sequential handoff: ส่งต่อแบบลำดับ (รอเสร็จทีละตัว) แทน parallel
  const [seqMode, setSeqMode] = useState(false);
  // chain ที่กำลังรัน (sequential) — null = ไม่มี
  const [chain, setChain] = useState<{
    steps: string[];
    idx: number;
    task: string;
    cwd: string | null;
  } | null>(null);
  // workflow engine (v2) — ref = source of truth (กัน stale), wf = สำหรับ render banner
  const wfRef = useRef<WFRun | null>(null);
  const [wf, setWf] = useState<WFRun | null>(null);
  const syncWf = () => setWf(wfRef.current ? { ...wfRef.current } : null);
  const [wfLogOpen, setWfLogOpen] = useState(false);
  // ประวัติ workflow run ที่จบ/halt แล้ว
  const [wfHistory, setWfHistory] = useState<WFHistory[]>(loadWfHistory);
  // cost สะสมทั้ง session (ref = กัน stale ใน handleEvent, state = render)
  const totalsRef = useRef<Totals>(loadTotals());
  const [totals, setTotals] = useState<Totals>(totalsRef.current);
  // global project folder — agent ทุกตัวใช้ร่วมกันเป็น default (ทำงาน project เดียวกัน)
  const [projectDir, setProjectDir] = useState<string | null>(persisted.projectDir);
  // override per-agent — ถ้าตั้งใจให้ตัวนี้ทำงานคนละ folder (ไม่มี = ใช้ projectDir)
  const [cwds, setCwds] = useState<Record<string, string>>(persisted.cwds);
  // cwd จริงที่ส่งให้ agent: override ตัวเอง > global project > null
  const effectiveCwd = (id: string): string | null => cwds[id] ?? projectDir;
  // เปิด = ตอน pipeline เริ่ม จะแตก git branch ใหม่ใน projectDir แล้วทำงานบน branch นั้น
  const [useGitBranch, setUseGitBranch] = useState<boolean>(persisted.useGitBranch);
  const [attached, setAttached] = useState<
    { name: string; text: string; path?: string; isImage?: boolean }[]
  >([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // mirror chats ลง ref -> advanceChain อ่าน output ล่าสุดได้ (กัน stale closure ใน handleEvent)
  const chatsRef = useRef(chats);
  chatsRef.current = chats;

  // persist chats/sessions/cwds ทุกครั้งที่เปลี่ยน
  useEffect(() => {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({ chats, sessions, cwds, projectDir, totals, useGitBranch })
      );
    } catch {
      /* quota เต็ม -> ข้าม */
    }
  }, [chats, sessions, cwds, projectDir, totals, useGitBranch]);

  // persist ประวัติ workflow run
  useEffect(() => {
    try {
      localStorage.setItem(LS_WF_HISTORY, JSON.stringify(wfHistory));
    } catch {
      /* ข้าม */
    }
  }, [wfHistory]);

  // persist agents
  useEffect(() => {
    try {
      localStorage.setItem(LS_AGENTS, JSON.stringify(agents));
    } catch {
      /* ข้าม */
    }
  }, [agents]);

  // persist pipelines
  useEffect(() => {
    try {
      localStorage.setItem(LS_PIPELINES, JSON.stringify(pipelines));
    } catch {
      /* ข้าม */
    }
  }, [pipelines]);

  // ขอสิทธิ์ desktop notification + จด default ที่เห็นแล้ว ครั้งเดียวตอน mount
  useEffect(() => {
    markSeenDefaults();
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // ซ่อน splash หลัง mount + รอ bg (guild.png) โหลดเสร็จ กันขาวแวบ (fallback 2.5s)
  useEffect(() => {
    const el = document.getElementById("splash");
    if (!el) return;
    let done = false;
    const hide = () => {
      if (done) return;
      done = true;
      el.classList.add("hide");
      setTimeout(() => el.remove(), 450);
    };
    const img = new Image();
    img.onload = hide;
    img.onerror = hide;
    img.src = "/assets/bg/guild.png";
    const t = setTimeout(hide, 2500);
    return () => clearTimeout(t);
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

  function chainNotify(msg: string) {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Auto-chain", { body: msg });
    }
  }

  // output ล่าสุดของ agent (assistant message ตัวสุดท้าย) — อ่านจาก ref กัน stale
  function lastAssistantOf(agentId: string): string {
    const list = chatsRef.current[agentId] ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === "assistant" && list[i].text.trim()) return list[i].text.trim();
    }
    return "";
  }

  // sequential chain: agent เสร็จ -> ป้อน output ให้ตัวถัดไป (หรือจบ/หยุดถ้า error)
  function advanceChain(finishedId: string, ok: boolean) {
    setChain((ch) => {
      if (!ch || ch.steps[ch.idx] !== finishedId) return ch; // ไม่ใช่ step ของ chain นี้
      if (!ok) {
        chainNotify(`หยุดที่ขั้น ${ch.idx + 1}/${ch.steps.length} — เจอ error`);
        return null;
      }
      const next = ch.idx + 1;
      if (next >= ch.steps.length) {
        chainNotify("เสร็จครบทุกขั้น ✓");
        return null;
      }
      const target = agents.find((a) => a.id === ch.steps[next]);
      if (!target) return null; // agent ถูกลบกลางทาง
      const prev = agents.find((a) => a.id === finishedId);
      const out = lastAssistantOf(finishedId);
      const prompt =
        `[Auto-chain ขั้น ${next + 1}/${ch.steps.length}]\n` +
        `โจทย์ตั้งต้น:\n${ch.task}\n\n` +
        `ผลจาก ${prev?.name ?? finishedId}${prev ? ` (${prev.role})` : ""}:\n${out}\n\n` +
        `---\n@${target.name} ทำงานต่อตามบทบาทของคุณ`;
      setActiveId(target.id); // ตามดูตัวที่กำลังทำ
      runFor(target, prompt, `[รับช่วง · ขั้น ${next + 1}/${ch.steps.length}]`, ch.cwd, null);
      return { ...ch, idx: next };
    });
  }

  function stopChain() {
    if (chain) stop(chain.steps[chain.idx]);
    setChain(null);
  }

  // ===== Workflow engine (v2) =====
  // ชื่อ branch สำหรับ run: forgeline/<wfId>-YYYYMMDD-HHmmss
  function branchStamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
  }

  async function startWorkflow(
    def: Workflow,
    task: string,
    cwd: string | null,
    gitBranch?: boolean
  ) {
    if (wfRef.current?.status === "running") return;
    wfRef.current = {
      wf: def,
      task,
      cwd,
      results: {},
      retries: {},
      running: {},
      joinArrived: {},
      status: "running",
      log: [`▶ เริ่ม ${def.name}`],
      cost: 0,
      inTok: 0,
      outTok: 0,
      startedAt: Date.now(),
    };
    setWfLogOpen(false);
    syncWf();

    // เปิด feature + มี project dir → แตก git branch ก่อนเริ่มทำงาน
    if (gitBranch && cwd) {
      const run = wfRef.current;
      const branch = `forgeline/${def.id}-${branchStamp()}`;
      run.log.push(`⎇ กำลังแตก branch ${branch}…`);
      syncWf();
      try {
        await invoke("git_branch_start", { cwd, branch });
        run.gitBranch = branch;
        run.log.push(`⎇ branch: ${branch}`);
        syncWf();
      } catch (e) {
        run.status = "halted";
        run.log.push(`✗ แตก branch ไม่ได้: ${e}`);
        syncWf();
        archiveRun(run);
        chainNotify("Workflow หยุด — แตก git branch ไม่ได้");
        return;
      }
    }

    startWFNode(def.start);
  }

  // เก็บ run ที่จบ/halt ลงประวัติ (ล่าสุดอยู่บน, เก็บ 20)
  function archiveRun(run: WFRun) {
    if (run.status !== "done" && run.status !== "halted") return;
    // ถ้า run นี้แตก git branch ไว้ → auto-commit งานทั้งหมดบน branch (ครั้งเดียว)
    if (run.gitBranch && run.cwd && !run.committed) {
      run.committed = true;
      const msg = `forgeline(${run.wf.name}): ${run.task} [${run.status}]`;
      invoke<string>("git_commit_all", { cwd: run.cwd, message: msg })
        .then((hash) => {
          run.log.push(
            hash === "(no changes)"
              ? `⎇ ${run.gitBranch}: ไม่มีไฟล์เปลี่ยน (ไม่ commit)`
              : `⎇ commit ${hash} บน ${run.gitBranch}`
          );
          syncWf();
        })
        .catch((e) => {
          run.log.push(`⚠ commit ไม่สำเร็จ: ${e}`);
          syncWf();
        });
    }
    const entry: WFHistory = {
      id: `${run.wf.id}-${run.startedAt}`,
      name: run.wf.name,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      cost: run.cost,
      log: run.gitBranch ? [...run.log, `⎇ branch: ${run.gitBranch}`] : [...run.log],
    };
    setWfHistory((h) => [entry, ...h.filter((x) => x.id !== entry.id)].slice(0, 20));
  }

  function startWFNode(nodeId: string) {
    const run = wfRef.current;
    if (!run || run.status !== "running") return;
    const node = run.wf.nodes[nodeId];
    if (!node) return;

    if (node.kind === "fork") {
      run.log.push(`⑂ ${node.title}`);
      syncWf();
      for (const b of node.branches) startWFNode(b);
      return;
    }
    if (node.kind === "join") return; // trigger ผ่าน routeTo เมื่อครบ
    if (node.kind === "done") {
      run.status = "done";
      run.log.push(`✓ ${node.title}`);
      syncWf();
      archiveRun(run);
      chainNotify("Workflow เสร็จครบ ✓");
      return;
    }

    // task | gate
    const agent = agents.find((a) => a.id === node.agent);
    if (!agent) {
      run.status = "halted";
      run.log.push(`✗ ไม่พบ agent: ${node.agent}`);
      syncWf();
      return;
    }
    if (isBusy(agent.id)) {
      run.log.push(`⚠ ${agent.name} ยุ่งอยู่ — ${node.title} รอไม่ได้`);
      syncWf();
      return;
    }
    const prompt = node.build({ task: run.task, results: run.results });
    run.running[agent.id] = node.id;
    run.log.push(`▸ ${node.title}`);
    syncWf();
    setActiveId(agent.id); // ตามดูตัวที่กำลังทำ
    // node แรกโชว์โจทย์ที่ผู้ใช้พิมพ์ (ตัวถัด ๆ โชว์ label เพราะ prompt = ผลของ node ก่อน)
    const shown = nodeId === run.wf.start ? `🧭 ${run.task}` : `[WF: ${node.title}]`;
    runFor(agent, prompt, shown, run.cwd, null);
  }

  function routeWF(targetId: string) {
    const run = wfRef.current;
    if (!run) return;
    const t = run.wf.nodes[targetId];
    if (!t) return;
    if (t.kind === "join") {
      const n = (run.joinArrived[targetId] ?? 0) + 1;
      run.joinArrived[targetId] = n;
      if (n >= t.expected) {
        run.log.push(`⑃ ${t.title} ครบ`);
        syncWf();
        startWFNode(t.next);
      } else {
        syncWf(); // รอ branch อื่น
      }
      return;
    }
    startWFNode(targetId);
  }

  // agent ใน workflow ทำเสร็จ -> เดินกราฟต่อ (เรียกจาก done/error)
  function advanceWorkflow(agentId: string, ok: boolean) {
    const run = wfRef.current;
    if (!run || run.status !== "running") return;
    const nodeId = run.running[agentId];
    if (!nodeId) return; // agent นี้ไม่ได้อยู่ใน workflow
    delete run.running[agentId];
    const node = run.wf.nodes[nodeId];
    run.results[nodeId] = lastAssistantOf(agentId);

    if (!ok) {
      run.status = "halted";
      run.haltedAt = nodeId;
      run.log.push(`✗ ${"title" in node ? node.title : nodeId} error — หยุด workflow`);
      syncWf();
      archiveRun(run);
      chainNotify("Workflow หยุด — เจอ error");
      return;
    }

    if (node.kind === "task") {
      syncWf();
      routeWF(node.next);
    } else if (node.kind === "gate") {
      const v = parseVerdict(run.results[nodeId]);
      if (v === "PASS") {
        run.log.push(`✓ ${node.title}: PASS`);
        syncWf();
        routeWF(node.onPass);
      } else {
        // FAIL หรือ parse ไม่เจอ (ถือว่า FAIL กันปล่อยผ่าน)
        const cnt = (run.retries[nodeId] ?? 0) + 1;
        run.retries[nodeId] = cnt;
        if (cnt > node.maxRetry) {
          run.status = "halted";
          run.haltedAt = nodeId;
          run.log.push(`✗ ${node.title}: ไม่ผ่านครบ ${node.maxRetry} รอบ — หยุด`);
          syncWf();
          archiveRun(run);
          chainNotify(`Workflow หยุด: ${node.title} ไม่ผ่าน ${node.maxRetry} รอบ`);
        } else {
          run.log.push(`↩ ${node.title}: ${v ?? "ไม่พบ verdict"} — ตีกลับ (รอบ ${cnt}/${node.maxRetry})`);
          syncWf();
          startWFNode(node.onFail);
        }
      }
    }
  }

  function stopWorkflow() {
    const run = wfRef.current;
    if (!run) return;
    for (const aid of Object.keys(run.running)) stop(aid);
    run.status = "halted";
    run.haltedAt = Object.values(run.running)[0] ?? run.haltedAt;
    run.log.push("■ หยุดโดยผู้ใช้");
    syncWf();
    archiveRun(run);
  }

  // halt แล้ว -> ลองรันใหม่จากจุดที่ค้าง (gate -> ตีกลับ author, อื่น -> รัน node เดิมซ้ำ)
  function retryWorkflow() {
    const run = wfRef.current;
    if (!run || run.status !== "halted" || !run.haltedAt) return;
    const n = run.wf.nodes[run.haltedAt];
    if (!n) return;
    run.status = "running";
    run.log.push(`↻ ลองใหม่: ${"title" in n ? n.title : run.haltedAt}`);
    run.haltedAt = undefined;
    if (n.kind === "gate") {
      run.retries[n.id] = 0;
      syncWf();
      startWFNode(n.onFail);
    } else {
      syncWf();
      startWFNode(n.id);
    }
  }

  // รัน pipeline ที่ผู้ใช้สร้าง -> build Workflow ตอน runtime แล้วส่งเข้า engine
  function runPipeline(preset: PipelinePreset, task: string) {
    const label = (id: string) => {
      const a = agents.find((x) => x.id === id);
      return { name: a?.name ?? id, role: a?.role ?? "" };
    };
    const def = preset.graph
      ? graphToWorkflow(preset.name, preset.graph, label)
      : buildWorkflow(preset.name, preset.steps ?? [], label);
    setShowPipeline(false);
    startWorkflow(def, task, projectDir ?? effectiveCwd(activeId), useGitBranch);
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
      // tool progress (🔧 ...) -> โชว์สดบรรทัดเดียว ไม่ดันบทสนทนา (clear ตอน done/error)
      setToolStatus((t) => ({ ...t, [ev.agent_id]: ev.text }));
      return;
    }
    if (ev.kind === "usage") {
      const meta = `💰 $${ev.cost_usd.toFixed(4)} · ↑${fmtTok(ev.input_tokens)} ↓${fmtTok(ev.output_tokens)} tokens`;
      setChats((c) => ({
        ...c,
        [ev.agent_id]: [...(c[ev.agent_id] ?? []), { role: "system", text: meta }],
      }));
      // สะสมยอดรวม session
      totalsRef.current = {
        cost: totalsRef.current.cost + ev.cost_usd,
        in: totalsRef.current.in + ev.input_tokens,
        out: totalsRef.current.out + ev.output_tokens,
      };
      setTotals(totalsRef.current);
      // ถ้า agent นี้อยู่ใน workflow ที่รันอยู่ -> บวกเข้า run นั้น
      const run = wfRef.current;
      if (run && run.running[ev.agent_id]) {
        run.cost += ev.cost_usd;
        run.inTok += ev.input_tokens;
        run.outTok += ev.output_tokens;
        syncWf();
      }
      return;
    }
    if (ev.kind === "done") {
      setBusy((b) => ({ ...b, [ev.agent_id]: false }));
      setToolStatus((t) => { const n = { ...t }; delete n[ev.agent_id]; return n; });
      notifyDone(ev.agent_id, true);
      advanceChain(ev.agent_id, true);
      advanceWorkflow(ev.agent_id, true);
      return;
    }
    if (ev.kind === "error") {
      setChats((c) => appendDelta(c, ev.agent_id, `\n[error] ${ev.message}`));
      setBusy((b) => ({ ...b, [ev.agent_id]: false }));
      setToolStatus((t) => { const n = { ...t }; delete n[ev.agent_id]; return n; });
      notifyDone(ev.agent_id, false);
      advanceChain(ev.agent_id, false);
      advanceWorkflow(ev.agent_id, false);
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
          // บังคับชื่อ/บทบาทให้ตรงกับ UI — กัน claude ตั้งชื่อเอง(เช่น "Phenny")
          persona: `Your name is ${agent.name}, the ${agent.role}. Always introduce and refer to yourself as ${agent.name} — never use any other name.\n\n${agent.persona}`,
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
      // invoke throw เอง (Tauri ไม่พร้อม / spawn ไม่ได้) -> ไม่มี event flow
      // ต้องแจ้ง chain/workflow ว่า fail เอง ไม่งั้นค้าง "running"
      setChats((c) => appendDelta(c, agent.id, `\n[invoke error] ${err}`));
      setBusy((b) => ({ ...b, [agent.id]: false }));
      advanceChain(agent.id, false);
      advanceWorkflow(agent.id, false);
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
    runFor(active, prompt, shownText, effectiveCwd(activeId), sessions[activeId] ?? null);
  }

  // ตอบ quick-reply: ส่ง option ที่คลิกเป็นข้อความถัดไป (resume session เดิม)
  function sendQuick(text: string) {
    if (isBusy(activeId)) return;
    runFor(active, text, text, effectiveCwd(activeId), sessions[activeId] ?? null);
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

    // sequential: รันทีละตัวตามลำดับเลือก, ตัวถัดไปรับ output ตัวก่อน (ผ่าน advanceChain)
    if (seqMode) {
      const steps = handoffSel.filter((id) => !isBusy(id));
      if (steps.length === 0) return;
      const cwd = effectiveCwd(activeId);
      const first = AGENTS.find((a) => a.id === steps[0])!;
      const prompt =
        `[Auto-chain ขั้น 1/${steps.length}]\n` +
        `[ส่งต่อจาก ${active.name} (${active.role})]\n\n` +
        `บทสนทนาก่อนหน้า:\n${transcript}\n\n` +
        `---\n@${first.name} ทำงานต่อตามบทบาทของคุณ`;
      setChain({ steps, idx: 0, task: transcript, cwd });
      setActiveId(first.id);
      runFor(first, prompt, `[รับช่วงจาก ${active.name} · 1/${steps.length}]`, cwd, null);
      setHandoffSel([]);
      return;
    }

    // parallel (เดิม): ยิงทุกตัวพร้อมกัน
    for (const tid of handoffSel) {
      if (isBusy(tid)) continue;
      const target = AGENTS.find((a) => a.id === tid)!;
      const prompt =
        `[ส่งต่อจาก ${active.name} (${active.role})]\n\n` +
        `บทสนทนาก่อนหน้า:\n${transcript}\n\n` +
        `---\n@${target.name} ช่วยรับงานต่อตามบทบาทของคุณ`;
      // handoff = session ใหม่ (resume null) เพราะ transcript inline ใน prompt แล้ว -> กัน context ซ้ำ
      runFor(target, prompt, `[รับช่วงงานจาก ${active.name}]`, effectiveCwd(tid), null);
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

  // claude เก็บ session แยกตาม project dir -> resume ข้าม folder = "No conversation found"
  // เปลี่ยน cwd = ต้อง drop session ของ agent ที่ได้รับผลกระทบ แล้วเริ่มใหม่
  function dropSession(id: string, note: string) {
    if (!sessions[id]) return;
    setSessions((s) => {
      const n = { ...s };
      delete n[id];
      return n;
    });
    setChats((c) => ({
      ...c,
      [id]: [...(c[id] ?? []), { role: "system", text: note }],
    }));
  }

  // global project — agent ทุกตัว (ที่ไม่ override) ทำงาน folder นี้
  async function pickProject() {
    const dir = await open({ directory: true, multiple: false, defaultPath: projectDir ?? undefined });
    if (typeof dir !== "string" || dir === projectDir) return;
    setProjectDir(dir);
    // drop session ของทุกตัวที่ใช้ global (ไม่มี override) เพราะ cwd เปลี่ยน
    for (const a of agents) {
      if (!cwds[a.id]) dropSession(a.id, `📁 project → ${dir}\nเริ่ม session ใหม่ (resume ข้าม folder ไม่ได้)`);
    }
  }

  // แนบ docs -> เขียนลง {projectDir}/docs/ จริง ให้ทุก agent Read ได้ คืน relative path
  async function attachDocsToProject(): Promise<string[]> {
    if (!projectDir) return [];
    const sel = await open({ multiple: true });
    const paths = Array.isArray(sel) ? sel : sel ? [sel] : [];
    const rels: string[] = [];
    for (const p of paths) {
      const name = p.split("/").pop() ?? p;
      try {
        const text = await invoke<string>("read_file_text", { path: p });
        await invoke("write_file_text", { path: `${projectDir}/docs/${name}`, content: text });
        rels.push(`docs/${name}`);
      } catch {
        /* binary/อ่านไม่ได้ -> ข้าม */
      }
    }
    return rels;
  }

  // export graph ที่กำลังแก้ -> ไฟล์ .json (save dialog + เขียนผ่าน Rust)
  async function exportPipelineGraph(name: string, graph: PipelineGraph) {
    const slug = (name || "pipeline").trim().replace(/[^\w.-]+/g, "-").toLowerCase() || "pipeline";
    const path = await save({
      defaultPath: `${slug}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    const content = JSON.stringify(
      { type: "ai-agent-team.pipeline", version: 1, name, graph },
      null,
      2,
    );
    await invoke("write_file_text", { path, content });
  }

  // import graph จากไฟล์ .json -> คืน {name?, graph} ให้ editor โหลดลง canvas
  async function importPipelineGraph(): Promise<{ name?: string; graph: PipelineGraph } | null> {
    const sel = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    const path = Array.isArray(sel) ? sel[0] : sel;
    if (!path) return null;
    const text = await invoke<string>("read_file_text", { path });
    const data = JSON.parse(text);
    // รับทั้ง { graph: {...} } (ไฟล์ของเรา) หรือ raw PipelineGraph (มี nodes ตรง ๆ)
    const graph: PipelineGraph | undefined = data?.graph ?? (Array.isArray(data?.nodes) ? data : undefined);
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new Error("ไฟล์ไม่ใช่ pipeline graph ที่ถูกต้อง (ต้องมี nodes/edges)");
    }
    return { name: typeof data?.name === "string" ? data.name : undefined, graph };
  }

  // override เฉพาะ agent ปัจจุบัน (ตั้งใจแยก project)
  async function pickAgentFolder() {
    const dir = await open({
      directory: true,
      multiple: false,
      defaultPath: cwds[activeId] ?? projectDir ?? undefined,
    });
    if (typeof dir !== "string") return;
    const changed = dir !== effectiveCwd(activeId);
    setCwds((c) => ({ ...c, [activeId]: dir }));
    if (changed) dropSession(activeId, `📁 แยก folder → ${dir}\nเริ่ม session ใหม่`);
  }

  // ล้าง override -> กลับไปใช้ global project
  function clearAgentFolder() {
    if (!(activeId in cwds)) return;
    const changed = cwds[activeId] !== effectiveCwd(activeId) || cwds[activeId] !== projectDir;
    setCwds((c) => {
      const n = { ...c };
      delete n[activeId];
      return n;
    });
    if (changed) dropSession(activeId, `📁 กลับไปใช้ project รวม${projectDir ? ` → ${projectDir}` : ""}\nเริ่ม session ใหม่`);
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
        onPipeline={() => setShowPipeline(true)}
        totals={totals}
      />

      {/* chat drawer — เปิดทับกิลด์ตอนคลิกตัวละคร */}
      <div className={`chat-drawer ${chatOpen ? "open" : ""}`}>
      <main
        className="panel"
        style={{
          background: `radial-gradient(circle at 28% 0%, ${active.accent}26, #eef1f7 55%)`,
        }}
      >
        <header className="panel-head" style={{ borderColor: `${active.accent}33` }}>
          <button className="drawer-close" onClick={() => setChatOpen(false)} title="กลับไปกิลด์">
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
              <label className="seq-toggle" title="ส่งต่อแบบลำดับ — รอเสร็จทีละตัว แล้วป้อน output ให้ตัวถัดไป">
                <input
                  type="checkbox"
                  checked={seqMode}
                  onChange={(e) => setSeqMode(e.target.checked)}
                />
                ลำดับ
              </label>
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
                title={seqMode ? "เริ่ม chain ตามลำดับที่เลือก" : "ส่งพร้อมกันทุกตัว"}
              >
                {seqMode ? "▸ chain" : "ส่ง"} ({handoffSel.length})
              </button>
            </div>
          )}
        </header>

        {chain && (
          <div className="chain-banner">
            <span className="chain-flow">
              🔗{" "}
              {chain.steps
                .map((id, i) => {
                  const nm = agents.find((a) => a.id === id)?.name ?? id;
                  return i === chain.idx ? `[${nm}]` : nm;
                })
                .join(" → ")}
            </span>
            <span className="chain-step">
              กำลังทำ {agents.find((a) => a.id === chain.steps[chain.idx])?.name} ({chain.idx + 1}/
              {chain.steps.length})
            </span>
            <button className="chain-stop" onClick={stopChain}>
              หยุด
            </button>
          </div>
        )}

        {wf && (
          <div className={`wf-banner ${wf.status}`}>
            <div className="wf-head">
              <span className="wf-name">🧭 {wf.wf.name}</span>
              <span className="wf-status">
                {wf.status === "running" ? "กำลังรัน" : wf.status === "done" ? "เสร็จ ✓" : "หยุด"}
              </span>
              {wf.gitBranch && (
                <span className="wf-branch" title={`pipeline ทำงานบน branch นี้: ${wf.gitBranch}`}>
                  ⎇ {wf.gitBranch}
                </span>
              )}
              {wf.cost > 0 && (
                <span className="wf-cost">💰 ${wf.cost.toFixed(4)} · ↓{fmtTok(wf.outTok)}</span>
              )}
              {wf.status === "running" ? (
                <button className="chain-stop" onClick={stopWorkflow}>หยุด</button>
              ) : (
                <>
                  {wf.status === "halted" && wf.haltedAt && (
                    <button className="wf-retry" onClick={retryWorkflow}>↻ ลองรอบใหม่</button>
                  )}
                  <button className="chain-stop" onClick={() => { wfRef.current = null; setWf(null); }}>ปิด</button>
                </>
              )}
            </div>
            <div className={`wf-log ${wfLogOpen ? "full" : ""}`}>
              {(wfLogOpen ? wf.log : wf.log.slice(-4)).map((l, i) => (
                <div key={i} className="wf-line">{l}</div>
              ))}
            </div>
            {wf.log.length > 4 && (
              <button className="wf-log-toggle" onClick={() => setWfLogOpen((o) => !o)}>
                {wfLogOpen ? "▴ ย่อ" : `▾ ดูทั้งหมด (${wf.log.length})`}
              </button>
            )}
          </div>
        )}

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
                {toolStatus[activeId] && <span className="tool-live">{toolStatus[activeId]}</span>}
              </div>
            </div>
          )}
        </div>

        {/* quick-reply: ปุ่มตอบตัวเลือกที่ agent ถามมา (resume session) */}
        {(() => {
          const last = messages[messages.length - 1];
          if (!last || last.role !== "assistant" || isBusy(activeId)) return null;
          const choices = parseChoices(last.text);
          if (choices.length === 0) return null;
          return (
            <div className="quick-replies">
              <span className="qr-label">ตอบเร็ว:</span>
              {choices.map((c, i) => (
                <button
                  key={i}
                  className="qr-btn"
                  onClick={() => sendQuick(c)}
                  title={c}
                  style={{ borderColor: `${active.accent}66`, color: active.accent }}
                >
                  {c.length > 44 ? c.slice(0, 44) + "…" : c}
                </button>
              ))}
            </div>
          );
        })()}

        <div className="composer">
          <div className="composer-tools">
            {/* global project — ทุก agent ใช้ร่วมกัน */}
            <button className="tool-btn" onClick={pickProject} title="เลือก project รวม (agent ทุกตัวใช้ folder นี้)">
              📁 {projectDir ? projectDir.split("/").pop() : "เลือก project"}
            </button>
            {/* per-agent override */}
            {cwds[activeId] ? (
              <span className="chip" title={`${active.name} แยก: ${cwds[activeId]}`}>
                ⤲ {cwds[activeId].split("/").pop()}
                <button className="chip-x" onClick={clearAgentFolder} title="กลับไปใช้ project รวม">
                  ✕
                </button>
              </span>
            ) : (
              <button className="tool-btn ghost" onClick={pickAgentFolder} title={`ให้ ${active.name} ทำงานคนละ folder`}>
                ⤲ แยก
              </button>
            )}
            <button className="tool-btn" onClick={attachFiles} title="แนบไฟล์">
              📎 แนบไฟล์
            </button>
            <button
              className="tool-btn"
              title="รัน Feature Pipeline: Serena→Mia→(Yuri∥Kelvin)→review→integrate→review"
              disabled={!input.trim() || wf?.status === "running"}
              onClick={() => {
                const task = input.trim();
                if (!task) return;
                setInput("");
                startWorkflow(FEATURE_WF, task, effectiveCwd(activeId), useGitBranch);
              }}
            >
              🧭 Quest
            </button>
            <button
              className={`tool-btn ${useGitBranch ? "" : "ghost"}`}
              title={
                useGitBranch
                  ? "ตอน pipeline เริ่ม จะแตก git branch ใหม่ใน project แล้วทำงานบน branch นั้น (working tree ต้องสะอาด)"
                  : "เปิด: แตก git branch อัตโนมัติตอนรัน pipeline"
              }
              aria-pressed={useGitBranch}
              onClick={() => setUseGitBranch((v) => !v)}
            >
              ⎇ branch{useGitBranch ? " ✓" : ""}
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
      {showPipeline && (
        <Suspense fallback={<div className="modal-backdrop"><div className="modal">กำลังโหลด…</div></div>}>
          <PipelineBuilder
            agents={agents}
            pipelines={pipelines}
            projectDir={projectDir}
            onSave={setPipelines}
            onClose={() => setShowPipeline(false)}
            onRun={runPipeline}
            onPickProject={pickProject}
            onAttachDocs={attachDocsToProject}
            onExportGraph={exportPipelineGraph}
            onImportGraph={importPipelineGraph}
            gitBranch={useGitBranch}
            onToggleGitBranch={setUseGitBranch}
            history={wfHistory}
            onClearHistory={() => setWfHistory([])}
          />
        </Suspense>
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
