// Running .jlb code through an interpreter (the Rust `jlb` or the C `jlb-c`).
// Both speak the same editor modes: --ide, --check and --repl.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// Marks a line meant for the editor (ASCII "record separator").
const MARK: char = '\u{1e}';

fn command(interpreter: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(interpreter);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console window flashes up behind the IDE.
        c.creation_flags(0x0800_0000);
    }
    c
}

fn spawn_error(e: std::io::Error, interpreter: &str) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("couldn't find the interpreter at {} (check Settings → Interpreters)", interpreter)
    } else {
        format!("couldn't start {}: {}", interpreter, e)
    }
}

// ---------- running programs ----------

struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
pub struct Runs {
    next: Mutex<u32>,
    procs: Arc<Mutex<HashMap<u32, Running>>>,
}

#[derive(Clone, Serialize)]
struct Output {
    id: u32,
    stream: &'static str,
    text: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: u32,
    code: Option<i32>,
}

/// Sends a stream's text to the window as it arrives. Reads in chunks rather than
/// lines, so an INPUT prompt (which has no line ending) shows up straight away.
fn pump(app: AppHandle, id: u32, stream: &'static str, mut r: impl Read + Send + 'static) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let n = match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            pending.extend_from_slice(&buf[..n]);
            // Only send whole characters; keep a split character for the next read.
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => pending.len(),
            };
            if valid > 0 {
                let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                pending.drain(..valid);
                let _ = app.emit("run-output", Output { id, stream, text });
            }
        }
        if !pending.is_empty() {
            let text = String::from_utf8_lossy(&pending).into_owned();
            let _ = app.emit("run-output", Output { id, stream, text });
        }
    })
}

/// Starts a program. Its output arrives as "run-output" events, then one "run-exit".
#[tauri::command]
pub fn run_program(app: AppHandle, runs: State<Runs>, interpreter: String, file: String, cwd: String, args: Vec<String>) -> Result<u32, String> {
    let mut cmd = command(&interpreter);
    cmd.args(&args).arg(&file).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }
    let mut child = cmd.spawn().map_err(|e| spawn_error(e, &interpreter))?;
    let id = {
        let mut n = runs.next.lock().unwrap();
        *n += 1;
        *n
    };
    let out = pump(app.clone(), id, "out", child.stdout.take().unwrap());
    let err = pump(app.clone(), id, "err", child.stderr.take().unwrap());
    let stdin = child.stdin.take();
    runs.procs.lock().unwrap().insert(id, Running { child, stdin });
    let procs = runs.procs.clone();
    std::thread::spawn(move || {
        // Wait for both streams to finish, then for the process itself.
        let _ = out.join();
        let _ = err.join();
        let code = loop {
            let done = {
                let mut map = procs.lock().unwrap();
                match map.get_mut(&id) {
                    Some(r) => match r.child.try_wait() {
                        Ok(Some(s)) => Some(s.code()),
                        Ok(None) => None,
                        Err(_) => Some(None),
                    },
                    None => Some(None),
                }
            };
            if let Some(c) = done {
                break c;
            }
            std::thread::sleep(std::time::Duration::from_millis(15));
        };
        procs.lock().unwrap().remove(&id);
        let _ = app.emit("run-exit", Exit { id, code });
    });
    Ok(id)
}

/// Types a line into a running program (for INPUT).
#[tauri::command]
pub fn send_input(runs: State<Runs>, id: u32, text: String) -> Result<(), String> {
    let mut map = runs.procs.lock().unwrap();
    let r = map.get_mut(&id).ok_or("the program isn't running")?;
    let stdin = r.stdin.as_mut().ok_or("the program isn't reading input")?;
    stdin.write_all(text.as_bytes()).and_then(|_| stdin.write_all(b"\n")).and_then(|_| stdin.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_program(runs: State<Runs>, id: u32) -> Result<(), String> {
    if let Some(r) = runs.procs.lock().unwrap().get_mut(&id) {
        let _ = r.child.kill();
    }
    Ok(())
}

// ---------- running to completion (comparing, tests) ----------

#[derive(Serialize)]
pub struct Captured {
    stdout: String,
    stderr: String,
    code: Option<i32>,
    ms: f64,
    timed_out: bool,
}

/// At most this much of each stream is kept (a runaway PRINT loop can't fill the memory).
const CAPTURE_LIMIT: usize = 4 * 1024 * 1024;

fn read_capped(mut r: impl Read) -> String {
    let mut out = Vec::new();
    let mut buf = [0u8; 65536];
    loop {
        match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if out.len() < CAPTURE_LIMIT {
                    let room = CAPTURE_LIMIT - out.len();
                    out.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Runs a program to the end with `input` typed in, and gives back everything it printed.
/// It's stopped after `timeout_ms`.
#[tauri::command]
pub async fn run_capture(interpreter: String, file: String, cwd: String, args: Vec<String>, input: String, timeout_ms: u64) -> Result<Captured, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = command(&interpreter);
        cmd.args(&args).arg(&file).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if !cwd.is_empty() {
            cmd.current_dir(&cwd);
        }
        let start = std::time::Instant::now();
        let mut child = cmd.spawn().map_err(|e| spawn_error(e, &interpreter))?;
        let mut stdin = child.stdin.take().unwrap();
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
        let out = child.stdout.take().unwrap();
        let err = child.stderr.take().unwrap();
        let out_t = std::thread::spawn(move || read_capped(out));
        let err_t = std::thread::spawn(move || read_capped(err));
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) => {}
                Err(_) => break None,
            }
            if start.elapsed().as_millis() as u64 >= timeout_ms {
                timed_out = true;
                let _ = child.kill();
                break child.wait().ok();
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        };
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        let _ = writer.join();
        let stdout = out_t.join().unwrap_or_default();
        let stderr = err_t.join().unwrap_or_default();
        Ok(Captured { stdout, stderr, code: status.and_then(|s| s.code()), ms, timed_out })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- syntax checks ----------

/// Runs `interpreter --check -` on the code and returns its JSON reply.
#[tauri::command]
pub async fn check_code(interpreter: String, source: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = command(&interpreter)
            .args(["--check", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| spawn_error(e, &interpreter))?;
        let mut stdin = child.stdin.take().unwrap();
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(source.as_bytes());
        });
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        let _ = writer.join();
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if text.starts_with('{') {
            Ok(text)
        } else {
            Err(format!("{} doesn't support --check (it may be an older version)", interpreter))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Quick-try ----------

struct Session {
    interpreter: String,
    cwd: String,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[derive(Default)]
pub struct Repl {
    session: Mutex<Option<Session>>,
    /// Kept apart from the session, so Reset can stop a snippet that never finishes.
    child: Arc<Mutex<Option<Child>>>,
}

#[derive(Serialize)]
pub struct ReplReply {
    output: String,
    reply: String,
}

fn kill_session(repl: &Repl) {
    if let Some(mut c) = repl.child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// Runs a snippet in the Quick-try session (starting one if needed).
#[tauri::command]
pub async fn repl_eval(repl: State<'_, Repl>, interpreter: String, cwd: String, code: String) -> Result<ReplReply, String> {
    let mut guard = repl.session.lock().unwrap();
    let restart = match &*guard {
        Some(s) => s.interpreter != interpreter || s.cwd != cwd,
        None => true,
    };
    if restart {
        *guard = None;
        kill_session(&repl);
        let mut cmd = command(&interpreter);
        cmd.arg("--repl").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if !cwd.is_empty() {
            cmd.current_dir(&cwd);
        }
        let mut child = cmd.spawn().map_err(|e| spawn_error(e, &interpreter))?;
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        *repl.child.lock().unwrap() = Some(child);
        *guard = Some(Session { interpreter: interpreter.clone(), cwd: cwd.clone(), stdin, stdout });
    }
    let s = guard.as_mut().unwrap();
    let mut text = String::new();
    for line in code.lines() {
        // A line that is just the marker would end the snippet early.
        if line.trim() == MARK.to_string() {
            continue;
        }
        text.push_str(line);
        text.push('\n');
    }
    text.push(MARK);
    text.push('\n');
    let sent = s.stdin.write_all(text.as_bytes()).and_then(|_| s.stdin.flush());
    if sent.is_err() {
        *guard = None;
        return Err("the Quick-try session stopped; try again".into());
    }
    let r = read_reply(s);
    if r.is_err() {
        *guard = None;
    }
    r
}

/// Reads output until the session's next reply. The reply is either the
/// snippet's result, or {"input": prompt} when INPUT is waiting for an answer.
fn read_reply(s: &mut Session) -> Result<ReplReply, String> {
    let mut output = String::new();
    loop {
        let mut line = String::new();
        match s.stdout.read_line(&mut line) {
            Ok(0) | Err(_) => {
                return Err("the Quick-try session stopped (it was reset, or the interpreter doesn't support --repl)".into());
            }
            Ok(_) => {}
        }
        if let Some(reply) = line.strip_prefix(MARK) {
            return Ok(ReplReply { output, reply: reply.trim_end().to_string() });
        }
        output.push_str(&line);
    }
}

/// Answers INPUT in the running snippet, then waits for its next reply.
#[tauri::command]
pub async fn repl_answer(repl: State<'_, Repl>, text: String) -> Result<ReplReply, String> {
    let mut guard = repl.session.lock().unwrap();
    let s = guard.as_mut().ok_or("the Quick-try session isn't running")?;
    let line = text.replace(['\n', '\r'], " ") + "\n";
    if s.stdin.write_all(line.as_bytes()).and_then(|_| s.stdin.flush()).is_err() {
        *guard = None;
        return Err("the Quick-try session stopped; try again".into());
    }
    let r = read_reply(s);
    if r.is_err() {
        *guard = None;
    }
    r
}

/// Clears the Quick-try session's variables (and stops a snippet that's stuck).
#[tauri::command]
pub fn repl_reset(repl: State<Repl>) {
    kill_session(&repl);
    if let Ok(mut g) = repl.session.try_lock() {
        *g = None;
    }
}
