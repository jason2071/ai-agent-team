// v2 Workflow Engine — preset DAG (task / gate / fork / join / done)
// ขับด้วย done/error event ใน App.tsx. ที่นี่เก็บแค่ type + preset + pure helpers.

export interface WFCtx {
  task: string;                       // โจทย์ตั้งต้นของ workflow
  results: Record<string, string>;    // nodeId -> output ล่าสุดของ node นั้น
}

export type WFNode =
  | {
      id: string;
      kind: "task";
      agent: string;                  // agent id (architect/uxui/backend/frontend/...)
      title: string;
      build: (c: WFCtx) => string;    // สร้าง prompt จาก task + ผลลัพธ์ก่อนหน้า
      next: string;
    }
  | {
      id: string;
      kind: "gate";
      agent: string;                  // ปกติ = reviewer
      title: string;
      build: (c: WFCtx) => string;
      onPass: string;                 // node ถัดไปถ้า PASS
      onFail: string;                 // node ที่ตีกลับถ้า FAIL (ปกติ = author)
      maxRetry: number;
    }
  | { id: string; kind: "fork"; title: string; branches: string[]; join: string }
  | { id: string; kind: "join"; title: string; expected: number; next: string }
  | { id: string; kind: "done"; title: string };

export interface Workflow {
  id: string;
  name: string;
  start: string;
  nodes: Record<string, WFNode>;
}

// state ของ workflow ที่กำลังรัน (เก็บใน ref เป็น source of truth)
export interface WFRun {
  wf: Workflow;
  task: string;
  cwd: string | null;
  results: Record<string, string>;     // nodeId -> output
  retries: Record<string, number>;     // gateId -> รอบที่ fail
  running: Record<string, string>;     // agentId -> nodeId ที่กำลังรัน
  joinArrived: Record<string, number>; // joinId -> branch ที่มาถึงแล้ว
  status: "running" | "done" | "halted";
  log: string[];                       // บรรทัด progress สำหรับ banner
}

// reviewer ต้องจบด้วย marker นี้ engine ถึง parse ได้
export const GATE_RULE =
  "\n\n---\n[คำสั่งสำหรับ reviewer] บรรทัดสุดท้ายต้องเป็น `VERDICT: PASS` ถ้าผ่านเกณฑ์ทั้งหมด " +
  "หรือ `VERDICT: FAIL` ถ้ามีจุดต้องแก้ แล้วตามด้วย bullet สั้น ๆ ว่าต้องแก้อะไร (ให้ author เอาไปแก้ได้).";

export function parseVerdict(text: string): "PASS" | "FAIL" | null {
  // เอา marker ตัวท้ายสุด (กันมีคำว่า PASS/FAIL ในเนื้อหา)
  const matches = [...text.matchAll(/VERDICT:\s*(PASS|FAIL)/gi)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].toUpperCase() as "PASS" | "FAIL";
}

// แทรก feedback จาก review ก่อนหน้า (ถ้ามี) ให้ author เอาไปแก้ตอน retry
const fb = (c: WFCtx, gateId: string) =>
  c.results[gateId] ? `\n\n[แก้ตาม review ก่อนหน้า]\n${c.results[gateId]}\n` : "";

// ===== Preset: "Feature" =====
// Serena → Mia → fork(Yuri API ∥ Kelvin web)
//   Yuri → gate(Darius, loop) → join
//   Kelvin → join
// join → Kelvin integrate → gate(Darius, loop) → done
export const FEATURE_WF: Workflow = {
  id: "feature",
  name: "Feature Pipeline",
  start: "arch",
  nodes: {
    arch: {
      id: "arch",
      kind: "task",
      agent: "architect",
      title: "Serena · architecture",
      next: "design",
      build: (c) =>
        `[Workflow: Feature Pipeline · ขั้น architecture]\n` +
        `โจทย์: ${c.task}\n\n` +
        `ออกแบบ architecture/ระบบ + data model + boundary ให้ทีมเอาไปทำต่อ (API + web). สรุปให้ชัดเป็น spec.`,
    },
    design: {
      id: "design",
      kind: "task",
      agent: "uxui",
      title: "Mia · UX/UI design",
      next: "fork1",
      build: (c) =>
        `[Workflow: Feature Pipeline · ขั้น design]\n` +
        `โจทย์: ${c.task}\n\n` +
        `architecture จาก Serena:\n${c.results.arch ?? ""}\n\n` +
        `ออกแบบ UX/UI flow + component spec + design token ให้ frontend เอาไปทำ.`,
    },
    fork1: { id: "fork1", kind: "fork", title: "แตกงาน: API ∥ Web", branches: ["api", "web"], join: "join1" },
    api: {
      id: "api",
      kind: "task",
      agent: "backend",
      title: "Yuri · เขียน API",
      next: "reviewApi",
      build: (c) =>
        `[Workflow · ขั้น เขียน API]\n` +
        `โจทย์: ${c.task}\n\n` +
        `architecture จาก Serena:\n${c.results.arch ?? ""}\n` +
        fb(c, "reviewApi") +
        `\nเขียน API ตาม architecture (handler/service/repo). ให้ใช้งานได้จริง + ระบุ endpoint/contract ชัดเจน.`,
    },
    reviewApi: {
      id: "reviewApi",
      kind: "gate",
      agent: "reviewer",
      title: "Darius · review API",
      onPass: "join1",
      onFail: "api",
      maxRetry: 3,
      build: (c) =>
        `[Workflow · review API]\n` +
        `โจทย์: ${c.task}\n\n` +
        `API ที่ Yuri เขียน:\n${c.results.api ?? ""}\n\n` +
        `review หา bug/security/performance/clean-architecture.` +
        GATE_RULE,
    },
    web: {
      id: "web",
      kind: "task",
      agent: "frontend",
      title: "Kelvin · เขียน web",
      next: "join1",
      build: (c) =>
        `[Workflow · ขั้น เขียน web]\n` +
        `โจทย์: ${c.task}\n\n` +
        `architecture จาก Serena:\n${c.results.arch ?? ""}\n\n` +
        `design จาก Mia:\n${c.results.design ?? ""}\n\n` +
        `เขียน frontend (React+TS) ตาม design. ทำ UI + state ให้พร้อมต่อ API.`,
    },
    join1: { id: "join1", kind: "join", title: "รวมงาน API + Web", expected: 2, next: "integrate" },
    integrate: {
      id: "integrate",
      kind: "task",
      agent: "frontend",
      title: "Kelvin · integrate API",
      next: "reviewInt",
      build: (c) =>
        `[Workflow · ขั้น integrate]\n` +
        `โจทย์: ${c.task}\n\n` +
        `API จาก Yuri:\n${c.results.api ?? ""}\n\n` +
        `web ที่เขียนไว้:\n${c.results.web ?? ""}\n` +
        fb(c, "reviewInt") +
        `\nต่อ frontend เข้ากับ API จริง (fetch/axios, error/loading state). ให้ทำงาน end-to-end.`,
    },
    reviewInt: {
      id: "reviewInt",
      kind: "gate",
      agent: "reviewer",
      title: "Darius · review integration",
      onPass: "done",
      onFail: "integrate",
      maxRetry: 3,
      build: (c) =>
        `[Workflow · review integration]\n` +
        `โจทย์: ${c.task}\n\n` +
        `งาน integrate ของ Kelvin:\n${c.results.integrate ?? ""}\n\n` +
        `review การเชื่อม API + web ว่าถูกต้อง ครบ ใช้ได้จริง.` +
        GATE_RULE,
    },
    done: { id: "done", kind: "done", title: "เสร็จ ✓" },
  },
};

export const WORKFLOWS: Workflow[] = [FEATURE_WF];

// ===== Pipeline ที่ผู้ใช้สร้างเอง (linear + review gate) =====
export interface PipelineStep {
  agent: string;     // agent id
  gate?: boolean;    // true = review gate ของ task ก่อนหน้า
  par?: boolean;     // true = รันพร้อมกับ step ก่อนหน้า (parallel group)
}
// node-graph (react-flow) — เก็บใน preset เป็น graph
export interface GraphNode { id: string; agent: string; review?: boolean; x: number; y: number }
export interface GraphEdge { id: string; source: string; target: string }
export interface PipelineGraph { nodes: GraphNode[]; edges: GraphEdge[] }

export interface PipelinePreset {
  id: string;
  name: string;
  steps?: PipelineStep[];   // legacy (list builder)
  graph?: PipelineGraph;    // node-graph builder
}

type Seg =
  | { kind: "task"; i: number }
  | { kind: "gate"; i: number }
  | { kind: "par"; idxs: number[] };

// แปลง ordered steps -> Workflow ที่ engine รันได้
// - step ติดกันที่ par=true รวมเป็น parallel group (fork/join)
// - gate ตีกลับ task ก่อนหน้า loop<=3 (builder การันตี gate ไม่ตามหลัง group/gate)
export function buildWorkflow(
  name: string,
  steps: PipelineStep[],
  label: (agentId: string) => { name: string; role: string },
): Workflow {
  const n = steps.length;
  const nodes: Record<string, WFNode> = {};
  if (n === 0) {
    nodes.done = { id: "done", kind: "done", title: "เสร็จ ✓" };
    return { id: `pl-${name}`, name, start: "done", nodes };
  }

  // 1) แบ่ง segment: gate เดี่ยว / task เดี่ยว / par group (task ติดกันที่ par)
  const segs: Seg[] = [];
  let i = 0;
  while (i < n) {
    if (steps[i].gate) {
      segs.push({ kind: "gate", i });
      i++;
      continue;
    }
    const group = [i];
    let j = i + 1;
    while (j < n && steps[j].par && !steps[j].gate) {
      group.push(j);
      j++;
    }
    segs.push(group.length > 1 ? { kind: "par", idxs: group } : { kind: "task", i });
    i = j;
  }

  const entry = (s: Seg) => (s.kind === "par" ? `fk${s.idxs[0]}` : `s${s.i}`);
  // node ids ที่เป็น "ผลงาน" ของ segment (เอาไปต่อ context ให้ segment ถัดไป)
  const outIds = (s: Seg | undefined): string[] => {
    if (!s) return [];
    if (s.kind === "task") return [`s${s.i}`];
    if (s.kind === "gate") return [`s${s.i - 1}`]; // งานที่ผ่าน review
    return s.idxs.map((x) => `s${x}`); // par: ทุก branch
  };

  segs.forEach((seg, k) => {
    const fwd = k + 1 < segs.length ? entry(segs[k + 1]) : "done";
    const prevOut = outIds(segs[k - 1]);
    const ctx = (c: WFCtx) =>
      prevOut.length
        ? `งานก่อนหน้า:\n${prevOut.map((id) => c.results[id]).filter(Boolean).join("\n---\n")}\n\n`
        : "";

    if (seg.kind === "task") {
      const ag = label(steps[seg.i].agent);
      const reviewGateId = steps[seg.i + 1]?.gate ? `s${seg.i + 1}` : null;
      nodes[`s${seg.i}`] = {
        id: `s${seg.i}`,
        kind: "task",
        agent: steps[seg.i].agent,
        title: `${ag.name} · ${ag.role}`,
        next: fwd,
        build: (c) =>
          `[Pipeline]\nโจทย์: ${c.task}\n\n` +
          ctx(c) +
          (reviewGateId ? fb(c, reviewGateId) : "") +
          `ทำงานต่อตามบทบาทของคุณ ให้ใช้ได้จริง.`,
      };
    } else if (seg.kind === "gate") {
      const ag = label(steps[seg.i].agent);
      const authorId = `s${seg.i - 1}`;
      nodes[`s${seg.i}`] = {
        id: `s${seg.i}`,
        kind: "gate",
        agent: steps[seg.i].agent,
        title: `${ag.name} · review`,
        onPass: fwd,
        onFail: authorId,
        maxRetry: 3,
        build: (c) =>
          `[Pipeline · review]\nโจทย์: ${c.task}\n\n` +
          `งานที่ต้อง review:\n${c.results[authorId] ?? ""}\n\n` +
          `review ตามบทบาทของคุณ — หา bug / ปัญหา / ความครบถ้วน.` +
          GATE_RULE,
      };
    } else {
      // parallel group -> fork -> branches -> join
      const b = seg.idxs[0];
      nodes[`fk${b}`] = {
        id: `fk${b}`,
        kind: "fork",
        title: `ทำพร้อมกัน (${seg.idxs.length})`,
        branches: seg.idxs.map((x) => `s${x}`),
        join: `jn${b}`,
      };
      seg.idxs.forEach((x) => {
        const ag = label(steps[x].agent);
        nodes[`s${x}`] = {
          id: `s${x}`,
          kind: "task",
          agent: steps[x].agent,
          title: `${ag.name} · ${ag.role}`,
          next: `jn${b}`,
          build: (c) =>
            `[Pipeline · งานขนาน]\nโจทย์: ${c.task}\n\n` +
            ctx(c) +
            `ทำงานตามบทบาทของคุณ (รันพร้อมทีมอื่น).`,
        };
      });
      nodes[`jn${b}`] = {
        id: `jn${b}`,
        kind: "join",
        title: "รวมงานขนาน",
        expected: seg.idxs.length,
        next: fwd,
      };
    }
  });

  nodes.done = { id: "done", kind: "done", title: "เสร็จ ✓" };
  return { id: `pl-${name}`, name, start: entry(segs[0]), nodes };
}

// แปลง node-graph -> Workflow:
//   outDeg>1 = fork (ขนาน), inDeg>1 = join (รวม), review node = gate (onFail→author loop)
export function graphToWorkflow(
  name: string,
  graph: PipelineGraph,
  label: (agentId: string) => { name: string; role: string },
): Workflow {
  const { nodes, edges } = graph;
  const done: WFNode = { id: "done", kind: "done", title: "เสร็จ ✓" };
  if (nodes.length === 0) return { id: `pl-${name}`, name, start: "done", nodes: { done } };

  const out: Record<string, string[]> = {};
  const inFrom: Record<string, string[]> = {};
  for (const n of nodes) { out[n.id] = []; inFrom[n.id] = []; }
  for (const e of edges) {
    if (out[e.source] && inFrom[e.target]) { out[e.source].push(e.target); inFrom[e.target].push(e.source); }
  }

  // ต้องมีจุดเริ่มเดียว (inDeg 0)
  const starts = nodes.filter((n) => inFrom[n.id].length === 0);
  if (starts.length !== 1) {
    throw new Error(`ต้องมีจุดเริ่มเดียว (node ที่ไม่มีเส้นเข้า) — พบ ${starts.length}`);
  }
  // ห้าม cycle ที่ลากเอง (gate loop เป็น implicit)
  const color: Record<string, number> = {};
  let cyclic = false;
  const dfs = (id: string) => {
    color[id] = 1;
    for (const t of out[id]) {
      if (color[t] === 1) { cyclic = true; return; }
      if (!color[t]) dfs(t);
    }
    color[id] = 2;
  };
  for (const n of nodes) if (!color[n.id]) dfs(n.id);
  if (cyclic) throw new Error("กราฟมีวงวน (cycle) — ต่อเส้นย้อนกลับไม่ได้");

  const entry = (id: string) => (inFrom[id].length > 1 ? `jn${id}` : `n${id}`);
  const forward = (id: string) => {
    const o = out[id];
    if (o.length === 0) return "done";
    if (o.length === 1) return entry(o[0]);
    return `fk${id}`;
  };

  const wf: Record<string, WFNode> = {};
  for (const n of nodes) {
    const ag = label(n.agent);
    const ins = inFrom[n.id];
    const ctx = (c: WFCtx) =>
      ins.length
        ? `งานก่อนหน้า:\n${ins.map((p) => c.results[`n${p}`]).filter(Boolean).join("\n---\n")}\n\n`
        : "";

    // gate = agent ที่เป็น reviewer (role มี "review") — ไม่ต้องติ๊กเอง
    const isGate = /review/i.test(ag.role);
    if (isGate) {
      if (ins.length !== 1) throw new Error(`review "${ag.name}" ต้องมีเส้นเข้า 1 เส้น (ตรวจงานชิ้นเดียว)`);
      const authorId = `n${ins[0]}`;
      wf[`n${n.id}`] = {
        id: `n${n.id}`, kind: "gate", agent: n.agent, title: `${ag.name} · review`,
        onPass: forward(n.id), onFail: authorId, maxRetry: 3,
        build: (c) =>
          `[Pipeline · review]\nโจทย์: ${c.task}\n\nงานที่ต้อง review:\n${c.results[authorId] ?? ""}\n\n` +
          `review ตามบทบาทของคุณ — หา bug / ปัญหา / ความครบถ้วน.` + GATE_RULE,
      };
    } else {
      wf[`n${n.id}`] = {
        id: `n${n.id}`, kind: "task", agent: n.agent, title: `${ag.name} · ${ag.role}`,
        next: forward(n.id),
        build: (c) => `[Pipeline]\nโจทย์: ${c.task}\n\n` + ctx(c) + `ทำงานต่อตามบทบาทของคุณ ให้ใช้ได้จริง.`,
      };
    }
    if (out[n.id].length > 1) {
      wf[`fk${n.id}`] = {
        id: `fk${n.id}`, kind: "fork", title: `แตกขนาน (${out[n.id].length})`,
        branches: out[n.id].map(entry), join: "", // engine ใช้ branch.next ชี้ join เอง
      };
    }
    if (inFrom[n.id].length > 1) {
      wf[`jn${n.id}`] = {
        id: `jn${n.id}`, kind: "join", title: "รวมเส้น",
        expected: inFrom[n.id].length, next: `n${n.id}`,
      };
    }
  }
  wf.done = done;
  return { id: `pl-${name}`, name, start: entry(starts[0].id), nodes: wf };
}
