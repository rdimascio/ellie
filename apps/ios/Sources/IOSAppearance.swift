import SwiftUI

enum ElliePalette {
    static let background = Color(red: 0.031, green: 0.051, blue: 0.098)
    static let surface = Color(red: 0.067, green: 0.102, blue: 0.169)
    static let foreground = Color(red: 0.945, green: 0.961, blue: 0.988)
    static let border = Color(red: 0.157, green: 0.204, blue: 0.286)
    static let accent = Color(red: 0.635, green: 0.835, blue: 0.973)
    static let muted = Color(red: 0.604, green: 0.667, blue: 0.761)
    static let violet = Color(red: 0.667, green: 0.643, blue: 0.929)
}

extension View {
    func ellieScreen() -> some View {
        scrollContentBackground(.hidden)
            .background(ElliePalette.background)
            .toolbarBackground(ElliePalette.background, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .tint(ElliePalette.accent)
            .environment(\.colorScheme, .dark)
            .preferredColorScheme(.dark)
    }

    func ellieCard() -> some View {
        padding(20)
            .background(ElliePalette.surface, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(ElliePalette.border, lineWidth: 1))
            .environment(\.colorScheme, .dark)
    }
}

struct EllieNativePresence: View {
    var body: some View {
        GeometryReader { geometry in
            let size = min(geometry.size.width, geometry.size.height)
            ZStack {
                Circle()
                    .fill(ElliePalette.violet.opacity(0.15))
                    .blur(radius: 18)
                Circle()
                    .fill(RadialGradient(colors: [.white, ElliePalette.accent, ElliePalette.violet, ElliePalette.surface], center: .topLeading, startRadius: 0, endRadius: size * 0.72))
                    .frame(width: size * 0.68, height: size * 0.68)
                    .overlay(Circle().strokeBorder(ElliePalette.accent.opacity(0.6), lineWidth: 1).frame(width: size * 0.68, height: size * 0.68))
                Ellipse()
                    .stroke(LinearGradient(colors: [ElliePalette.accent, .white.opacity(0.8), ElliePalette.violet.opacity(0.3)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1.5)
                    .frame(width: size * 0.96, height: size * 0.5)
                    .rotationEffect(.degrees(-35))
                Ellipse()
                    .stroke(ElliePalette.violet.opacity(0.8), lineWidth: 1)
                    .frame(width: size * 0.9, height: size * 0.6)
                    .rotationEffect(.degrees(55))
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .accessibilityHidden(true)
    }
}
