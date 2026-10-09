// Test driver for BridgePathGuard. Run via
// tests/bridge-path-guard/test-bridge-path-guard.sh, which concatenates this
// file with tugapp/Sources/BridgePathGuard.swift and pipes the pair to
// `swift -`.
//
// Every case runs against a scratch tree standing in for the user's home and
// Trash, so nothing here touches the real ones.

let fm = FileManager.default
let scratch = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("bridge-path-guard-\(getpid())")
try? fm.removeItem(at: scratch)
let home = scratch.appendingPathComponent("home")
let trash = home.appendingPathComponent(".Trash")
let temporary = scratch.appendingPathComponent("temporary")
let outside = scratch.appendingPathComponent("outside")
for dir in [home, trash, temporary, outside] {
    try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
}
fm.createFile(atPath: home.appendingPathComponent("a.txt").path, contents: nil)
fm.createFile(atPath: trash.appendingPathComponent("a.txt").path, contents: nil)
fm.createFile(atPath: outside.appendingPathComponent("x.txt").path, contents: nil)
// A link inside home pointing out of it, a dangling one whose target is
// outside, and an alias of home itself (the `/u` firmlink's shape).
try! fm.createSymbolicLink(at: home.appendingPathComponent("link-out"), withDestinationURL: outside)
try! fm.createSymbolicLink(
    at: home.appendingPathComponent("dangle"),
    withDestinationURL: outside.appendingPathComponent("minted.txt"))
try! fm.createSymbolicLink(at: scratch.appendingPathComponent("alias"), withDestinationURL: home)
defer { try? fm.removeItem(at: scratch) }

let guardian = BridgePathGuard(home: home, temporary: temporary, trash: trash)
let h = home.path
let o = outside.path

var failures = 0
func check(_ label: String, _ ok: Bool) {
    if ok {
        print("ok   \(label)")
    } else {
        print("FAIL \(label)")
        failures += 1
    }
}
func passes<T>(_ result: Result<T, BridgePathGuard.Refusal>) -> Bool {
    if case .success = result { return true }
    return false
}

// The common rules.
check("empty path is refused", !passes(guardian.resolve("")))
check("relative path is refused", !passes(guardian.resolve("a/b.txt")))
check("'..' component is refused", !passes(guardian.resolve("\(h)/../outside/x.txt")))
check("'.' component is refused", !passes(guardian.resolve("\(h)/./a.txt")))
check("tilde expands once to the real home",
      (try? guardian.resolve("~/x").get().path)
          == URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().appendingPathComponent("x").path)

// openPath: any existing path opens; creating is home-only.
check("open: an existing path outside home opens", passes(guardian.forOpening("\(o)/x.txt")))
check("create: a new file under home", passes(guardian.forCreating("\(h)/memory/new/CLAUDE.md")))
check("create: a new file outside home is refused", !passes(guardian.forCreating("\(o)/minted.txt")))
check("create: through a link that leaves home is refused",
      !passes(guardian.forCreating("\(h)/link-out/minted.txt")))
check("create: through a dangling link is refused", !passes(guardian.forCreating("\(h)/dangle")))

// trashPath: home only, and a link is trashed as the link.
check("trash: a file under home", passes(guardian.forTrashing("\(h)/a.txt")))
check("trash: a file outside home is refused", !passes(guardian.forTrashing("\(o)/x.txt")))
check("trash: home itself is refused", !passes(guardian.forTrashing(h)))
check("trash: a file reached through a link out of home is refused",
      !passes(guardian.forTrashing("\(h)/link-out/x.txt")))
check("trash: a symlink is trashed as the link, not its target",
      (try? guardian.forTrashing("\(h)/link-out").get().lastPathComponent) == "link-out")
check("trash: home reached by another spelling is still home",
      passes(guardian.forTrashing("\(scratch.path)/alias/a.txt")))
check("trash: a scratch project in the temporary folder",
      passes(guardian.forTrashing("\(temporary.path)/project/assets/photo.png")))
check("trash: the temporary folder itself is refused", !passes(guardian.forTrashing(temporary.path)))

// restorePath: from the Trash, to under home.
check("restore: Trash to home",
      passes(guardian.forRestoring(trashed: "\(trash.path)/a.txt", destination: "\(h)/back/a.txt")))
check("restore: a source outside the Trash is refused",
      !passes(guardian.forRestoring(trashed: "\(h)/a.txt", destination: "\(h)/b.txt")))
check("restore: a destination outside home is refused",
      !passes(guardian.forRestoring(trashed: "\(trash.path)/a.txt", destination: "\(o)/a.txt")))
check("restore: Trash to a scratch project in the temporary folder",
      passes(guardian.forRestoring(trashed: "\(trash.path)/a.txt",
                                   destination: "\(temporary.path)/project/assets/a.txt")))
check("restore: a refusal names its reason",
      {
          if case .failure(let refusal) = guardian.forRestoring(trashed: "\(o)/x.txt", destination: "\(h)/x.txt") {
              return refusal.reason.contains("the Trash")
          }
          return false
      }())

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all BridgePathGuard cases passed")
