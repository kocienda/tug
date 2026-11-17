//! The call a process runs under: how a Bash call's id is kept, and how a
//! child of that call reads it back.
//!
//! **The id never rides the command Claude Code runs.** `tugtool hook
//! pre-tool-use` writes a *call record* instead ([`record_call`]): one small
//! file per Bash call, `<calls-dir>/<claude-pid>/<tool-use-id>`, holding the
//! command's text. Claude Code runs the call as `/bin/zsh -c '… eval
//! <command> …'`, a child of the `claude` process, so the command stands in
//! that shell's argv. A `tugtool report` three processes down — a recipe's
//! step, a probe's child — walks up its ancestors to the `claude` process
//! that has a record directory and takes the record whose command one of the
//! shells on the way carries ([`ancestor_call_id`]).
//!
//! It was in the command twice before. First as an `export
//! TUG_TOOL_USE_ID=<id>;`, until Claude Code 2.1.311 judged permission on the
//! rewritten command and every tagged call asked. Then as a leading
//! `# tug-call: <id>` comment, until auto mode began refusing any call whose
//! input a hook changed after its classifier had reviewed it: every call the
//! classifier saw came back unrun, to be issued a second time. No carrier
//! inside the input survives a check that compares the input, so the hook
//! changes a command only where it also allows it (a runner's wrap).
//!
//! The mark is still read, and read first: tugcast's engine puts one on the
//! commands it runs itself (a re-audit's checks, through `tugtool report
//! rewrite --call`), where no hook wrote a record, and transcripts recorded
//! while the hook marked commands carry it. A probe or a harness that spawns
//! the child itself sets `TUG_TOOL_USE_ID` instead, which every reader
//! prefers. Every reader of a call's command — the report-gaps record's
//! head, the deck's Bash block header — reads past the mark
//! ([`past_call_mark`]), so what is shown and grouped is what the model wrote.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The mark's text up to the id. The line is `# tug-call: <id>` and a newline.
pub const CALL_MARK: &str = "# tug-call: ";

/// The mark line for `id`, newline included.
pub fn call_mark(id: &str) -> String {
    format!("{CALL_MARK}{id}\n")
}

/// Letters, digits, `.`, `_`, `-`: the shape of an id the hook puts in a mark.
fn is_id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

/// The id a command's leading mark carries, when it opens with one.
pub fn marked_call_id(command: &str) -> Option<&str> {
    let rest = command.strip_prefix(CALL_MARK)?;
    let end = rest.find(|c: char| !is_id_char(c)).unwrap_or(rest.len());
    let id = &rest[..end];
    let line_ends = matches!(rest[end..].chars().next(), None | Some('\n') | Some('\r'));
    (!id.is_empty() && line_ends).then_some(id)
}

/// `command` past its leading mark line, else as given.
pub fn past_call_mark(command: &str) -> &str {
    if marked_call_id(command).is_none() {
        return command;
    }
    match command.split_once('\n') {
        Some((_, rest)) => rest,
        None => "",
    }
}

/// The id of the first mark anywhere in `text` — a shell's argv, where the
/// mark sits inside whatever quoting the spawner wrapped the command in.
pub fn call_id_in(text: &str) -> Option<&str> {
    text.match_indices(CALL_MARK)
        .find_map(|(at, _)| marked_call_id(&text[at..]))
}

/// Environment variable relocating the call records, for test isolation.
pub const ENV_CALLS_DIR: &str = "TUG_CALLS_DIR";

/// How long a call record is kept. A Bash call the harness moved to the
/// background may run two hours, so a record outlives that and no more.
const RECORD_TTL: Duration = Duration::from_secs(3 * 60 * 60);

/// Where call records live: `<data-dir>/calls`, one directory per `claude`
/// process. Machine-global, since the reader knows only its ancestors.
pub fn calls_dir() -> PathBuf {
    match std::env::var_os(ENV_CALLS_DIR).filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => crate::instance::base_data_dir().join("calls"),
    }
}

/// The `claude` process the current process — the hook — runs under: the
/// `CLAUDE_PID` Claude Code exports when it is an ancestor, else the nearest
/// ancestor whose executable is named `claude`. `None` outside one.
pub fn claude_pid() -> Option<i32> {
    let ancestors = ancestors_of_self();
    let exported = std::env::var("CLAUDE_PID")
        .ok()
        .and_then(|v| v.trim().parse::<i32>().ok());
    if let Some(pid) = exported
        && ancestors.iter().any(|(p, _)| *p == pid)
    {
        return Some(pid);
    }
    ancestors.into_iter().find_map(|(pid, args)| {
        let exe = args.split_whitespace().next()?;
        (exe.rsplit('/').next() == Some("claude")).then_some(pid)
    })
}

/// Record that the `claude` process `claude_pid` is about to run `command`
/// as the call `id`, in [`calls_dir`]. The hook's one write, made before the
/// call's shell exists, so every descendant of that shell finds it.
pub fn record_call(claude_pid: i32, id: &str, command: &str) -> std::io::Result<()> {
    record_call_in(&calls_dir(), claude_pid, id, command)
}

/// [`record_call`] under a given root. Prunes as it goes: this process's
/// records past [`RECORD_TTL`], and the directory of any `claude` process
/// that is gone.
pub fn record_call_in(
    root: &Path,
    claude_pid: i32,
    id: &str,
    command: &str,
) -> std::io::Result<()> {
    if id.is_empty() || !id.chars().all(is_id_char) {
        return Ok(());
    }
    let dir = root.join(claude_pid.to_string());
    std::fs::create_dir_all(&dir)?;
    prune(root, &dir);
    std::fs::write(dir.join(id), command)
}

fn prune(root: &Path, own: &Path) {
    let now = SystemTime::now();
    for entry in std::fs::read_dir(own).into_iter().flatten().flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|age| age > RECORD_TTL);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let path = entry.path();
        let pid = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.parse::<i32>().ok());
        if let Some(pid) = pid
            && path != own
            && !sys::is_alive(pid)
        {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// A command, or an argv holding one, with everything a shell's quoting adds
/// or takes away removed: quotes, backslashes and whitespace. Claude Code
/// single-quotes the command for `eval`, so the two sides agree only here.
fn unquoted(text: &str) -> String {
    text.chars()
        .filter(|c| !matches!(c, '\'' | '"' | '\\') && !c.is_whitespace())
        .collect()
}

/// The call recorded for `claude_pid` whose command one of `argvs` carries:
/// the longest such command, so `ls` is not read into `ls -la`, and the
/// newest among equals.
pub fn recorded_call_id(root: &Path, claude_pid: i32, argvs: &[String]) -> Option<String> {
    let dir = root.join(claude_pid.to_string());
    let argvs: Vec<String> = argvs.iter().map(|a| unquoted(a)).collect();
    let now = SystemTime::now();
    let mut best: Option<(usize, SystemTime, String)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(at) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if now.duration_since(at).is_ok_and(|age| age > RECORD_TTL) {
            continue;
        }
        let Ok(command) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let needle = unquoted(&command);
        if needle.is_empty() || !argvs.iter().any(|argv| argv.contains(&needle)) {
            continue;
        }
        let key = (needle.len(), at);
        if best
            .as_ref()
            .is_none_or(|(len, when, _)| key > (*len, *when))
        {
            best = Some((key.0, key.1, id));
        }
    }
    best.map(|(_, _, id)| id)
}

/// The current process's ancestors, nearest first, each with its argv.
fn ancestors_of_self() -> Vec<(i32, String)> {
    let mut out = Vec::new();
    let mut pid = std::process::id() as i32;
    for _ in 0..64 {
        match sys::parent_of(pid) {
            Some(parent) if parent > 1 => pid = parent,
            _ => break,
        }
        out.push((pid, sys::args_of(pid).unwrap_or_default()));
    }
    out
}

/// The call the current process runs under. Walking up the ancestors: one
/// whose argv carries a mark names the call outright; one that has a record
/// directory is the `claude` process, and the call is the record whose
/// command a shell passed on the way carries. `None` when neither is found —
/// a process not under a Bash call at all — or on a platform this cannot read.
pub fn ancestor_call_id() -> Option<String> {
    let root = calls_dir();
    let mut argvs: Vec<String> = Vec::new();
    for (pid, args) in ancestors_of_self() {
        if let Some(id) = call_id_in(&args) {
            return Some(id.to_string());
        }
        if !argvs.is_empty()
            && root.join(pid.to_string()).is_dir()
            && let Some(id) = recorded_call_id(&root, pid, &argvs)
        {
            return Some(id);
        }
        argvs.push(args);
    }
    None
}

#[cfg(target_os = "macos")]
mod sys {
    use std::mem;

    /// The parent of `pid`, from the kernel's BSD process info.
    pub fn parent_of(pid: i32) -> Option<i32> {
        let mut info: libc::proc_bsdinfo = unsafe { mem::zeroed() };
        let size = mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let got = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut _ as *mut libc::c_void,
                size,
            )
        };
        (got == size).then_some(info.pbi_ppid as i32)
    }

    /// The argv of `pid`, space-joined, from `KERN_PROCARGS2`: a leading
    /// `argc`, the executable path, padding, then the arguments, each
    /// NUL-terminated. Readable for the caller's own processes, which every
    /// ancestor under a Bash call is.
    pub fn args_of(pid: i32) -> Option<String> {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        let mut size: libc::size_t = 0;
        let rc = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as libc::c_uint,
                std::ptr::null_mut(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 || size < 4 {
            return None;
        }
        let mut buf = vec![0u8; size];
        let rc = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as libc::c_uint,
                buf.as_mut_ptr() as *mut libc::c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 || size < 4 {
            return None;
        }
        buf.truncate(size);
        let argc = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        let mut rest = &buf[4..];
        // The executable path, then the NULs that pad it.
        let path_end = rest.iter().position(|&b| b == 0)?;
        rest = &rest[path_end..];
        let first = rest.iter().position(|&b| b != 0)?;
        rest = &rest[first..];
        let args: Vec<String> = rest
            .split(|&b| b == 0)
            .take(argc)
            .map(|a| String::from_utf8_lossy(a).into_owned())
            .collect();
        Some(args.join(" "))
    }

    /// Whether `pid` names a live process: a signal 0 reaches it, or is
    /// refused for a reason other than its absence.
    pub fn is_alive(pid: i32) -> bool {
        if unsafe { libc::kill(pid, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    pub fn parent_of(_pid: i32) -> Option<i32> {
        None
    }
    pub fn args_of(_pid: i32) -> Option<String> {
        None
    }
    pub fn is_alive(_pid: i32) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mark_is_read_and_read_past() {
        let marked = call_mark("toolu_01A") + "cd tugrust && cargo nextest run";
        assert_eq!(marked_call_id(&marked), Some("toolu_01A"));
        assert_eq!(past_call_mark(&marked), "cd tugrust && cargo nextest run");
        assert_eq!(marked_call_id("cargo test"), None);
        assert_eq!(past_call_mark("cargo test"), "cargo test");
        // A comment the model wrote is not a mark.
        assert_eq!(marked_call_id("# build first\ncargo test"), None);
        // A mark with no newline after it marks an empty command.
        assert_eq!(marked_call_id("# tug-call: toolu_01A"), Some("toolu_01A"));
        assert_eq!(past_call_mark("# tug-call: toolu_01A"), "");
        // Anything but an id word after the mark is not one.
        assert_eq!(
            marked_call_id("# tug-call: toolu_01A; rm -rf /\necho"),
            None
        );
        assert_eq!(marked_call_id("# tug-call: \necho"), None);
    }

    #[test]
    fn the_id_is_found_inside_a_shells_argv() {
        let argv = "/bin/zsh -c source snap.sh 2>/dev/null || true && eval '# tug-call: toolu_01F8W\ncargo test' < /dev/null";
        assert_eq!(call_id_in(argv), Some("toolu_01F8W"));
        assert_eq!(call_id_in("/bin/sh -c cargo test"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_child_of_a_marked_shell_reads_the_shells_call() {
        // This test process is not under a Bash call of its own — or if the
        // developer ran it from one, the mark it finds is that call's, so the
        // walk is proven on a shell this test spawns, which is nearer.
        //
        // The shell is given a second command: `sh -c` with one simple command
        // execs it in its own place, argv and mark gone. Claude Code's wrapper
        // is a `&&` chain for the same reason it persists.
        let exe = std::env::current_exe().unwrap();
        let script = format!(
            "# tug-call: toolu_ancestor\n{} --exact call_id::tests::prints_ancestor_call_id --nocapture --ignored && :",
            exe.display()
        );
        let home = tempfile::tempdir().unwrap();
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&script)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", home.path())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("ancestor=toolu_ancestor"),
            "{stdout}\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn a_record_is_matched_through_the_shells_quoting() {
        let root = tempfile::tempdir().unwrap();
        let command = "echo \"it's\" $x; ls -la";
        record_call_in(root.path(), 4242, "toolu_long", command).unwrap();
        record_call_in(root.path(), 4242, "toolu_short", "ls").unwrap();
        record_call_in(root.path(), 4242, "toolu_other", "cargo build").unwrap();
        // Claude Code's argv: the command single-quoted for `eval`, its own
        // single quote closed, double-quoted and reopened.
        let argv = "/bin/zsh -c source snap.sh || true && eval 'echo \"it'\"'\"'s\" $x; ls -la' < /dev/null".to_string();
        assert_eq!(
            recorded_call_id(root.path(), 4242, std::slice::from_ref(&argv)).as_deref(),
            Some("toolu_long"),
            "the longest command an argv carries is the call"
        );
        // Another process's records are not this one's.
        assert_eq!(recorded_call_id(root.path(), 4243, &[argv]), None);
        // An argv carrying no recorded command names no call.
        assert_eq!(
            recorded_call_id(root.path(), 4242, &["/bin/zsh -c make".to_string()]),
            None
        );
        // An id that is not an id word is never a file name.
        record_call_in(root.path(), 4242, "../escape", "make").unwrap();
        assert!(!root.path().join("escape").exists());
    }

    #[test]
    fn recording_removes_the_records_of_a_process_that_is_gone() {
        let root = tempfile::tempdir().unwrap();
        // A pid no process has: past the kernel's ceiling.
        let gone = 99_999_999;
        record_call_in(root.path(), gone, "toolu_old", "ls").unwrap();
        let own = std::process::id() as i32;
        record_call_in(root.path(), own, "toolu_new", "ls").unwrap();
        assert!(!root.path().join(gone.to_string()).exists());
        assert!(root.path().join(own.to_string()).join("toolu_new").exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_child_of_an_unmarked_shell_reads_the_call_from_its_record() {
        // This test process stands in for `claude`: the record is under its
        // pid, and the shell it spawns carries the command and no mark.
        let exe = std::env::current_exe().unwrap();
        let script = format!(
            "{} --exact call_id::tests::prints_ancestor_call_id --nocapture --ignored && :",
            exe.display()
        );
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        record_call_in(
            root.path(),
            std::process::id() as i32,
            "toolu_recorded",
            &script,
        )
        .unwrap();
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&script)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", home.path())
            .env(ENV_CALLS_DIR, root.path())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("ancestor=toolu_recorded"),
            "{stdout}\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// The child the test above spawns: prints what it reads, for the parent
    /// to assert on. Ignored so it runs only when spawned.
    #[test]
    #[ignore]
    fn prints_ancestor_call_id() {
        println!("ancestor={}", ancestor_call_id().unwrap_or_default());
    }
}
