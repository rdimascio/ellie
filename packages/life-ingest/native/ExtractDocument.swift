import Foundation
import PDFKit
import Vision
import ImageIO
import AppKit

let maxPages = 100, maxPixels = 40_000_000, maxOutput = 5_000_000
struct Page: Codable { let page: Int; let reference: String; let method: String }
struct Result: Codable { let text: String; let pages: [Page]?; let pageCount: Int?; let method: String; let width: Int?; let height: Int? }
func fail(_ message: String) -> Never { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(2) }
func recognize(_ image: CGImage) throws -> String {
  if image.width * image.height > maxPixels { fail("Image exceeds the 40 megapixel limit.") }
  let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection = true
  try VNImageRequestHandler(cgImage: image).perform([request])
  return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}
guard CommandLine.arguments.count == 4 else { fail("Extractor requires input, output, and MIME type.") }
let input = URL(fileURLWithPath: CommandLine.arguments[1]), output = URL(fileURLWithPath: CommandLine.arguments[2]), mime = CommandLine.arguments[3]
var result: Result
if mime == "application/pdf" {
  guard let document = PDFDocument(url: input) else { fail("The PDF is corrupt or unreadable.") }
  guard document.pageCount > 0 else { fail("The PDF has no pages.") }; guard document.pageCount <= maxPages else { fail("PDF exceeds the 100 page limit.") }
  var sections: [String] = [], refs: [Page] = []
  for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else { continue }; var text = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""; var method = "native-text"
    if text.isEmpty { let bounds = page.bounds(for: .mediaBox); guard bounds.width.isFinite && bounds.height.isFinite && bounds.width > 0 && bounds.height > 0 else { fail("PDF page dimensions are invalid.") }; let area = bounds.width * bounds.height; let scale: CGFloat = min(2, sqrt(CGFloat(maxPixels) / max(1, area))); let size = NSSize(width: bounds.width * scale, height: bounds.height * scale); guard size.width.isFinite && size.height.isFinite else { fail("PDF page dimensions are invalid.") }; let image = page.thumbnail(of: size, for: .mediaBox); if let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) { text = try recognize(cg); method = "ocr" } }
    sections.append("[Page \(index + 1)]\n\(text)"); refs.append(Page(page: index + 1, reference: "page \(index + 1)", method: method))
  }
  guard sections.contains(where: { !$0.replacingOccurrences(of: #"\[Page \d+\]"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { fail("No readable text was found in the PDF.") }
  result = Result(text: sections.joined(separator: "\n\n"), pages: refs, pageCount: document.pageCount, method: "pdf", width: nil, height: nil)
} else {
  guard let source = CGImageSourceCreateWithURL(input as CFURL, nil), CGImageSourceGetCount(source) == 1 else { fail("The image is corrupt or unreadable.") }
  guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any], let width = properties[kCGImagePropertyPixelWidth] as? NSNumber, let height = properties[kCGImagePropertyPixelHeight] as? NSNumber, width.intValue > 0, height.intValue > 0, width.intValue <= maxPixels, height.intValue <= maxPixels, width.int64Value * height.int64Value <= Int64(maxPixels) else { fail("Image dimensions are invalid or exceed the 40 megapixel limit.") }
  guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("The image is corrupt or unreadable.") }
  let text = try recognize(image); guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { fail("No readable text was found in the image.") }; result = Result(text: text, pages: nil, pageCount: nil, method: "ocr", width: image.width, height: image.height)
}
let encoded = try JSONEncoder().encode(result); guard encoded.count <= maxOutput + 1_000_000 else { fail("Extracted output exceeds the allowed limit.") }; try encoded.write(to: output, options: .atomic)
