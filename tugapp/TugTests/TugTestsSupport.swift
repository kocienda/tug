import XCTest

extension XCTestCase {
    /// One assertion, named by the claim it makes.
    ///
    /// The label is the sentence a reader needs when it fails — what was
    /// supposed to be true — and `detail` carries what was seen instead. The
    /// failure is reported at the caller's line, under the test method that
    /// made it.
    func check(
        _ label: String,
        _ condition: Bool,
        _ detail: @autoclosure () -> String = "",
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        if condition { return }
        let extra = detail()
        XCTFail(extra.isEmpty ? label : "\(label) — \(extra)", file: file, line: line)
    }
}
