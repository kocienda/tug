//! The call a process runs under: how a Bash call is marked with its id, and
//! how a child of that call reads the id back.
//!
//! `tugtool hook pre-tool-use` opens every readable Bash command with a
//! `# tug-call: <id>` line. A comment is the one carrier that is transparent
//! all the way down: the shell ignores it, Claude Code's permission check
//! reads past it (since 2.1.311 that check judges the *rewritten* command, and
//! an `export TUG_TOOL_USE_ID=<id>;` in front made every tagged call ask), and
//! Claude Code runs the call as `/bin/zsh -c '… eval <command> …'`, so the
//! marked command stands verbatim in that shell's argv. A `tugtool report`
//! three processes down — a recipe's step, a probe's child — walks up its
//! ancestors to that shell and reads the id from the mark
//! ([`ancestor_call_id`]). A probe or a harness that spawns the child itself
//! sets `TUG_TOOL_USE_ID` instead, which every reader prefers.
//!
//! Every reader of a call's command — the report-gaps record's head, the
//! deck's Bash block header — reads past the mark ([`past_call_mark`]), so
//! what is shown and grouped is what the model wrote.

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

/// The call the current process runs under, read from the nearest ancestor
/// whose argv carries a mark. `None` when no ancestor does — a process not
/// under a Bash call at all — or on a platform this cannot read.
pub fn ancestor_call_id() -> Option<String> {
    let mut pid = std::process::id() as i32;
    for _ in 0..64 {
        pid = sys::parent_of(pid)?;
        if pid <= 1 {
            return None;
        }
        if let Some(args) = sys::args_of(pid)
            && let Some(id) = call_id_in(&args)
        {
            return Some(id.to_string());
        }
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
}

#[cfg(not(target_os = "macos"))]
mod sys {
    pub fn parent_of(_pid: i32) -> Option<i32> {
        None
    }
    pub fn args_of(_pid: i32) -> Option<String> {
        None
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

    /// The child the test above spawns: prints what it reads, for the parent
    /// to assert on. Ignored so it runs only when spawned.
    #[test]
    #[ignore]
    fn prints_ancestor_call_id() {
        println!("ancestor={}", ancestor_call_id().unwrap_or_default());
    }
}
