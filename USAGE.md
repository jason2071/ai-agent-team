# คู่มือใช้งาน — AI Agent Team (กิลด์นักผจญภัย)

แอป desktop ที่รวมทีม AI agent ไว้ในกิลด์เดียว แต่ละตัวมีบทบาทต่างกัน (ออกแบบ → code → test → review) สั่งงานผ่านการแชต. เบื้องหลังแต่ละ agent คือ **Claude Code CLI** (`claude`) ที่รันด้วย subscription ของคุณ.

> ต้องติดตั้ง Claude Code + login ก่อน: `npm i -g @anthropic-ai/claude-code` แล้วรัน `claude` เพื่อ login (อย่าตั้ง `ANTHROPIC_API_KEY` — แอปบังคับใช้ subscription)

---

## 1. เริ่มต้น

```bash
npm install
npm run tauri dev      # เปิดแอป (dev)
npm run tauri build    # build production (.app/.dmg)
```

เปิดมาเจอ **ห้องกิลด์** — ตัวละคร 7 ตัวยืนตาม station. คลิกตัวไหนเพื่อเปิดห้องแชตคุยกับตัวนั้น.

---

## 2. ทีมนักผจญภัย (agents)

| ตัวละคร | บทบาท | tools | เขียนไฟล์ได้ |
|---|---|---|---|
| **Serena** | Software Architect | Read | ไม่ (วางแผน/ออกแบบ) |
| **Rex** | Tech Lead | Read | ไม่ (วางแผน/สั่งงาน) |
| **Mia** | UX/UI Designer | Read | ไม่ |
| **Kelvin** | Frontend Engineer | Read/Write/Edit/Bash | ✅ |
| **Yuri** | Backend Engineer | Read/Write/Edit/Bash | ✅ |
| **Eve** | QA / Test Engineer | Read/Write/Edit/Bash | ✅ |
| **Darius** | Code Reviewer | Read | ไม่ |

- **Read-only** (Serena/Rex/Mia/Darius) = ที่ปรึกษา/วางแผน — อ่านโค้ดได้ แต่ไม่แก้ไฟล์
- **Worker** (Kelvin/Yuri/Eve) = ลงมือเขียน/รันคำสั่งได้จริง
- ตอบเป็นภาษาไทย, technical term เป็นอังกฤษ. แต่ละตัวมีบุคลิก/น้ำเสียงต่างกัน

> อยากให้ตัวไหนเขียนไฟล์ได้เพิ่ม → ตั้งใน **จัดการนักผจญภัย** (ดูข้อ 7)

---

## 3. คุยกับ agent

1. คลิกตัวละครในห้อง (หรือชื่อใน panel ซ้าย) → เปิดห้องแชต
2. พิมพ์ในช่องล่าง → **Enter** ส่ง, **Shift+Enter** ขึ้นบรรทัด
3. คำตอบ stream เข้ามาเรื่อย ๆ
4. คุยต่อเนื่องได้ (multi-turn) — agent จำบทสนทนาเดิม
5. ปุ่ม **←** กลับห้องกิลด์, **🗑 ล้าง** ล้างแชต + reset session

ระหว่างทำงาน: ตัวละครในห้อง **เด้ง + เรืองแสง**, ใต้ฟองพิมพ์โชว์ **🔧 tool ที่ใช้สด ๆ** (Bash/Read/Write...).

ล่างสุดโชว์ **💰 cost + tokens** ต่อ turn.

---

## 4. Project folder (ที่ทำงาน)

agent ทำงานในโฟลเดอร์ที่กำหนด (cwd). มี 2 ระดับ:

- **📁 Project รวม** — agent ทุกตัวใช้โฟลเดอร์เดียวกันเป็น default (ทำงาน project เดียวกัน)
- **⤲ แยก** — override เฉพาะ agent ตัวนั้น (ตั้งใจให้ทำคนละ project)

ปุ่มอยู่แถบ tool เหนือช่องพิมพ์. ลำดับความสำคัญ: override ตัวเอง > project รวม.

> ⚠️ **สำคัญ:** เปลี่ยน folder ระหว่างคุย = **เริ่ม session ใหม่** อัตโนมัติ (claude เก็บ session แยกตามโฟลเดอร์ — resume ข้าม folder ไม่ได้). แอปจะแจ้งในแชตเมื่อเกิดขึ้น.

> ก่อนให้ worker agent (Kelvin/Yuri/Eve) เขียนไฟล์ — **ตั้ง project folder ก่อนเสมอ** ไม่งั้นมันทำงานในโฟลเดอร์ที่แอปเปิด (อันตราย)

---

## 5. ส่งต่องาน (Handoff) — 2 แบบ

แถบ **"ส่งต่อ →"** โผล่ที่หัวห้องแชตเมื่อมีบทสนทนาแล้ว.

### Parallel (ส่งพร้อมกัน)
1. ปิด toggle **"ลำดับ"** (default)
2. คลิกเลือก agent ปลายทาง (กี่ตัวก็ได้) → ขึ้น ✓
3. กด **"ส่ง (n)"**

→ ทุกตัวรับบทสนทนาเดียวกัน **ยิงพร้อมกันทันที** (แยก session)
เหมาะกับ: ขอความเห็นหลายมุมพร้อมกัน

### Sequential / Auto-chain (ต่อกันเป็นทอด)
1. เปิด toggle **"ลำดับ"**
2. คลิกเลือก agent **ตามลำดับที่อยากให้ทำ** (ลำดับคลิก = ลำดับรัน)
3. กด **"▸ chain (n)"**

→ ตัวแรกทำเสร็จ → เอา **output ป้อนตัวถัดไป** → ทำต่อจนครบ
- แถบ **🔗 chain** โผล่: `Kelvin → [Yuri] → Eve · กำลังทำ Yuri (2/3) [หยุด]`
- error กลางทาง = หยุด บอกว่าหยุดขั้นไหน
- กด **หยุด** ยกเลิก chain

เหมาะกับ: pipeline งานต่อเนื่อง เช่น ออกแบบ (Serena) → เขียน (Kelvin) → test (Eve)

| | Parallel | Sequential |
|---|---|---|
| toggle ลำดับ | ปิด | เปิด |
| รัน | พร้อมกันหมด | ทีละตัว รอกัน |
| input ตัวถัดไป | บทสนทนาเดิม | output ตัวก่อนหน้า |

---

## 6. ตอบเร็ว (Quick-reply)

เมื่อ agent ถามแบบมีตัวเลือกเป็น list (`1. ... 2. ...`) → โผล่ปุ่ม **"ตอบเร็ว:"** ใต้ข้อความ. คลิกปุ่ม = ส่งคำตอบนั้นทันที (คุยต่อ session เดิม). พิมพ์ตอบเองก็ยังได้.

> ถ้า agent ถามลอย ๆ ไม่มี list → ไม่มีปุ่ม ให้พิมพ์ตอบในช่องปกติ

---

## 7. จัดการนักผจญภัย (แก้ agent)

กด **⚙ จัดการนักผจญภัย** (มุมขวาบน):
- เพิ่ม / ลบ / แก้ agent
- ตั้ง **model**, **gender**, **persona** (system prompt)
- เลือก **Tools**: Read / Write / Edit / Bash
- เลือก **Permission mode**:

| mode | ผล |
|---|---|
| default | ถามก่อนใช้ tool เสี่ยง (⚠️ block ในแอป เพราะ approve ไม่ได้) |
| plan | อ่าน/วางแผนอย่างเดียว |
| acceptEdits | แก้ไฟล์อัตโนมัติ (แต่ Bash ยังถาม) |
| **bypassPermissions** | ทำได้ทุกอย่างไม่ถาม (worker agent ใช้อันนี้) |

> **เขียนไฟล์/รัน Bash ไม่ได้?** → agent ตัวนั้นต้องมี tool `Write`/`Bash` **และ** permission = `bypassPermissions`. แอปนี้ไม่มีปุ่ม approve กลางคัน (claude รันแบบ non-interactive) จึงต้อง preset.

---

## 8. แนบไฟล์

ปุ่ม **📎 แนบไฟล์**:
- **text file** → อ่าน content ใส่ใน prompt ให้เลย
- **รูป** → ส่ง path ให้ agent เปิดดูเอง (Read tool)

---

## 9. ห้องกิลด์ (UI)

- **Panel ซ้าย** (สมาชิกกิลด์) — list agent + สถานะ RUNNING/IDLE, คลิกชื่อเพื่อคุย
- **Panel ขวา** (GUILD ACTIVITY) — feed คำตอบล่าสุดของแต่ละตัว
- กดหัว panel (▾/▸) **พับเก็บ** ได้ — กันบังตัวละคร
- ตัวละครยืนตาม station: Quest board, Reception, Item storage, Rank board ฯลฯ

---

## 10. ปัญหาที่เจอบ่อย

| อาการ | สาเหตุ / แก้ |
|---|---|
| `[error] ... No conversation found` | resume ข้าม folder — เปลี่ยน folder กลางคัน. แอป drop session ให้แล้ว ลองส่งใหม่ |
| agent ขอ approve เขียนไฟล์ แต่ไม่มีปุ่ม | agent ยังไม่ได้ `bypassPermissions` — ตั้งใน จัดการนักผจญภัย (ข้อ 7) |
| Rex/Serena เขียนไฟล์ไม่ได้ | เป็น Read-only โดยตั้งใจ — ใช้ Kelvin/Yuri/Eve เขียน หรือ handoff ไปหา |
| chat เต็มไปด้วยบรรทัด tool | (แก้แล้ว) tool โชว์เป็น status สดบรรทัดเดียว ไม่เก็บถาวร |
| `Invalid API key` | มี `ANTHROPIC_API_KEY` ค้างใน env — เอาออก ใช้ subscription |
| Port 1420 ติด | Vite ค้างจากรอบก่อน — `lsof -ti tcp:1420 \| xargs kill` |

---

## 11. workflow แนะนำ

1. ตั้ง **📁 Project folder** ให้ตรง repo ที่จะทำ
2. คุย **Serena/Rex** วางแผน/ออกแบบก่อน (read-only ปลอดภัย)
3. เปิด **ลำดับ** → handoff ไป **Kelvin** (เขียน) → **Eve** (test) → **Darius** (review)
4. ดู chain banner ไล่งานทีละขั้น เห็นตัวละครวิ่งทำงานในห้อง
