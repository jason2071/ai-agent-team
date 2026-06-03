# Forgeline (Tauri + React)

ทีม AI agent สำหรับงาน dev — แต่ละ agent มี persona / bg / avatar ของตัวเอง
ขับเคลื่อนด้วย **Claude subscription** ผ่าน `claude -p` (headless Claude Code)

## ทำงานยังไง

```
React UI ──invoke("run_agent")──► Rust (src-tauri)
                                      │ spawn: claude -p ... --output-format stream-json
                                      ▼
                            อ่าน stdout ทีละบรรทัด (JSON)
                                      │ emit "agent://stream"
React UI ◄────────────────────────────┘  (stream ตอบกลับ + เก็บ session_id ไว้คุยต่อ)
```

แต่ละ agent = system prompt (`persona`) ต่างกัน → คุมบุคลิก/หน้าที่ ดูที่ `src/agents.ts`

## ข้อกำหนดก่อนรัน

1. **Node.js** + **Rust toolchain** (`rustup`)
2. **Claude Code** ติดตั้งและ login ด้วย subscription:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude        # login ด้วย Pro/Max account (อย่าตั้ง ANTHROPIC_API_KEY ไว้ ไม่งั้นจะไปใช้ API billing แทน)
   ```
3. ระบบ deps ของ Tauri ตาม OS: https://tauri.app/start/prerequisites/

> หมายเหตุ billing: ตั้งแต่ 15 มิ.ย. 2026 usage ของ `claude -p` / Agent SDK
> ใช้ credit รายเดือนแยก (Pro $20 / Max5x $100 / Max20x $200) คิดตาม API rate

## รัน

```bash
npm install
npm run tauri dev
```

build production:
```bash
npm run tauri build
```

## จุดที่ปรับได้

- **เพิ่ม/แก้ agent**: `src/agents.ts` (persona, accent, bg, avatar, allowedTools, model)
- **ใส่รูป bg/avatar จริง**: วางไฟล์ใน `src/assets/` แล้วอ้างใน agents.ts
  เช่น `bg: "url(/src/assets/architect.jpg) center/cover"`, `avatar: "/src/assets/aria.png"`
- **ให้ agent ทำงานในโปรเจกต์จริง**: ใส่ `cwd` ตอน invoke ใน `App.tsx`
  (เช่น path ของ `permission-center`) — agent จะอ่าน/แก้ไฟล์ในโฟลเดอร์นั้นได้
- **tools**: `allowedTools` ว่าง = read-only; ใส่ `["Read","Edit","Bash"]` = ให้แก้ไฟล์/รันคำสั่งได้

## ระวัง

- agent ที่เปิด `Edit`/`Bash` แก้ไฟล์จริงได้ — ระวังตอนชี้ `cwd` ไปโปรเจกต์สำคัญ
- ตรวจ flag ของ CLI ด้วย `claude -p --help` เผื่อเวอร์ชันใหม่เปลี่ยน

## Icon

มี placeholder ที่ `src-tauri/icons/icon.png` แล้ว เปลี่ยนเป็นรูปจริงได้ด้วย:
```bash
npm run tauri icon path/to/logo.png   # gen ไอคอนครบทุก platform
```
