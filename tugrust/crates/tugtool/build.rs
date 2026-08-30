//! Build script for tug CLI
//!
//! Captures build-time information:
//! - Git commit hash (TUG_COMMIT)
//! - Build date (TUG_BUILD_DATE)
//! - Rust compiler version (TUG_RUSTC_VERSION)
//!
//! Per [D03], all values gracefully fall back to "unknown" if unavailable.

use std::process::Command;

fn main() {
    // Capture git commit hash
    let commit = run_command("git", &["rev-parse", "--short", "HEAD"]);
    println!("cargo::rustc-env=TUG_COMMIT={}", commit);

    // Capture build date (YYYY-MM-DD format)
    let build_date = get_build_date();
    println!("cargo::rustc-env=TUG_BUILD_DATE={}", build_date);

    // Capture rustc version
    let rustc_version = get_rustc_version();
    println!("cargo::rustc-env=TUG_RUSTC_VERSION={}", rustc_version);

    // Rerun if git state changes (for accurate commit hash)
    // These may not exist in non-git builds, which is fine
    println!("cargo::rerun-if-changed=.git/HEAD");
    println!("cargo::rerun-if-changed=.git/index");
}

/// Run a command and return its stdout, or "unknown" on failure
fn run_command(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                String::from_utf8(output.stdout).ok()
            } else {
                None
            }
        })
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Get the current date in YYYY-MM-DD format
fn get_build_date() -> String {
    // Try using the date command (works on Unix and most systems)
    let date_output = if cfg!(target_os = "windows") {
        // Windows: use PowerShell
        run_command("powershell", &["-Command", "Get-Date -Format yyyy-MM-dd"])
    } else {
        // Unix-like: use date command
        run_command("date", &["+%Y-%m-%d"])
    };

    if date_output != "unknown" {
        return date_output;
    }

    // Fallback: use Rust's SystemTime (basic implementation)
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| {
            // Simple date calculation (not accounting for leap seconds, but close enough)
            let days_since_epoch = d.as_secs() / 86400;
            let (year, month, day) = days_to_ymd(days_since_epoch);
            format!("{:04}-{:02}-{:02}", year, month, day)
        })
        .unwrap_or_else(|_| "unknown".to_string())
}

/// Convert days since Unix epoch to (year, month, day)
fn days_to_ymd(days: u64) -> (i32, u32, u32) {
    // Algorithm based on Howard Hinnant's date algorithms
    // http://howardhinnant.github.io/date_algorithms.html
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

/// Get the rustc version number (e.g., "1.75.0")
fn get_rustc_version() -> String {
    let output = run_command("rustc", &["--version"]);

    if output == "unknown" {
        return output;
    }

    // Parse "rustc X.Y.Z (hash date)" to extract just "X.Y.Z"
    output
        .split_whitespace()
        .nth(1)
        .map(|s| s.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}
