import Cocoa
import UniformTypeIdentifiers

/// Which files Tug will open, and into which kind of card. The OS open path,
/// the Open File… panel and the `choosePath` bridge panel all ask here.
enum OpenableFiles {
    /// UTIs a Text card can **edit** — text and everything that conforms to it
    /// (source code, JSON, XML, Markdown, …). The first of the tests in
    /// `isEditable`.
    static let editableContentTypes: [UTType] = [.text, .sourceCode, .plainText]

    /// UTIs a viewer card can **display** — read-only, and enumerated one by
    /// one rather than tested against `public.image`. Camera RAW conforms to
    /// `public.image` but WebKit's `<img>` cannot reliably decode it, and Tug
    /// should only offer what it can actually render. Mirrors the extension
    /// table in `tugdeck/src/lib/file-kinds.ts` and tugcast's `fs_blob.rs`.
    ///
    /// AVIF has no `UTType` static, so it is constructed by identifier;
    /// `compactMap` drops it on an OS that doesn't know the type rather than
    /// trapping.
    static let viewableContentTypes: [UTType] = [
        UTType.png,
        UTType.jpeg,
        UTType.gif,
        UTType.webP,
        UTType.heic,
        UTType.heif,
        UTType("public.avif") ?? UTType(filenameExtension: "avif"),
        UTType.tiff,
        UTType.bmp,
        UTType.ico,
        UTType.pdf,
    ].compactMap { $0 }

    /// Extensions macOS owns as something other than text, which no
    /// declaration of ours can take back: `ts` and `mts` are MPEG-2 transport
    /// stream to the system, and `cts` is named beside them so the three
    /// TypeScript module extensions travel together.
    static let undeclarableTextExtensions: Set<String> = ["ts", "mts", "cts"]

    /// Extensions that are source text to one tool and another app's document
    /// format to the system, which Tug therefore never declares: `pxd` is a
    /// Cython declaration file and Pixelmator Pro's document. A file with one
    /// is text only if its bytes say so, whatever type the system gives it.
    static let contestedTextExtensions: Set<String> = ["pxd"]

    /// Filename extensions a Text card edits whatever UTI the system resolves
    /// them to: the bundle's declared ones and the undeclarable ones.
    static let textExtensions: Set<String> =
        undeclarableTextExtensions.union(declaredTextExtensions(in: Bundle.main.infoDictionary))

    /// Every extension an `Info.plist` declares under
    /// `UTImportedTypeDeclarations`, lowercased. Read back from the plist so it
    /// is the one list; named again by extension because an imported
    /// declaration loses to any other app's exported one for the same
    /// extension.
    static func declaredTextExtensions(in info: [String: Any]?) -> Set<String> {
        let declarations = info?["UTImportedTypeDeclarations"] as? [[String: Any]] ?? []
        var extensions: Set<String> = []
        for declaration in declarations {
            guard let tags = declaration["UTTypeTagSpecification"] as? [String: Any],
                  let tagged = tags["public.filename-extension"] as? [String] else { continue }
            extensions.formUnion(tagged.map { $0.lowercased() })
        }
        return extensions
    }

    /// Whether `url` is a file Tug can open by any route — a regular file a
    /// Text card can edit or a viewer card can display. Editing is the
    /// narrower claim; opening is the wider one. Guards the OS open path and
    /// filters the Open File… panel, so a folder or an unsupported file is
    /// ignored.
    ///
    /// Conformance rather than equality on the viewable side too: a subtype
    /// UTI (a vendor's own JPEG flavor, say) conforms to `public.jpeg` and is
    /// the same bytes to a decoder, so it should open.
    static func isOpenable(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .contentTypeKey]),
              values.isRegularFile == true else { return false }
        if let type = values.contentType,
           viewableContentTypes.contains(where: { type.conforms(to: $0) }) {
            return true
        }
        return isEditable(url)
    }

    /// Whether `url` is a regular file a Text card can edit. Three tests, the
    /// cheap ones first: its UTI conforms to one of {@link
    /// editableContentTypes}; its extension is one of `extensions`; or the
    /// system can call it nothing better than data — no extension
    /// (`Dockerfile`, `.gitignore`, `Justfile`) or one nobody declared — and
    /// its first bytes read as UTF-8 text. A file the system has a non-text
    /// type for (an executable, an archive) is never read, unless its
    /// extension is one of {@link contestedTextExtensions}, where the type is
    /// another app's claim on the extension and the bytes decide.
    static func isEditable(_ url: URL, extensions: Set<String> = textExtensions) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .contentTypeKey]),
              values.isRegularFile == true else { return false }
        if let type = values.contentType,
           editableContentTypes.contains(where: { type.conforms(to: $0) }) {
            return true
        }
        if extensions.contains(url.pathExtension.lowercased()) { return true }
        if let type = values.contentType, type != .data, !type.isDynamic,
           !contestedTextExtensions.contains(url.pathExtension.lowercased()) { return false }
        return looksLikeText(url)
    }

    /// Whether the first 4 KB of `url` hold no NUL byte and decode as UTF-8,
    /// allowing a multibyte sequence cut by the read's end. An empty file is
    /// text.
    static func looksLikeText(_ url: URL) -> Bool {
        let limit = 4096
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        let read: Data?
        do { read = try handle.read(upToCount: limit) } catch { return false }
        guard let head = read else { return true }
        if head.contains(0) { return false }
        let cuts = head.count == limit ? 0...3 : 0...0
        return cuts.contains { String(data: head.dropLast($0), encoding: .utf8) != nil }
    }
}

/// Filters an open panel through one of the `OpenableFiles` predicates, in
/// place of `allowedContentTypes`. A UTI list cannot name a `.ts` file (macOS
/// types it as video), a `Dockerfile` (no extension) or any extension nobody
/// declared, and the panel greys out whatever the list cannot name.
/// Directories stay enabled so the user can descend into them; packages are
/// files to the user and go through the predicate like one.
final class OpenPanelFilter: NSObject, NSOpenSavePanelDelegate {
    private let accepts: (URL) -> Bool

    init(_ accepts: @escaping (URL) -> Bool) {
        self.accepts = accepts
    }

    func panel(_ sender: Any, shouldEnable url: URL) -> Bool {
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey])
        if values?.isDirectory == true, values?.isPackage != true { return true }
        return accepts(url)
    }
}
