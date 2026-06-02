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
  gate?: boolean;    // true = step นี้เป็น review gate ของ task ก่อนหน้า
}
export interface PipelinePreset {
  id: string;
  name: string;
  steps: PipelineStep[];
}

// แปลง ordered steps -> Workflow ที่ engine รันได้ (linear; gate ตีกลับ step ก่อนหน้า loop<=3)
// label: resolve ชื่อ/บทบาทจาก agent id (รองรับ custom agent ที่ไม่อยู่ใน AGENTS)
export function buildLinearWorkflow(
  name: string,
  steps: PipelineStep[],
  label: (agentId: string) => { name: string; role: string },
): Workflow {
  const n = steps.length;
  const nodes: Record<string, WFNode> = {};
  const nextId = (i: number) => (i + 1 < n ? `s${i + 1}` : "done");

  steps.forEach((step, i) => {
    const id = `s${i}`;
    const ag = label(step.agent);

    if (step.gate) {
      const authorId = `s${i - 1}`; // gate รีวิว step ก่อนหน้าเสมอ (builder การันตี i>0)
      nodes[id] = {
        id,
        kind: "gate",
        agent: step.agent,
        title: `${ag.name} · review`,
        onPass: nextId(i),
        onFail: authorId,
        maxRetry: 3,
        build: (c) =>
          `[Pipeline · review]\n` +
          `โจทย์: ${c.task}\n\n` +
          `งานที่ต้อง review:\n${c.results[authorId] ?? ""}\n\n` +
          `review ตามบทบาทของคุณ — หา bug / ปัญหา / ความครบถ้วน.` +
          GATE_RULE,
      };
      return;
    }

    // task: หา task ก่อนหน้าที่ใกล้สุด (ข้าม gate) เพื่อต่อ output + gate ที่รีวิว step นี้ (feedback ตอน retry)
    let prevTaskIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (!steps[j].gate) { prevTaskIdx = j; break; }
    }
    const prevTaskId = prevTaskIdx >= 0 ? `s${prevTaskIdx}` : null;
    const prevName = prevTaskIdx >= 0 ? label(steps[prevTaskIdx].agent).name : "";
    const reviewGateId = steps[i + 1]?.gate ? `s${i + 1}` : null;

    nodes[id] = {
      id,
      kind: "task",
      agent: step.agent,
      title: `${ag.name} · ${ag.role}`,
      next: nextId(i),
      build: (c) =>
        `[Pipeline${i === 0 ? " · เริ่ม" : ""}]\n` +
        `โจทย์: ${c.task}\n\n` +
        (prevTaskId && c.results[prevTaskId]
          ? `งานก่อนหน้า (${prevName}):\n${c.results[prevTaskId]}\n\n`
          : "") +
        (reviewGateId ? fb(c, reviewGateId) : "") +
        `ทำงานต่อตามบทบาทของคุณ ให้ใช้ได้จริง.`,
    };
  });

  nodes.done = { id: "done", kind: "done", title: "เสร็จ ✓" };
  return { id: `pl-${name}`, name, start: "s0", nodes };
}
