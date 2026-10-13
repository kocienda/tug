use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    // Find the repo root (three levels up from crate root)
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo_root = manifest_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap();

    // --- Git commit hash for --version output ---
    let commit = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout).ok()
            } else {
                None
            }
        })
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=TUG_COMMIT={commit}");

    // --- Build tugcode (Claude Code bridge binary) ---
    let tugcode_dir = repo_root.join("tugcode");

    // Run bun install if node_modules doesn't exist
    if !tugcode_dir.join("node_modules").exists() {
        let status = Command::new("bun")
            .arg("install")
            .current_dir(&tugcode_dir)
            .status()
            .expect("failed to run bun install for tugcode");
        if !status.success() {
            panic!("bun install for tugcode failed");
        }
    }

    // Compile tugcode to a standalone binary through compile-tugcode.sh, the
    // one place `bun build --compile` runs (it keeps a read-only bun from
    // stranding a copy of itself in the working directory on every compile).
    // Place the binary in the cargo target profile directory (next to tugcast/tugtool).
    // OUT_DIR is: target/{profile}/build/{crate}-{hash}/out
    // We walk up to find the profile directory (debug or release).
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let target_profile_dir = out_dir
        .ancestors()
        .find(|p| {
            p.file_name()
                .map(|f| f == profile.as_str())
                .unwrap_or(false)
        })
        .expect("could not find target profile directory from OUT_DIR")
        .to_path_buf();

    let tugcode_binary = target_profile_dir.join("tugcode");
    let status = Command::new("bash")
        .arg(repo_root.join("tugrust/scripts/compile-tugcode.sh"))
        .arg(&tugcode_binary)
        .status()
        .expect("failed to run bun build --compile for tugcode");
    if !status.success() {
        panic!("bun build --compile for tugcode failed");
    }

    // Set rerun-if-changed for cargo caching
    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join("tugcode/src/").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join("tugcode/package.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repo_root
            .join("tugrust/scripts/compile-tugcode.sh")
            .display()
    );
}
