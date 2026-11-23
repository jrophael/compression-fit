import ARKit
import UIKit
import WebKit

/// Hosts the Compression Fit web app and bridges these actions from the page:
/// - `scan`: open the native LiDAR scanner and return the scan to `window.receiveLidarScan`.
/// - `arTape`: open an AR tape tool (`tool`: `guide`, `length` or `girth`) and return the result
///   to `window.receiveArTape`. `girth` is refused when the page's `market` is `au`.
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
        window.compressionFitApp = {lidar: \(lidarAvailable ? "true" : "false"), ar: \(lidarAvailable ? "true" : "false"), truedepth: \(TrueDepthScanViewController.isAvailable ? "true" : "false"), version: 3};
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
        case "arTape":
            let leg = (body["leg"] as? String) == "right" ? "right" : "left"
            startArTape(tool: body["tool"] as? String ?? "", leg: leg, market: body["market"] as? String ?? "au")
        case "exportScan":
            if let json = body["json"] as? String { exportScan(json) }
        case "print":
            printPage()
        default:
            break
        }
    }

    private var hasLiDAR: Bool { ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) }

    private func startScan(leg: String) {
        guard hasLiDAR else {
            notifyCancelled("This iPhone has no LiDAR sensor. LiDAR scanning needs an iPhone 12 Pro or later Pro model.")
            return
        }
        presentScanner(leg: leg) { [weak self] json in
            self?.webView.evaluateJavaScript("window.receiveLidarScan(\(json));")
        } cancelled: { [weak self] message in
            self?.notifyCancelled(message)
        }
    }

    private func presentScanner(leg: String, completed: @escaping (String) -> Void, cancelled: @escaping (String) -> Void) {
        let scanner = ScanViewController(leg: leg)
        scanner.modalPresentationStyle = .fullScreen
        scanner.onComplete = { [weak scanner] json in
            scanner?.dismiss(animated: true)
            completed(json)
        }
        scanner.onCancel = { [weak scanner] message in
            scanner?.dismiss(animated: true)
            cancelled(message)
        }
        present(scanner, animated: true)
    }

    /// AR tape tools. In Australia the girth tape is refused here as well as hidden in the page:
    /// ankle and calf circumferences there come from a physical tape only.
    private func startArTape(tool: String, leg: String, market: String) {
        if tool == "truedepth" {
            startTrueDepth(leg: leg, market: market)
            return
        }
        guard hasLiDAR else {
            notifyArCancelled("The AR tape needs the LiDAR sensor of an iPhone 12 Pro or later Pro model. Use Measure with tape instead.")
            return
        }
        switch tool {
        case "girth":
            guard market != "au" else {
                notifyArCancelled("The AR girth tape is not available in Australia. Use the AR tape guide with a real tape.")
                return
            }
            presentScanner(leg: leg) { [weak self] json in
                self?.webView.evaluateJavaScript("window.receiveArTape({tool: 'girth', scan: \(json)});")
            } cancelled: { [weak self] message in
                self?.notifyArCancelled(message)
            }
        case "guide", "length":
            let controller = ARTapeViewController(tool: tool == "guide" ? .guide : .length, leg: leg)
            controller.modalPresentationStyle = .fullScreen
            controller.onComplete = { [weak self, weak controller] json in
                controller?.dismiss(animated: true)
                self?.webView.evaluateJavaScript("window.receiveArTape(\(json));")
            }
            controller.onCancel = { [weak self, weak controller] message in
                controller?.dismiss(animated: true)
                self?.notifyArCancelled(message)
            }
            present(controller, animated: true)
        default:
            notifyArCancelled("This AR tool is not available in this version of the app.")
        }
    }

    /// Face ID depth scan (test). Works on any Face ID iPhone; refused in Australia.
    private func startTrueDepth(leg: String, market: String) {
        guard market != "au" else {
            notifyArCancelled("The Face ID depth scan is not available in Australia. Use the AR tape guide with a real tape.")
            return
        }
        guard TrueDepthScanViewController.isAvailable else {
            notifyArCancelled("This iPhone has no Face ID camera. Use Measure with tape.")
            return
        }
        let controller = TrueDepthScanViewController(leg: leg)
        controller.modalPresentationStyle = .fullScreen
        controller.onComplete = { [weak self, weak controller] json in
            controller?.dismiss(animated: true)
            self?.webView.evaluateJavaScript("window.receiveArTape(\(json));")
        }
        controller.onCancel = { [weak self, weak controller] message in
            controller?.dismiss(animated: true)
            self?.notifyArCancelled(message)
        }
        present(controller, animated: true)
    }

    private func jsString(_ message: String) -> String {
        (try? JSONEncoder().encode(message)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }

    private func notifyCancelled(_ message: String) {
        webView.evaluateJavaScript("window.lidarScanCancelled && window.lidarScanCancelled(\(jsString(message)));")
    }

    private func notifyArCancelled(_ message: String) {
        webView.evaluateJavaScript("window.arTapeCancelled && window.arTapeCancelled(\(jsString(message)));")
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
