#!/usr/bin/env swift

import AppKit
import Foundation

private let width = 1920
private let height = 130

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("library-video-caption: \(message)\n".utf8))
    exit(2)
}

guard CommandLine.arguments.count == 3 else {
    fail("usage: swift scripts/library-video-caption.swift OUTPUT.png 'Caption text'")
}

let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let caption = CommandLine.arguments[2].replacingOccurrences(of: "\\n", with: "\n")

guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: width,
    pixelsHigh: height,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    fail("could not allocate the caption bitmap")
}

bitmap.size = NSSize(width: width, height: height)
guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fail("could not create the caption graphics context")
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()

let rail = NSBezierPath(
    roundedRect: NSRect(x: 32, y: 14, width: width - 64, height: height - 28),
    xRadius: 18,
    yRadius: 18
)
NSColor(calibratedWhite: 0.04, alpha: 0.90).setFill()
rail.fill()

if !caption.isEmpty {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    paragraph.lineBreakMode = .byWordWrapping
    paragraph.minimumLineHeight = 44
    paragraph.maximumLineHeight = 44

    let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 40, weight: .semibold),
        .foregroundColor: NSColor.white,
        .paragraphStyle: paragraph,
    ]
    let textRect = NSRect(x: 90, y: 20, width: width - 180, height: height - 40)
    (caption as NSString).draw(
        with: textRect,
        options: [.usesLineFragmentOrigin, .usesFontLeading],
        attributes: attributes
    )
}

context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fail("could not encode the caption PNG")
}

do {
    try FileManager.default.createDirectory(
        at: outputURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try png.write(to: outputURL, options: .atomic)
} catch {
    fail("could not write \(outputURL.path): \(error.localizedDescription)")
}
