/**
 * The scan that decides whether an offered command needs a terminal.
 */

import { describe, expect, test } from "bun:test";
import { terminalNeed, terminalNeedNote } from "../run-offer-terminal";

describe("terminalNeed", () => {
  test("names each command that prompts on a terminal", () => {
    expect(terminalNeed("sudo make install")).toBe("sudo");
    expect(terminalNeed("su - postgres")).toBe("su");
    expect(terminalNeed("ssh build@host uptime")).toBe("ssh");
    expect(terminalNeed("passwd")).toBe("passwd");
    expect(terminalNeed("login")).toBe("login");
  });

  test("an ordinary command needs none", () => {
    expect(terminalNeed("ls -la")).toBeNull();
    expect(terminalNeed("git status && cargo build")).toBeNull();
    expect(terminalNeed("")).toBeNull();
    expect(terminalNeed("   ")).toBeNull();
  });

  test("the head of any segment counts, not only the first", () => {
    expect(terminalNeed("make && sudo make install")).toBe("sudo");
    expect(terminalNeed("make || sudo make install")).toBe("sudo");
    expect(terminalNeed("cd /etc; sudo vi hosts")).toBe("sudo");
    expect(terminalNeed("cat key.pub | ssh host 'cat >> keys'")).toBe("ssh");
    expect(terminalNeed("sleep 5 & sudo true")).toBe("sudo");
    expect(terminalNeed("make\nsudo make install")).toBe("sudo");
    expect(terminalNeed("make&&sudo make install")).toBe("sudo");
  });

  test("a word that is only an argument does not count", () => {
    expect(terminalNeed("man sudo")).toBeNull();
    expect(terminalNeed("which ssh")).toBeNull();
    expect(terminalNeed("brew install sudo")).toBeNull();
    expect(terminalNeed("grep -r login src")).toBeNull();
  });

  test("a quoted sudo inside an argument does not count", () => {
    expect(terminalNeed('echo "sudo make install"')).toBeNull();
    expect(terminalNeed("echo 'run: sudo true'")).toBeNull();
    expect(terminalNeed("git commit -m 'drop sudo; sudo is gone'")).toBeNull();
    expect(terminalNeed('git commit -m "a && sudo b"')).toBeNull();
    expect(terminalNeed('echo "say \\"hi\\"; sudo x"')).toBeNull();
  });

  test("an operator inside quotes starts no segment", () => {
    expect(terminalNeed("echo 'a | ssh b'")).toBeNull();
    expect(terminalNeed('printf "one\nsudo two"')).toBeNull();
  });

  test("an escaped operator starts no segment", () => {
    expect(terminalNeed("echo a\\; sudo b")).toBeNull();
    expect(terminalNeed("make \\\n  sudo")).toBeNull();
  });

  test("a longer word that begins with one of the names is another command", () => {
    expect(terminalNeed("ssh-keygen -t ed25519")).toBeNull();
    expect(terminalNeed("sudoedit /etc/hosts")).toBeNull();
    expect(terminalNeed("summary --all")).toBeNull();
  });

  test("assignments in front of a command are stepped over", () => {
    expect(terminalNeed("LC_ALL=C sudo true")).toBe("sudo");
    expect(terminalNeed("A=1 B=2 ssh host")).toBe("ssh");
    expect(terminalNeed("SUDO=sudo make")).toBeNull();
    expect(terminalNeed('MSG="a b" sudo true')).toBe("sudo");
    expect(terminalNeed('"A=1" sudo true')).toBeNull();
  });

  test("a head given by path is named by its last part", () => {
    expect(terminalNeed("/usr/bin/sudo true")).toBe("sudo");
    expect(terminalNeed("./ssh host")).toBe("ssh");
  });

  test("a comment names no command", () => {
    expect(terminalNeed("# sudo make install")).toBeNull();
    expect(terminalNeed("make # then sudo make install")).toBeNull();
    expect(terminalNeed("# first\nsudo true")).toBe("sudo");
  });

  test("the note names the command", () => {
    expect(terminalNeedNote("sudo")).toContain("sudo needs a terminal");
  });
});
