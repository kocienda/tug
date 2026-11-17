/**
 * dev-setup.sh against a scratch machine: a scratch checkout, a scratch home,
 * a scratch Homebrew prefix and a directory of stub tools ahead of the system's
 * on PATH. The doctor must name what is missing and change nothing; setup must
 * install each missing thing through the door DEVELOPING.md prescribes and
 * finish green. Nothing here reads the machine the test runs on: every tool
 * the script asks about is a stub, and the installers are stubs too.
 *
 * It runs under `/bin/bash`, macOS's own 3.2, because that is the only bash a
 * fresh Mac has when the script is first run.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "dev-setup.sh");

let scratch: string;
let root: string;
let home: string;
let brew: string;
let stubs: string;
let log: string;

function stub(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A tool that answers any invocation with one line. */
function says(dir: string, name: string, line: string): void {
  stub(dir, name, `echo "${line}"`);
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "dev-setup-"));
  root = join(scratch, "root");
  home = join(scratch, "home");
  brew = join(scratch, "brew");
  stubs = join(scratch, "stubs");
  log = join(scratch, "log");
  writeFileSync(log, "");

  for (const dir of ["tugcode", "tugdeck", "tests/app-test", "tugrust", ".github/workflows"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, ".bun-version"), "1.3.9\n");
  writeFileSync(join(root, ".github/workflows/wasm.yml"), "        with:\n          tool: wasm-pack@0.15.0\n");
  writeFileSync(join(root, "tugrust/rust-toolchain.toml"), '[toolchain]\nchannel = "1.93.0"\n');

  // The machine: an Apple silicon Mac with a working Xcode and nothing else.
  says(stubs, "uname", "arm64");
  says(stubs, "sw_vers", "15.4");
  stub(stubs, "xcode-select", `[ -n "$STUB_NO_XCODE" ] && exit 2\necho /Applications/Xcode.app/Contents/Developer`);
  stub(stubs, "xcodebuild", `[ "$1" = -version ] && echo "Xcode 26.3"\nexit 0`);
  stub(stubs, "cc", `echo cc >> "$STUB_LOG"\ncat > /dev/null`);
  stub(stubs, "git", "exit 1");
  stub(stubs, "security", "exit 0");
  says(stubs, "python3", "Python 3.9.6");

  // The installers. `curl` hands back a script for the two that are piped to
  // a shell, and a token for the two that are piped to `tar`.
  stub(
    stubs,
    "curl",
    `for a in "$@"; do url="$a"; done
echo "curl $url" >> "$STUB_LOG"
case "$url" in
  *rustup*)
    echo 'mkdir -p "$HOME/.cargo/bin"'
    echo 'printf "#!/bin/bash\\necho cargo 1.93.0\\n" > "$HOME/.cargo/bin/cargo"'
    echo 'printf "#!/bin/bash\\necho 1.93.0-aarch64-apple-darwin\\n" > "$HOME/.cargo/bin/rustup"'
    echo 'chmod +x "$HOME/.cargo/bin/cargo" "$HOME/.cargo/bin/rustup"'
    ;;
  *Homebrew*)
    echo 'mkdir -p "$TUG_DEV_SETUP_BREW_PREFIX/bin"'
    echo 'cp "$STUB_BREW" "$TUG_DEV_SETUP_BREW_PREFIX/bin/brew"'
    ;;
  *) echo tarball ;;
esac`,
  );
  stub(
    stubs,
    "tar",
    `cat > /dev/null
name=cargo-nextest
line="cargo-nextest 0.9.100"
while [ $# -gt 0 ]; do
  case "$1" in
    -C) shift; dir="$1" ;;
    *wasm-pack) name=wasm-pack; line="wasm-pack 0.15.0" ;;
  esac
  shift
done
printf '#!/bin/bash\\necho "%s"\\n' "$line" > "$dir/$name"
chmod +x "$dir/$name"`,
  );
  // Homebrew itself, kept aside until its installer "runs".
  stub(
    scratch,
    "brew-stub",
    `echo "brew $*" >> "$STUB_LOG"
[ "$1" = install ] || exit 0
bin="$TUG_DEV_SETUP_BREW_PREFIX/bin"
case "$2" in
  oven-sh/bun/bun@*)
    printf '#!/bin/bash\\nif [ "$1" = install ]; then mkdir -p "$3/node_modules"; else echo 1.3.9; fi\\n' > "$bin/bun"
    chmod +x "$bin/bun" ;;
  python)
    printf '#!/bin/bash\\necho "Python 3.12.1"\\n' > "$bin/python3"
    chmod +x "$bin/python3" ;;
  *)
    printf '#!/bin/bash\\necho "%s 20.19.0"\\n' "$2" > "$bin/$2"
    chmod +x "$bin/$2" ;;
esac`,
  );
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(args: string[], opts: { path?: string; env?: Record<string, string> } = {}) {
  const result = spawnSync("/bin/bash", [SCRIPT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: opts.path ?? `${stubs}:/usr/bin:/bin`,
      HOME: home,
      SHELL: "/bin/zsh",
      TUG_DEV_SETUP_ROOT: root,
      TUG_DEV_SETUP_BREW_PREFIX: brew,
      STUB_LOG: log,
      STUB_BREW: join(scratch, "brew-stub"),
      ...opts.env,
    },
  });
  return { status: result.status, out: result.stdout, err: result.stderr, log: readFileSync(log, "utf8") };
}

/** The PATH of a terminal opened after setup has run. */
function freshPath(): string {
  return `${home}/.cargo/bin:${brew}/bin:${stubs}:/usr/bin:/bin`;
}

describe("dev-setup --check", () => {
  test("names every missing tool on a bare machine and installs nothing", () => {
    const r = run(["--check"]);
    expect(r.status).toBe(1);
    for (const line of [
      "✓ Xcode 26.3",
      "✗ cargo not found",
      "✗ wasm-pack not found",
      "✗ bun not found",
      "✗ node not found",
      "✗ just not found",
      "✗ tmux not found",
      "✗ tugcode packages are not installed",
      "✗ cargo-nextest not found",
      "✗ python3 3.9.6",
    ]) {
      expect(r.out).toContain(line);
    }
    expect(r.out).toContain("8 problems block `just app-debug`");
    // Without `just`, the script names itself as the way to fix things.
    expect(r.out).toContain("Run `scripts/dev-setup.sh`");
    expect(r.log).not.toContain("curl");
    expect(existsSync(join(home, ".cargo"))).toBe(false);
    expect(existsSync(brew)).toBe(false);
  });

  // Only the compiler can be shown here: the git and python3 gates are on the
  // `/usr/bin` shims by path, and a stub cannot stand at that path.
  test("runs no compiler while no developer directory is active", () => {
    const r = run(["--check"], { env: { STUB_NO_XCODE: "1" } });
    expect(r.status).toBe(1);
    expect(r.out).toContain("✗ no active developer directory");
    expect(r.out).toContain("sudo xcode-select -s /Applications/Xcode.app");
    expect(r.out).toContain("– C compiler not checked until Xcode is selected");
    expect(r.log).not.toContain("cc");
  });

  test("refuses a wasm-pack that is not the pinned version", () => {
    run(["--yes"]);
    says(join(home, ".cargo/bin"), "wasm-pack", "wasm-pack 0.13.1");
    const r = run(["--check"], { path: freshPath() });
    expect(r.status).toBe(1);
    expect(r.out).toContain("✗ wasm-pack 0.13.1");
    expect(r.out).toContain("need exactly 0.15.0");
  });

  test("the quiet run-tier preflight is silent when green and names the reds when not", () => {
    const bare = run(["--check", "--tier", "run", "--quiet"]);
    expect(bare.status).toBe(1);
    expect(bare.out).toBe("");
    expect(bare.err).toContain("8 problems block `just app-debug`");
    expect(bare.err).toContain("✗ tmux not found");
    expect(bare.err).not.toContain("cargo-nextest");

    run(["--yes"]);
    const ready = run(["--check", "--tier", "run", "--quiet"], { path: freshPath() });
    expect(ready.status).toBe(0);
    expect(ready.out).toBe("");
    expect(ready.err).toBe("");
  });
});

describe("dev-setup", () => {
  test("installs everything through the prescribed doors and leaves the doctor green", () => {
    const r = run(["--yes"]);
    expect(r.status).toBe(0);
    // Installed, but the terminal that ran setup still has its old PATH.
    expect(r.out).toContain("Open a new terminal, then: just app-debug");

    expect(r.log).toContain("curl https://sh.rustup.rs");
    expect(r.log).toContain("wasm-pack-v0.15.0-aarch64-apple-darwin.tar.gz");
    expect(r.log).toContain("curl https://get.nexte.st/latest/mac");
    expect(r.log).toContain("brew install oven-sh/bun/bun@1.3.9");
    for (const formula of ["node", "just", "tmux", "shellcheck", "python"]) {
      expect(r.log).toContain(`brew install ${formula}\n`);
    }
    for (const dir of ["tugcode", "tugdeck", "tests/app-test"]) {
      expect(existsSync(join(root, dir, "node_modules"))).toBe(true);
    }
    expect(readFileSync(join(home, ".zprofile"), "utf8")).toContain("brew shellenv");

    const doctor = run(["--check"], { path: freshPath() });
    expect(doctor.out).toContain("This machine is ready. Next: just app-debug");
    expect(doctor.status).toBe(0);
    expect(doctor.out).not.toContain("✗");
  });

  test("a second run installs nothing", () => {
    run(["--yes"]);
    writeFileSync(log, "");
    const r = run(["--yes"], { path: freshPath() });
    expect(r.status).toBe(0);
    expect(r.log).not.toContain("curl");
    expect(r.log).not.toContain("brew install");
  });

  test("does not run rustup's or Homebrew's installer unasked", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("no terminal to ask on; pass --yes to allow it");
    expect(r.log).not.toContain("rustup");
    expect(r.log).not.toContain("Homebrew");
    expect(existsSync(brew)).toBe(false);
    // What needs no installer script is still fetched.
    expect(r.out).toContain("✓ wasm-pack is installed at");
    // Declining rustup leaves cargo red, beside a tool this run installed.
    expect(r.out).toContain("✗ cargo not found");
    expect(r.out).toContain("Then open a new terminal, so it sees what this run installed");
  });
});
