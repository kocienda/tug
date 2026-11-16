//! Orderly relaunch helper for Tug.app
//!
//! 1. SIGNAL: Send SIGTERM to running Tug.app
//! 2. WAIT: kqueue wait for process exit (with SIGKILL fallback)
//! 3. RELAUNCH: Open app bundle (with retry for Launch Services -600)

use clap::Parser;
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixListener;
use tokio::time::timeout;

// ============================================================================
// CLI
// ============================================================================

#[derive(Parser, Debug)]
#[command(name = "tugrelaunch")]
#[command(version)]
#[command(about = "Orderly relaunch helper for Tug.app")]
struct Cli {
    /// Path to the Tug.app bundle
    #[arg(long)]
    app_bundle: PathBuf,

    /// PID of the Tug.app process to signal
    #[arg(long)]
    pid: u32,

    /// Optional UDS socket path for progress reporting
    #[arg(long)]
    progress_socket: Option<PathBuf>,
}

// ============================================================================
// Progress Protocol
// ============================================================================

/// Progress writer wraps an optional UDS connection
struct ProgressWriter {
    stream: Option<tokio::net::UnixStream>,
}

impl ProgressWriter {
    fn noop() -> Self {
        Self { stream: None }
    }

    async fn send(&mut self, stage: &str, status: &str, error: Option<&str>) {
        if let Some(stream) = &mut self.stream {
            let msg = progress_json(stage, status, error);
            let line = format!("{}\n", msg);
            let _ = stream.write_all(line.as_bytes()).await;
        }
    }
}

fn progress_json(stage: &str, status: &str, error: Option<&str>) -> String {
    let mut obj = json!({
        "stage": stage,
        "status": status,
    });
    if let Some(err) = error {
        obj["error"] = json!(err);
    }
    obj.to_string()
}

async fn setup_progress_socket(socket_path: &PathBuf) -> ProgressWriter {
    // Remove existing socket if present
    let _ = std::fs::remove_file(socket_path);

    // Bind listener
    let listener = match UnixListener::bind(socket_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!(
                "tugrelaunch: warning: failed to bind progress socket: {}",
                e
            );
            return ProgressWriter { stream: None };
        }
    };

    // Accept one connection with 5-second timeout
    let stream = match timeout(Duration::from_secs(5), listener.accept()).await {
        Ok(Ok((stream, _))) => Some(stream),
        Ok(Err(e)) => {
            eprintln!(
                "tugrelaunch: warning: failed to accept progress connection: {}",
                e
            );
            None
        }
        Err(_) => {
            eprintln!("tugrelaunch: warning: timeout waiting for progress connection");
            None
        }
    };

    ProgressWriter { stream }
}

fn cleanup_socket(socket_path: &PathBuf) {
    let _ = std::fs::remove_file(socket_path);
}

// ============================================================================
// Signal Phase
// ============================================================================

fn signal_process(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

// ============================================================================
// Wait Phase (kqueue)
// ============================================================================

#[cfg(target_os = "macos")]
fn wait_for_exit(pid: u32) {
    use std::mem::MaybeUninit;

    unsafe {
        // Create kqueue
        let kq = libc::kqueue();
        if kq < 0 {
            eprintln!("tugrelaunch: warning: kqueue() failed, cannot wait for exit");
            return;
        }

        // Set up kevent for EVFILT_PROC/NOTE_EXIT
        let mut kev = MaybeUninit::<libc::kevent>::zeroed().assume_init();
        kev.ident = pid as usize;
        kev.filter = libc::EVFILT_PROC;
        kev.flags = libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT;
        kev.fflags = libc::NOTE_EXIT;
        kev.data = 0;
        kev.udata = std::ptr::null_mut();

        // Register the event
        let ret = libc::kevent(kq, &kev, 1, std::ptr::null_mut(), 0, std::ptr::null());
        if ret < 0 {
            eprintln!("tugrelaunch: warning: kevent() registration failed");
            libc::close(kq);
            return;
        }

        // Wait for event with 10-second timeout
        let mut out_kev = MaybeUninit::<libc::kevent>::zeroed().assume_init();
        let timeout_spec = libc::timespec {
            tv_sec: 10,
            tv_nsec: 0,
        };

        let ret = libc::kevent(kq, std::ptr::null(), 0, &mut out_kev, 1, &timeout_spec);

        if ret == 0 {
            // Timeout -- process didn't exit within 10 seconds, send SIGKILL
            eprintln!(
                "tugrelaunch: process {} did not exit within 10s, sending SIGKILL",
                pid
            );
            libc::kill(pid as i32, libc::SIGKILL);

            // Wait again with shorter timeout
            let short_timeout = libc::timespec {
                tv_sec: 2,
                tv_nsec: 0,
            };
            libc::kevent(kq, std::ptr::null(), 0, &mut out_kev, 1, &short_timeout);
        }

        libc::close(kq);
    }
}

#[cfg(not(target_os = "macos"))]
fn wait_for_exit(_pid: u32) {
    eprintln!("tugrelaunch: wait_for_exit only supported on macOS");
}

// ============================================================================
// Relaunch Phase
// ============================================================================

fn relaunch_app(app_bundle: &PathBuf) -> Result<(), String> {
    // Retry with delay: Launch Services may return -600 (procNotFound) if the
    // previous instance hasn't fully deregistered yet after SIGTERM.
    for attempt in 1..=5 {
        let output = std::process::Command::new("open")
            .arg(app_bundle)
            .output()
            .map_err(|e| format!("Failed to run open: {}", e))?;

        if output.status.success() {
            return Ok(());
        }

        if attempt < 5 {
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    Err("open failed after 5 attempts".to_string())
}

// ============================================================================
// Main
// ============================================================================

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    // Set up progress socket if requested
    let mut progress = if let Some(ref socket_path) = cli.progress_socket {
        setup_progress_socket(socket_path).await
    } else {
        ProgressWriter::noop()
    };

    // Phase 1: SIGNAL
    progress.send("relaunch", "quitting", None).await;
    signal_process(cli.pid);

    // Phase 2: WAIT
    wait_for_exit(cli.pid);

    // Phase 3: RELAUNCH
    if let Err(e) = relaunch_app(&cli.app_bundle) {
        eprintln!("tugrelaunch: error: relaunch failed: {}", e);
        if let Some(ref socket_path) = cli.progress_socket {
            cleanup_socket(socket_path);
        }
        std::process::exit(1);
    }

    progress.send("relaunch", "done", None).await;
    if let Some(ref socket_path) = cli.progress_socket {
        cleanup_socket(socket_path);
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cli_parsing_accepts_required_arguments() {
        let cli = Cli::try_parse_from([
            "tugrelaunch",
            "--app-bundle",
            "/path/to/app",
            "--pid",
            "12345",
        ]);

        assert!(cli.is_ok());
        let cli = cli.unwrap();
        assert_eq!(cli.app_bundle, PathBuf::from("/path/to/app"));
        assert_eq!(cli.pid, 12345);
        assert!(cli.progress_socket.is_none());
    }

    #[test]
    fn test_cli_parsing_accepts_optional_progress_socket() {
        let cli = Cli::try_parse_from([
            "tugrelaunch",
            "--app-bundle",
            "/path/to/app",
            "--pid",
            "12345",
            "--progress-socket",
            "/tmp/progress.sock",
        ]);

        assert!(cli.is_ok());
        let cli = cli.unwrap();
        assert_eq!(
            cli.progress_socket,
            Some(PathBuf::from("/tmp/progress.sock"))
        );
    }

    #[test]
    fn test_cli_parsing_fails_on_missing_arguments() {
        let result = Cli::try_parse_from(["tugrelaunch"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_progress_message_serialization_stage_and_status() {
        let msg = progress_json("relaunch", "quitting", None);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();

        assert_eq!(parsed["stage"], "relaunch");
        assert_eq!(parsed["status"], "quitting");
        assert!(parsed["error"].is_null());
    }

    #[test]
    fn test_progress_message_serialization_with_error() {
        let msg = progress_json("relaunch", "failed", Some("open failed"));
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();

        assert_eq!(parsed["stage"], "relaunch");
        assert_eq!(parsed["status"], "failed");
        assert_eq!(parsed["error"], "open failed");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_signal_sending_to_child_process() {
        let mut child = std::process::Command::new("sleep")
            .arg("10")
            .spawn()
            .unwrap();

        let pid = child.id();
        signal_process(pid);

        let status = child.wait().unwrap();
        assert!(!status.success());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_kqueue_wait_for_short_lived_process() {
        use std::io::Read;
        use std::os::fd::AsRawFd;

        // The child writes a line and then exits, so once wait_for_exit
        // returns the line is already in the pipe. (A try_wait() here raced:
        // NOTE_EXIT can arrive a moment before the zombie is reapable by
        // waitpid(WNOHANG).)
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 0.1; echo exited"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", std::env::temp_dir())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();

        let pid = child.id();
        wait_for_exit(pid);

        // A non-blocking read: the line is there only if wait_for_exit waited.
        let mut stdout = child.stdout.take().unwrap();
        unsafe {
            let fd = stdout.as_raw_fd();
            let flags = libc::fcntl(fd, libc::F_GETFL);
            libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        let mut buf = [0u8; 16];
        let n = stdout.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"exited\n");

        // A clean exit: the timeout path's SIGKILL never ran.
        assert!(child.wait().unwrap().success());
    }
}
