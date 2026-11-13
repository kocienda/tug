//! Keeping a long-lived child from inheriting descriptors that are not its own.
//!
//! macOS has no `pipe2`, so the standard library makes a pipe and marks it
//! close-on-exec in two steps. A child spawned by another thread between the
//! two inherits the pipe's write end, and keeps it for as long as it lives.
//! The reader of that pipe, a `Command::output()` waiting for end of file,
//! then waits for the unrelated child to exit instead of its own.
//!
//! On 2026-11-12 that froze a session's restore. The `ps` behind the
//! terminal-liveness gate was read through such a pipe at the moment another
//! session's tugcode was spawned, so `spawn_session` never returned, the
//! client's loop stopped sending heartbeats, and the card stayed blank until
//! the page's watchdog reconnected a minute later. Twelve seconds of four
//! threads calling `output()` beside a spawn loop reproduces it a few times
//! in ten thousand calls.
//!
//! A short-lived child that inherits a stray end holds it for milliseconds.
//! The harm is a child that stays: tugcode, a shell, a helper. Those spawn
//! through [`seal_above_stdio`], which marks every descriptor above stdio
//! close-on-exec in the forked child, so nothing but its own three pipes
//! survives the exec.

/// The highest descriptor [`seal_above_stdio`] visits. Descriptors are handed
/// out lowest first, so a stray pipe end sits far below this in any process
/// that has not opened tens of thousands of files.
#[cfg(unix)]
const SEAL_CEILING: libc::c_int = 1 << 16;

/// Mark every descriptor above stdio close-on-exec.
///
/// For a `pre_exec` hook, where the standard library has already moved the
/// child's stdin, stdout and stderr onto 0, 1 and 2. It makes only `fcntl`
/// calls and allocates nothing, so it is safe between `fork` and `exec`. A
/// descriptor that is not open answers `EBADF`, which is ignored.
///
/// ```ignore
/// unsafe {
///     cmd.pre_exec(|| {
///         tugcore::child_fds::seal_above_stdio();
///         Ok(())
///     });
/// }
/// ```
#[cfg(unix)]
pub fn seal_above_stdio() {
    let limit = unsafe { libc::getdtablesize() }.clamp(3, SEAL_CEILING);
    for fd in 3..limit {
        unsafe {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
}

/// Make `cmd`'s child inherit nothing above stdio. See [`seal_above_stdio`].
#[cfg(unix)]
pub fn seal(cmd: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            seal_above_stdio();
            Ok(())
        });
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    /// A pipe whose ends are inheritable, as a pipe is in the instant before
    /// the standard library marks it. Returns `(read, write)`.
    fn inheritable_pipe() -> (libc::c_int, libc::c_int) {
        let mut fds = [0 as libc::c_int; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        (fds[0], fds[1])
    }

    /// Whether anything but the caller still holds the pipe's write end: the
    /// caller closes its own, then a non-blocking read answers end of file
    /// when no writer is left and `EAGAIN` when one is.
    fn write_end_is_held_elsewhere(read: libc::c_int, write: libc::c_int) -> bool {
        unsafe {
            libc::close(write);
            let flags = libc::fcntl(read, libc::F_GETFL);
            libc::fcntl(read, libc::F_SETFL, flags | libc::O_NONBLOCK);
            let mut byte = 0u8;
            let got = libc::read(read, &mut byte as *mut u8 as *mut libc::c_void, 1);
            libc::close(read);
            got != 0
        }
    }

    fn sleeper() -> Command {
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd
    }

    #[test]
    fn an_unsealed_child_keeps_a_stray_write_end() {
        let (read, write) = inheritable_pipe();
        let mut child = sleeper().spawn().unwrap();
        let held = write_end_is_held_elsewhere(read, write);
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(
            held,
            "the control case: an inheritable end reaches the child"
        );
    }

    #[test]
    fn a_sealed_child_inherits_nothing_above_stdio() {
        let (read, write) = inheritable_pipe();
        let mut cmd = sleeper();
        seal(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let held = write_end_is_held_elsewhere(read, write);
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!held, "a sealed child must not hold the stray write end");
    }

    #[test]
    fn a_sealed_child_still_has_its_own_stdio() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "cat; echo err >&2"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", std::env::temp_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        seal(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        {
            use std::io::Write;
            child.stdin.take().unwrap().write_all(b"in\n").unwrap();
        }
        let out = child.wait_with_output().unwrap();
        assert_eq!(out.stdout, b"in\n");
        assert_eq!(out.stderr, b"err\n");
    }
}
