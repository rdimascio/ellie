import Foundation
@main
enum GeometryTests {
    static func main() {
        let primary = accessibilityRect(CGRect(x: 0, y: 0, width: 1440, height: 900), primaryTop: 900)
        precondition(primary == CGRect(x: 0, y: 0, width: 1440, height: 900))
        let above = accessibilityRect(CGRect(x: -100, y: 900, width: 1920, height: 1080), primaryTop: 900)
        precondition(above == CGRect(x: -100, y: -1080, width: 1920, height: 1080))
        let below = accessibilityRect(CGRect(x: 100, y: -800, width: 1280, height: 800), primaryTop: 900)
        precondition(below.minY == 900)
        let area = CGRect(x: -1920, y: 25, width: 1920, height: 1055)
        precondition(tileRect(area, layout: "top-left") == CGRect(x: -1920, y: 25, width: 960, height: 527.5))
        precondition(tileRect(area, layout: "bottom-right") == CGRect(x: -960, y: 552.5, width: 960, height: 527.5))
        precondition(tileRect(area, layout: "right") == CGRect(x: -960, y: 25, width: 960, height: 1055))
        print("Display conversion and tiling tests passed.")
    }
}
