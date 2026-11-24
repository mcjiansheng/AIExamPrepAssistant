// macOS 上没有 poppler 时的后备方案：用系统自带的 PDFKit 抽取文字或渲染页面。
// 用法：swift pdfkit_helper.swift text <pdf>
//       swift pdfkit_helper.swift render <pdf> <输出目录> <dpi>
import AppKit
import Foundation
import PDFKit

let args = CommandLine.arguments
guard args.count >= 3, let doc = PDFDocument(url: URL(fileURLWithPath: args[2])) else {
    FileHandle.standardError.write("无法打开 PDF\n".data(using: .utf8)!)
    exit(1)
}

if doc.isLocked {
    FileHandle.standardError.write(Data("PDF password required".utf8))
    exit(2)
}

if args[1] == "text" {
    let pages = (0..<doc.pageCount).map { doc.page(at: $0)?.string ?? "" }
    var output: [String: Any] = ["pages": pages]
    if let modified = doc.documentAttributes?[.modificationDateAttribute] as? Date {
        output["modified"] = ISO8601DateFormatter().string(from: modified)
    }
    let encoded = try JSONSerialization.data(withJSONObject: output)
    FileHandle.standardOutput.write(encoded)
} else if args[1] == "render", args.count >= 5 {
    let dir = args[3]
    let scale = (Double(args[4]) ?? 96) / 72.0
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i) else { continue }
        let box = page.bounds(for: .mediaBox)
        let image = page.thumbnail(of: NSSize(width: box.width * scale, height: box.height * scale), for: .mediaBox)
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { continue }
        try png.write(to: URL(fileURLWithPath: "\(dir)/p-\(i + 1).png"))
    }
} else {
    FileHandle.standardError.write("未知命令\n".data(using: .utf8)!)
    exit(2)
}
