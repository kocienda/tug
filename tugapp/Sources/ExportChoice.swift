import Foundation

/// One format the export save panel offers: its name in the Format popup,
/// the extension a file saved in it takes, and what is written.
///
/// `/export` offers two (Markdown and JSON Lines, both text the page built);
/// a share offers exactly one, the artifact the user previewed, which is
/// either text (Markdown) or a file the host already rendered (PDF, PNG).
struct ExportChoice: Equatable {
    /// What a saved file holds: text written as UTF-8, or a rendered file
    /// copied into place.
    enum Content: Equatable {
        case text(String)
        case file(URL)
    }

    var title: String
    var ext: String
    var content: Content
}

/// The save panel's configuration for a set of choices — everything about
/// it that is not AppKit, so it can be checked without a window.
struct ExportPanelConfig: Equatable {
    /// The save panel's title when a share's Save… raises it.
    static let shareSaveTitle = "Save Shared Turns"

    var title: String
    var nameFieldLabel: String
    /// The Format popup's titles, in the choices' order.
    var popupTitles: [String]
    /// The suggested filename: the base name with the first choice's extension.
    var initialFilename: String

    /// The configuration for `choices` under `baseName`. The first choice is
    /// the one the panel opens on. The title and the name field's label are
    /// `/export`'s unless the caller names its own — a share's Save… says
    /// what it is saving.
    static func make(
        baseName: String,
        choices: [ExportChoice],
        title: String = "Export Session",
        nameFieldLabel: String = "Export As:"
    ) -> ExportPanelConfig {
        let ext = choices.first?.ext ?? ""
        return ExportPanelConfig(
            title: title,
            nameFieldLabel: nameFieldLabel,
            popupTitles: choices.map(\.title),
            initialFilename: ext.isEmpty ? baseName : "\(baseName).\(ext)"
        )
    }
}

/// Write `choice`'s content to `url`: text atomically as UTF-8, a file by
/// copying it into place after removing anything already there (the save
/// panel has already asked the user whether to replace it).
func writeExportChoice(_ choice: ExportChoice, to url: URL) throws {
    switch choice.content {
    case .text(let text):
        try text.write(to: url, atomically: true, encoding: .utf8)
    case .file(let source):
        let manager = FileManager.default
        if manager.fileExists(atPath: url.path) {
            try manager.removeItem(at: url)
        }
        try manager.copyItem(at: source, to: url)
    }
}
