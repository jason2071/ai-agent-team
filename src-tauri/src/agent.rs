use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::ipc::Channel;
use tauri::State;

/// เก็บ Child handle ต่อ agent_id เพื่อ (1) cancel/kill (2) reap กัน zombie
#[derive(Default)]
pub struct AgentState {
    children: Arc<Mutex<HashMap<String, Child>>>,
}

/// GUI app ที่เปิดจาก Finder/Launchpad ได้ PATH แค่ /usr/bin:/bin:... ไม่เห็น
/// homebrew / nvm / ~/.local/bin → spawn "claude" ไม่เจอ. แก้ด้วยการ
/// (1) resolve absolute path ของ claude เอง, (2) เติม bin dir เข้า PATH ให้ child
fn claude_bin_dirs() -> Vec<String> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = home.to_string_lossy().into_owned();
        dirs.push(format!("{home}/.local/bin"));
        dirs.push(format!("{home}/.bun/bin"));
        dirs.push(format!("{home}/.npm-global/bin"));
        // nvm: เลือก version ปัจจุบัน/ล่าสุดแบบหยาบ ๆ
        let nvm = format!("{home}/.nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm) {
            let mut versions: Vec<_> = entries
                .flatten()
                .map(|e| e.path().join("bin"))
                .filter(|p| p.is_dir())
                .collect();
            versions.sort();
            dirs.extend(versions.into_iter().rev().map(|p| p.to_string_lossy().into_owned()));
        }
    }
    dirs.push("/opt/homebrew/bin".to_string());
    dirs.push("/usr/local/bin".to_string());
    dirs
}

/// อ่าน content ของไฟล์ที่ user แนบ (ใช้ทำ attach -> prepend เข้า prompt)
/// custom command ไม่ต้องพึ่ง fs plugin scope. จำกัดขนาดกัน prompt บวมเกิน
#[tauri::command]
pub fn read_file_text(path: String) -> Result<String, String> {
    const MAX: u64 = 512 * 1024; // 512KB ต่อไฟล์
    // canonicalize กัน path traversal / symlink หลอก
    let real = std::fs::canonicalize(&path).map_err(|e| format!("resolve {path} failed: {e}"))?;
    let meta = std::fs::metadata(&real).map_err(|e| format!("stat failed: {e}"))?;
    if meta.len() > MAX {
        return Err(format!("ไฟล์ใหญ่เกิน {} KB (limit 512KB)", meta.len() / 1024));
    }
    let bytes = std::fs::read(&real).map_err(|e| format!("read failed: {e}"))?;
    // ตรวจ binary แบบหยาบ: มี NUL byte ใน 8KB แรก = ไม่ใช่ text
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Err("ไฟล์ binary — รองรับเฉพาะ text".to_string());
    }
    // ยอม invalid UTF-8 บาง byte (latin-1/log) แทนที่จะ fail ทั้งไฟล์
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// หา absolute path ของ claude; ถ้าไม่เจอใช้ "claude" ตรง ๆ (ให้ PATH จัดการ)
fn resolve_claude() -> String {
    for dir in claude_bin_dirs() {
        let candidate = Path::new(&dir).join("claude");
        if candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "claude".to_string()
}

/// Event ที่ส่งกลับไปให้ frontend ผ่าน Tauri ipc Channel (point-to-point,
/// ไม่มี race เรื่อง listener registration เหมือน global emit/listen)
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamEvent {
    /// ได้ session_id แล้ว (เก็บไว้ใช้ resume เพื่อคุยต่อเนื่อง)
    Session { agent_id: String, session_id: String },
    /// text ที่ assistant ตอบมา (ส่งทีละก้อน)
    Delta { agent_id: String, text: String },
    /// progress: agent กำลังใช้ tool (Bash/Edit/Read) — โชว์เป็นบรรทัด muted
    System { agent_id: String, text: String },
    /// usage/cost ของ turn (จาก result) — โชว์เป็น meta
    Usage {
        agent_id: String,
        cost_usd: f64,
        input_tokens: u64,
        output_tokens: u64,
    },
    /// จบ turn
    Done { agent_id: String },
    /// error
    Error { agent_id: String, message: String },
}

/// ข้อมูลที่ frontend ส่งมาเพื่อสั่ง agent ทำงาน
#[derive(serde::Deserialize)]
pub struct RunArgs {
    pub agent_id: String,
    /// system prompt ที่กำหนดบุคลิก/หน้าที่ของ agent
    pub persona: String,
    /// คำสั่งจากผู้ใช้
    pub prompt: String,
    /// เช่น "claude-opus-4-8", "claude-sonnet-4-6" (ปล่อยว่าง = default ของ subscription)
    pub model: Option<String>,
    /// session_id เดิม ถ้าต้องการคุยต่อ (multi-turn)
    pub resume: Option<String>,
    /// tools ที่อนุญาต เช่น ["Read","Edit","Bash"] ปล่อยว่าง = read-only
    pub allowed_tools: Option<Vec<String>>,
    /// working directory ที่ให้ agent ทำงาน (โฟลเดอร์โปรเจกต์ของผู้ใช้)
    pub cwd: Option<String>,
    /// permission mode: plan | default | acceptEdits | bypassPermissions
    pub permission_mode: Option<String>,
}

#[tauri::command]
pub fn run_agent(
    state: State<AgentState>,
    args: RunArgs,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let mut cmd = Command::new(resolve_claude());

    // เติม bin dir เข้า PATH เผื่อ claude ไป spawn subprocess (node ฯลฯ) ต่อ
    let extra = claude_bin_dirs().join(":");
    let path = match std::env::var("PATH") {
        Ok(p) => format!("{extra}:{p}"),
        Err(_) => format!("{extra}:/usr/bin:/bin:/usr/sbin:/sbin"),
    };
    cmd.env("PATH", path);

    // บังคับใช้ subscription auth: ถ้ามี ANTHROPIC_API_KEY ค้างใน env (เช่นจาก
    // shell profile) claude จะไปใช้ API billing + อาจ "Invalid API key". เอาออก
    cmd.env_remove("ANTHROPIC_API_KEY");
    cmd.env_remove("ANTHROPIC_AUTH_TOKEN");

    cmd.arg("-p")
        .arg(&args.prompt)
        .arg("--append-system-prompt")
        .arg(&args.persona)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose"); // จำเป็นเมื่อใช้ stream-json กับ -p

    if let Some(model) = &args.model {
        if !model.is_empty() {
            cmd.arg("--model").arg(model);
        }
    }
    if let Some(session) = &args.resume {
        if !session.is_empty() {
            cmd.arg("--resume").arg(session);
        }
    }
    if let Some(tools) = &args.allowed_tools {
        if !tools.is_empty() {
            cmd.arg("--allowedTools").arg(tools.join(","));
        }
    }
    if let Some(mode) = &args.permission_mode {
        if !mode.is_empty() {
            cmd.arg("--permission-mode").arg(mode);
        }
    }
    if let Some(dir) = &args.cwd {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn claude failed: {e} (ติดตั้ง Claude Code และ login ด้วย subscription แล้วหรือยัง?)"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take();
    let agent_id = args.agent_id.clone();
    let tx = on_event.clone();
    let children = state.children.clone();

    // stderr: เก็บ log ไว้เฉย ๆ (ไม่ emit error จาก stderr — claude เขียน warning/hook
    // noise ลง stderr แม้ exit 0 จะกลายเป็น false error). ใช้เป็น diagnostic ตอน crash
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = stderr {
        let buf = stderr_buf.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut b) = buf.lock() {
                    b.push_str(&line);
                    b.push('\n');
                }
            }
        });
    }

    // เก็บ child ไว้ใน state (สำหรับ cancel + reap)
    if let Ok(mut map) = children.lock() {
        map.insert(agent_id.clone(), child);
    }

    // อ่าน stdout ทีละบรรทัด แต่ละบรรทัดคือ JSON object หนึ่งตัว (stream-json)
    thread::spawn(move || {
        let mut saw_result = false;
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };

            // เก็บ session_id ครั้งแรกที่เจอ
            if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                let _ = tx.send(StreamEvent::Session {
                    agent_id: agent_id.clone(),
                    session_id: sid.to_string(),
                });
            }

            match v.get("type").and_then(|t| t.as_str()) {
                // ข้อความจาก assistant -> text + tool_use (progress)
                Some("assistant") => {
                    if let Some(content) =
                        v.pointer("/message/content").and_then(|c| c.as_array())
                    {
                        for block in content {
                            match block.get("type").and_then(|t| t.as_str()) {
                                Some("text") => {
                                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                        let _ = tx.send(StreamEvent::Delta {
                                            agent_id: agent_id.clone(),
                                            text: text.to_string(),
                                        });
                                    }
                                }
                                Some("tool_use") => {
                                    let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                                    let _ = tx.send(StreamEvent::System {
                                        agent_id: agent_id.clone(),
                                        text: format!("🔧 {name}"),
                                    });
                                }
                                _ => {}
                            }
                        }
                    }
                }
                // จบงาน: ดู is_error จาก result ไม่ใช่ stderr
                Some("result") => {
                    saw_result = true;
                    // usage/cost
                    let cost = v.get("total_cost_usd").and_then(|c| c.as_f64()).unwrap_or(0.0);
                    let in_tok = v.pointer("/usage/input_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
                    let out_tok = v.pointer("/usage/output_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
                    if cost > 0.0 || in_tok > 0 || out_tok > 0 {
                        let _ = tx.send(StreamEvent::Usage {
                            agent_id: agent_id.clone(),
                            cost_usd: cost,
                            input_tokens: in_tok,
                            output_tokens: out_tok,
                        });
                    }
                    let is_err = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
                    if is_err {
                        let msg = v
                            .get("result")
                            .and_then(|r| r.as_str())
                            .unwrap_or("claude error")
                            .to_string();
                        let _ = tx.send(StreamEvent::Error {
                            agent_id: agent_id.clone(),
                            message: msg,
                        });
                    } else {
                        let _ = tx.send(StreamEvent::Done {
                            agent_id: agent_id.clone(),
                        });
                    }
                }
                _ => {}
            }
        }

        // EOF: reap child (กัน zombie) + รับประกัน terminal event เสมอ (กัน busy ค้าง)
        let status = children
            .lock()
            .ok()
            .and_then(|mut m| m.remove(&agent_id))
            .and_then(|mut c| c.wait().ok());

        if !saw_result {
            // crash / ถูก kill / hang แล้วถูกตัด -> ส่ง Error ปิดงาน
            let tail = stderr_buf
                .lock()
                .map(|b| b.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            let msg = if tail.trim().is_empty() {
                format!("งานจบผิดปกติ / ถูกหยุด ({status:?})")
            } else {
                tail
            };
            let _ = tx.send(StreamEvent::Error {
                agent_id: agent_id.clone(),
                message: msg,
            });
        }
    });

    Ok(())
}

/// หยุด agent ที่กำลังรัน: kill child + reap. stdout จะ EOF -> reader thread ส่ง terminal event
#[tauri::command]
pub fn cancel_agent(state: State<AgentState>, agent_id: String) {
    if let Ok(mut map) = state.children.lock() {
        if let Some(mut child) = map.remove(&agent_id) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
