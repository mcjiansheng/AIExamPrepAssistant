// PDFKit fallback for hosts without the corresponding Poppler tools.
import AppKit
import Foundation
import PDFKit

let args = CommandLine.arguments

func fail(_ message: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data(message.utf8))
    exit(code)
}

if args.count == 2, args[1] == "prepare" {
    exit(0)
}

guard args.count >= 3, let doc = PDFDocument(url: URL(fileURLWithPath: args[2])) else {
    fail("Cannot open PDF")
}
if doc.isLocked {
    fail("PDF password required", 2)
}

if args[1] == "count" {
    print(doc.pageCount)
} else if args[1] == "text" {
    let pages = (0..<doc.pageCount).map { doc.page(at: $0)?.string ?? "" }
    var output: [String: Any] = ["pages": pages]
    if let modified = doc.documentAttributes?[PDFDocumentAttribute.modificationDateAttribute] as? Date {
        output["modified"] = ISO8601DateFormatter().string(from: modified)
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output))
} else if args[1] == "image", args.count == 5, let number = Int(args[3]), let page = doc.page(at: number - 1) {
    let bounds = page.bounds(for: .mediaBox)
    let pixels = NSSize(width: bounds.width * 120 / 72, height: bounds.height * 120 / 72)
    let image = page.thumbnail(of: pixels, for: .mediaBox)
    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else {
        fail("Cannot render PDF page")
    }
    try png.write(to: URL(fileURLWithPath: args[4]))
} else {
    fail("Unknown PDF operation")
}
