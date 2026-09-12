import Foundation
import CoreGraphics

func accessibilityRect(_ rect: CGRect, primaryTop: CGFloat) -> CGRect {
    CGRect(x: rect.minX, y: primaryTop - rect.maxY, width: rect.width, height: rect.height)
}

func tileRect(_ area: CGRect, layout: String) -> CGRect {
    var result = area
    switch layout {
    case "left": result.size.width /= 2
    case "right": result.origin.x += result.width / 2; result.size.width /= 2
    case "top-left", "top-right", "bottom-left", "bottom-right":
        result.size.width /= 2; result.size.height /= 2
        if layout.hasSuffix("right") { result.origin.x += result.width }
        if layout.hasPrefix("bottom") { result.origin.y += result.height }
    default: break
    }
    return result
}
