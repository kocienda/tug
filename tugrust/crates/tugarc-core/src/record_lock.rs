//! The one lock every work record is written under.
//!
//! Each writer of a cycle, a sketch or a brief reads the record, changes it
//! and writes it whole, and the write replaces the file, so two writers that
//! both read before either wrote would leave only the second one's change.
//! [`hold`] closes that: a writer holds an exclusive `flock` for the length of
//! one read, change and write. The lock is on a sibling file, never on the
//! record itself, because the write renames a new file into place and a lock
//! on the old one would guard nothing.
//!
//! Locks are taken in one order and never the reverse: a cycle record's lock,
//! then the brief store's minting lock, then one brief record's lock, then
//! the work log's. A function that needs an earlier lock after a later one
//! releases the later first.

use std::fs;
use std::os::fd::AsRawFd;
use std::path::Path;

use crate::error::ArcError;

/// How [`hold`] waits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockMode {
    /// Block until the lock is free.
    Wait,
    /// Take the lock only if it is free now. A reader that holds another
    /// record's lock uses this, so two processes each holding one record and
    /// reaching for the other's cannot wait on each other.
    Try,
}

/// A held lock. Dropping it closes the file, and the kernel releases the lock.
#[derive(Debug)]
pub struct Held {
    _file: fs::File,
}

/// Hold `<dir>/<lock_name>` exclusively. The directory must exist.
///
/// [`LockMode::Wait`] always returns `Some`; [`LockMode::Try`] returns
/// `Ok(None)` when another holder has the lock.
pub fn hold(dir: &Path, lock_name: &str, mode: LockMode) -> Result<Option<Held>, ArcError> {
    let path = dir.join(lock_name);
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|e| ArcError::io("could not open the record's lock", &path, e))?;
    let op = match mode {
        LockMode::Wait => libc::LOCK_EX,
        LockMode::Try => libc::LOCK_EX | libc::LOCK_NB,
    };
    // SAFETY: `flock` takes the descriptor of a file this function owns and
    // keeps open; the kernel releases the lock when the file is closed.
    if unsafe { libc::flock(file.as_raw_fd(), op) } != 0 {
        let err = std::io::Error::last_os_error();
        if mode == LockMode::Try && err.raw_os_error() == Some(libc::EWOULDBLOCK) {
            return Ok(None);
        }
        return Err(ArcError::io("could not lock the record", &path, err));
    }
    Ok(Some(Held { _file: file }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use tempfile::TempDir;

    #[test]
    fn a_try_is_refused_while_another_holds_and_granted_after() {
        let temp = TempDir::new().unwrap();
        let dir = temp.path();
        let (taken_tx, taken_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        std::thread::scope(|scope| {
            scope.spawn(move || {
                let held = hold(dir, "x.lock", LockMode::Wait).unwrap();
                assert!(held.is_some());
                taken_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                drop(held);
            });
            taken_rx.recv().unwrap();
            assert!(
                hold(dir, "x.lock", LockMode::Try).unwrap().is_none(),
                "a try while the lock is held takes nothing"
            );
            release_tx.send(()).unwrap();
        });
        assert!(hold(dir, "x.lock", LockMode::Try).unwrap().is_some());
    }
}
