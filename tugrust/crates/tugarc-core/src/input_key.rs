//! The content key of a worktree's input paths: one hash that names the bytes
//! a check reads, as the working tree holds them.
//!
//! A clean tracked file contributes its index blob; a file whose working
//! bytes differ from the index, and a file git neither tracks nor ignores,
//! contribute the blob id `git hash-object` gives those bytes (without `-w`,
//! so nothing is written). The id is the one the file would have once
//! committed, so a dirty tree and the commit made from it share a key. A file
//! deleted from the working tree contributes nothing, because nothing is
//! there to read, and an ignored file never counts.
//!
//! Every git it runs comes through [`tugcore::git_command`], which takes no
//! optional locks, so computing a key touches neither the index nor the
//! worktree. Pathspecs are literal: a declared input names a file or a
//! directory by path component, the same boundary a surface's `paths` keeps.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};

use sha2::{Digest, Sha256};

use crate::error::ArcError;

/// The key over `inputs` in `worktree`: a 64-character hex SHA-256.
///
/// `inputs` are repo-relative paths, each a file or a directory; an empty
/// list means the whole tree. The list itself is part of the key, so the same
/// bytes read through two different declarations never share one; a trailing
/// slash is not a difference.
pub fn input_key(worktree: &Path, inputs: &[String]) -> Result<String, ArcError> {
    // `src` and `src/` name one directory, as they do in a surface's `paths`.
    let mut inputs: Vec<&str> = inputs
        .iter()
        .map(|s| s.trim_end_matches('/'))
        .filter(|s| !s.is_empty())
        .collect();
    inputs.sort_unstable();
    inputs.dedup();

    // path -> (mode, object id). Stage entries of an unmerged path each keep
    // their own row, keyed by the stage, so a conflict is never one blob.
    let mut entries: BTreeMap<String, (String, String)> = BTreeMap::new();
    for record in split_nul(&run(worktree, &["ls-files", "-s", "-z"], &inputs)?) {
        // `<mode> <object> <stage>\t<path>`
        let Some((meta, path)) = record.split_once('\t') else {
            continue;
        };
        let mut fields = meta.split(' ');
        let (Some(mode), Some(object), Some(stage)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let key = if stage == "0" {
            path.to_string()
        } else {
            format!("{path}\0{stage}")
        };
        entries.insert(key, (mode.to_string(), object.to_string()));
    }

    // What the working tree holds differently from the index.
    let status = run(
        worktree,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
        &inputs,
    )?;
    let mut rehash: Vec<String> = Vec::new();
    for record in split_nul(&status) {
        if record.len() < 4 {
            continue;
        }
        let (xy, path) = record.split_at(3);
        let worktree_state = xy.as_bytes()[1];
        let full = worktree.join(path);
        let meta = std::fs::symlink_metadata(&full);
        match meta {
            // Gone from the working tree: there is nothing for a check to read.
            Err(_) => {
                entries.retain(|k, _| k != path && !k.starts_with(&format!("{path}\0")));
            }
            // A submodule's working tree is its own repository; its gitlink
            // in the index is the honest record of it.
            Ok(m) if m.is_dir() => {}
            Ok(_) if worktree_state != b' ' => rehash.push(path.to_string()),
            // Staged but unchanged since: the index blob is the working bytes.
            Ok(_) => {}
        }
    }

    if !rehash.is_empty() {
        let ids = hash_objects(worktree, &rehash)?;
        for (path, id) in rehash.into_iter().zip(ids) {
            let mode = working_mode(&worktree.join(&path));
            entries.retain(|k, _| !k.starts_with(&format!("{path}\0")));
            entries.insert(path, (mode.to_string(), id));
        }
    }

    let mut hasher = Sha256::new();
    for input in &inputs {
        hasher.update(b"input\0");
        hasher.update(input.as_bytes());
        hasher.update(b"\0");
    }
    for (path, (mode, object)) in &entries {
        hasher.update(mode.as_bytes());
        hasher.update(b" ");
        hasher.update(object.as_bytes());
        hasher.update(b"\t");
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Git's own mode word for a working file, as the index would record it.
fn working_mode(path: &Path) -> &'static str {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => "120000",
        Ok(m) => {
            use std::os::unix::fs::PermissionsExt as _;
            if m.permissions().mode() & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            }
        }
        Err(_) => "100644",
    }
}

/// The blob id of each path's working bytes, in order, writing nothing.
///
/// `--stdin-paths` reads one path a line, so a name holding a newline is
/// hashed on its own as an operand instead.
fn hash_objects(worktree: &Path, paths: &[String]) -> Result<Vec<String>, ArcError> {
    let mut ids: Vec<Option<String>> = vec![None; paths.len()];
    let batch: Vec<usize> = (0..paths.len())
        .filter(|&i| !paths[i].contains('\n'))
        .collect();
    if !batch.is_empty() {
        let mut input = String::new();
        for &i in &batch {
            input.push_str(&paths[i]);
            input.push('\n');
        }
        let out = git_with_stdin(worktree, &["hash-object", "--stdin-paths"], &input)?;
        let lines: Vec<&str> = out.lines().collect();
        if lines.len() != batch.len() {
            return Err(git_error(
                "git hash-object returned the wrong number of ids",
                &["hash-object", "--stdin-paths"],
                "",
            ));
        }
        for (&i, id) in batch.iter().zip(lines) {
            ids[i] = Some(id.trim().to_string());
        }
    }
    for (i, path) in paths.iter().enumerate() {
        if ids[i].is_none() {
            let out = run(worktree, &["hash-object", "--"], &[path.as_str()])?;
            ids[i] = Some(out.trim().to_string());
        }
    }
    Ok(ids.into_iter().map(Option::unwrap_or_default).collect())
}

fn command(worktree: &Path, args: &[&str], paths: &[&str]) -> Command {
    let mut cmd = tugcore::git_command();
    cmd.arg("-C").arg(worktree).args(args);
    if !paths.is_empty() && args.first() != Some(&"hash-object") {
        cmd.arg("--");
    }
    cmd.args(paths);
    cmd
}

fn run(worktree: &Path, args: &[&str], paths: &[&str]) -> Result<String, ArcError> {
    let out = command(worktree, args, paths)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| git_error("git could not be run", args, &e.to_string()))?;
    if !out.status.success() {
        return Err(git_error(
            &format!("git {} failed", args[0]),
            args,
            String::from_utf8_lossy(&out.stderr).trim(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn git_with_stdin(worktree: &Path, args: &[&str], input: &str) -> Result<String, ArcError> {
    let mut child = command(worktree, args, &[])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| git_error("git could not be run", args, &e.to_string()))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let input = input.to_string();
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let out = child
        .wait_with_output()
        .map_err(|e| git_error("git could not be run", args, &e.to_string()))?;
    let _ = writer.join();
    if !out.status.success() {
        return Err(git_error(
            &format!("git {} failed", args[0]),
            args,
            String::from_utf8_lossy(&out.stderr).trim(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn git_error(what: &str, args: &[&str], stderr: &str) -> ArcError {
    ArcError::Git {
        what: what.to_string(),
        args: args.iter().map(|s| s.to_string()).collect(),
        stderr: stderr.to_string(),
    }
}

fn split_nul(text: &str) -> impl Iterator<Item = &str> {
    text.split('\0').filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tugcore::test_fixtures::git::GitFixture;

    fn repo() -> (tempfile::TempDir, GitFixture) {
        let dir = tempfile::tempdir().expect("tempdir");
        let fx = GitFixture::init(&dir.path().join("repo"));
        fs::create_dir_all(fx.root().join("src")).unwrap();
        fs::create_dir_all(fx.root().join("docs")).unwrap();
        fs::write(fx.root().join("src/a.rs"), "fn a() {}\n").unwrap();
        fs::write(fx.root().join("src/b.rs"), "fn b() {}\n").unwrap();
        fs::write(fx.root().join("docs/notes.md"), "notes\n").unwrap();
        fs::write(fx.root().join(".gitignore"), "target/\n").unwrap();
        fx.git(&["add", "-A"]);
        fx.git(&["commit", "-q", "-m", "seed"]);
        (dir, fx)
    }

    fn key(fx: &GitFixture, inputs: &[&str]) -> String {
        let inputs: Vec<String> = inputs.iter().map(|s| s.to_string()).collect();
        input_key(fx.root(), &inputs).expect("key")
    }

    #[test]
    fn a_dirty_tree_and_the_commit_made_from_it_share_a_key() {
        let (_d, fx) = repo();
        fs::write(fx.root().join("src/a.rs"), "fn a() { 1; }\n").unwrap();
        fs::write(fx.root().join("src/c.rs"), "fn c() {}\n").unwrap();
        fs::remove_file(fx.root().join("src/b.rs")).unwrap();
        let dirty_whole = key(&fx, &[]);
        let dirty_src = key(&fx, &["src/"]);

        fx.git(&["add", "-A"]);
        let staged = key(&fx, &["src/"]);
        fx.git(&["commit", "-q", "-m", "round"]);

        assert_eq!(dirty_src, staged);
        assert_eq!(dirty_src, key(&fx, &["src/"]));
        assert_eq!(dirty_whole, key(&fx, &[]));
    }

    #[test]
    fn an_edit_an_addition_or_a_deletion_under_the_inputs_moves_the_key() {
        let (_d, fx) = repo();
        let clean = key(&fx, &["src"]);

        fs::write(fx.root().join("src/a.rs"), "fn a() { 2; }\n").unwrap();
        let edited = key(&fx, &["src"]);
        assert_ne!(clean, edited);
        fx.git(&["checkout", "--", "src/a.rs"]);
        assert_eq!(clean, key(&fx, &["src"]));

        fs::write(fx.root().join("src/new.rs"), "fn n() {}\n").unwrap();
        assert_ne!(clean, key(&fx, &["src"]));
        fs::remove_file(fx.root().join("src/new.rs")).unwrap();
        assert_eq!(clean, key(&fx, &["src"]));

        fs::remove_file(fx.root().join("src/b.rs")).unwrap();
        assert_ne!(clean, key(&fx, &["src"]));
    }

    #[test]
    fn a_change_outside_the_inputs_leaves_the_key_alone() {
        let (_d, fx) = repo();
        let clean = key(&fx, &["src/"]);
        fs::write(fx.root().join("docs/notes.md"), "rewritten\n").unwrap();
        fs::write(fx.root().join("stray.txt"), "scratch\n").unwrap();
        assert_eq!(clean, key(&fx, &["src/"]));
        // A name that merely starts with an input is outside it.
        fs::write(fx.root().join("srcx"), "neighbour\n").unwrap();
        assert_eq!(clean, key(&fx, &["src"]));
        // The whole tree sees all of it.
        let with_stray = key(&fx, &[]);
        fs::remove_file(fx.root().join("stray.txt")).unwrap();
        assert_ne!(with_stray, key(&fx, &[]));
    }

    #[test]
    fn an_ignored_file_never_counts() {
        let (_d, fx) = repo();
        let clean = key(&fx, &[]);
        fs::create_dir_all(fx.root().join("target")).unwrap();
        fs::write(fx.root().join("target/out.o"), "artifact\n").unwrap();
        assert_eq!(clean, key(&fx, &[]));
    }

    #[test]
    fn a_mode_change_moves_the_key() {
        use std::os::unix::fs::PermissionsExt as _;
        let (_d, fx) = repo();
        let clean = key(&fx, &["src"]);
        let path = fx.root().join("src/a.rs");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert_ne!(clean, key(&fx, &["src"]));
    }

    #[test]
    fn the_declaration_is_part_of_the_key() {
        let (_d, fx) = repo();
        // Both lists read exactly the files under `src`.
        assert_ne!(key(&fx, &["src"]), key(&fx, &["src", "src/a.rs"]));
        assert_eq!(key(&fx, &["src", "src"]), key(&fx, &["src"]));
    }

    #[test]
    fn computing_a_key_writes_nothing() {
        let (_d, fx) = repo();
        fs::write(fx.root().join("src/a.rs"), "fn a() { 3; }\n").unwrap();
        fs::write(fx.root().join("src/u.rs"), "untracked\n").unwrap();
        let index = fs::read(fx.root().join(".git/index")).unwrap();
        let objects = fx.git(&["count-objects", "-v"]);
        key(&fx, &[]);
        assert_eq!(index, fs::read(fx.root().join(".git/index")).unwrap());
        assert_eq!(objects, fx.git(&["count-objects", "-v"]));
        assert!(fx.git(&["status", "--porcelain"]).contains("src/u.rs"));
    }
}
