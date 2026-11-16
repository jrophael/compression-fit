import ARKit
import UIKit
import WebKit

/// Hosts the Compression Fit web app and bridges three actions from the page:
/// - `scan`: open the native LiDAR scanner and return the scan to `window.receiveLidarScan`.
/// - `exportScan`: share the last scan file (for validation records).
/// - `print`: print the page (the web app's printable target and tape).
final class WebViewController: UIViewController, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
    /// The deployed web app. `?app=ios` is informational only.
    static let startURL = URL(string: "https://jrophael.github.io/compression-fit/?app=ios")!

    private var webView: WKWebView!

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let lidarAvailable = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
        let bootstrap = """
        window.compressionFitApp = {lidar: \(lidarAvailable ? "true" : "false"), version: 1};
        window.print = function () { window.webkit.messageHandlers.compressionFit.postMessage({action: 'print'}); };
        """
        configuration.userContentController.addUserScript(
            WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController.add(WeakScriptMessageHandler(self), name: "compressionFit")

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: Self.startURL))
    }

    // MARK: - Messages from the page

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "scan":
            let leg = (body["leg"] as? String) == "right" ? "right" : "left"
            startScan(leg: leg)
        case "exportScan":
            if let json = body["json"] as? String { exportScan(json) }
        case "print":
            printPage()
        default:
            break
        }
    }

    private func startScan(leg: String) {
        guard ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else {
            notifyCancelled("This iPhone has no LiDAR sensor. LiDAR scanning needs an iPhone 12 Pro or later Pro model.")
            return
        }
        let scanner = ScanViewController(leg: leg)
        scanner.modalPresentationStyle = .fullScreen
        scanner.onComplete = { [weak self, weak scanner] json in
            scanner?.dismiss(animated: true)
            self?.webView.evaluateJavaScript("window.receiveLidarScan(\(json));")
        }
        scanner.onCancel = { [weak self, weak scanner] message in
            scanner?.dismiss(animated: true)
            self?.notifyCancelled(message)
        }
        present(scanner, animated: true)
    }

    private func notifyCancelled(_ message: String) {
        let literal = (try? JSONEncoder().encode(message)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
        webView.evaluateJavaScript("window.lidarScanCancelled && window.lidarScanCancelled(\(literal));")
    }

    private func exportScan(_ json: String) {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("compression-fit-scan-\(formatter.string(from: Date())).json")
        do {
            try json.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            return
        }
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = view
        present(share, animated: true)
    }

    private func printPage() {
        let controller = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil)
        info.outputType = .general
        info.jobName = "Compression Fit"
        controller.printInfo = info
        controller.printFormatter = webView.viewPrintFormatter()
        _ = controller.present(animated: true, completionHandler: nil)
    }

    // MARK: - Camera for the web app's video modes

    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == Self.startURL.host ? .grant : .prompt)
    }

    // MARK: - Offline

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let html = """
        <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="font-family:-apple-system;padding:32px;color:#172d29">
        <h2>Compression Fit is offline</h2>
        <p>Check the internet connection, then try again.</p>
        <p><a href="\(Self.startURL.absoluteString)">Try again</a></p></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }
}

/// Avoids a retain cycle between WKUserContentController and the view controller.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
