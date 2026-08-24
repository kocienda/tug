import Foundation

/// Branch-name normalization used to derive instance IDs, per-instance
/// path components, and bundle-ID suffixes from a git branch name.
///
/// Algorithm:
///   1. Lowercase.
///   2. Replace every character outside `[a-z0-9]` with `-` (so `/`,
///      whitespace, `_`, `.`, and punctuation all become separators).
///   3. Collapse runs of `-` into a single `-`.
///   4. Trim leading and trailing `-`.
///
/// Reference: dash/tug-multi-instance.md #terminology gives the
/// short summary ("lowercased, `/` → `-`, non-`[a-z0-9-]` stripped");
/// the plan task's worked examples (`feat/foo` → `feat-foo`,
/// `wip/foo bar` → `wip-foo-bar`) are authoritative and require the
/// expanded behavior above.
///
/// Extracted as a top-level enum (rather than a method of BuildInfo)
/// so the pure logic can be unit-tested without an XCTest bundle, via:
///   tests/build-info/test-branch-slug.sh
/// which concatenates this file with the test driver and runs the pair
/// through `swift -`.
enum BranchSlug {
    static func compute(_ branch: String) -> String {
        var dashed = String.UnicodeScalarView()
        for scalar in branch.lowercased().unicodeScalars {
            let v = scalar.value
            let isLower = (0x61...0x7A).contains(v)
            let isDigit = (0x30...0x39).contains(v)
            dashed.append(isLower || isDigit ? scalar : Unicode.Scalar(0x2D)!)
        }
        var collapsed = String.UnicodeScalarView()
        var lastWasDash = false
        for scalar in dashed {
            let isDash = scalar.value == 0x2D
            if isDash && lastWasDash { continue }
            collapsed.append(scalar)
            lastWasDash = isDash
        }
        var result = String(collapsed)
        while result.hasPrefix("-") { result.removeFirst() }
        while result.hasSuffix("-") { result.removeLast() }
        return result
    }
}
