import SwiftUI

/// Compression Fit iPhone app.
///
/// The app shows the Compression Fit web app (the same pages as the GitHub Pages site)
/// and adds one native feature: a LiDAR scan of the lower leg. The scan's point cloud is
/// passed to the web page, where `scan.js` measures it. Keeping the measurement maths in
/// the web app means it is tested in CI and can be updated without an app release.
@main
struct CompressionFitApp: App {
    var body: some Scene {
        WindowGroup {
            WebContainer()
        }
    }
}

struct WebContainer: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebViewController {
        WebViewController()
    }

    func updateUIViewController(_ controller: WebViewController, context: Context) {}
}
