import UIKit
import Capacitor
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private let contentProtection = ContentProtectionManager()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        contentProtection.start()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        contentProtection.setAppInactive(true)
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        contentProtection.setAppInactive(true)
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        contentProtection.setAppInactive(false)
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        contentProtection.setAppInactive(false)
    }

    func applicationWillTerminate(_ application: UIApplication) {
        contentProtection.stop()
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

private final class ContentProtectionManager: NSObject {
    private let overlayTag = 880_042
    private var isAppInactive = false
    private var isScreenCaptured = false
    private var screenshotLockActive = false
    private var backgroundedAfterScreenshot = false

    func start() {
        isScreenCaptured = UIScreen.main.isCaptured
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleScreenCaptureDidChange),
            name: UIScreen.capturedDidChangeNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleScreenshotTaken),
            name: UIApplication.userDidTakeScreenshotNotification,
            object: nil
        )
        updateProtectionState()
    }

    func stop() {
        NotificationCenter.default.removeObserver(self)
    }

    func setAppInactive(_ inactive: Bool) {
        if inactive && screenshotLockActive {
            backgroundedAfterScreenshot = true
        } else if !inactive && screenshotLockActive && backgroundedAfterScreenshot {
            screenshotLockActive = false
            backgroundedAfterScreenshot = false
        }

        isAppInactive = inactive
        updateProtectionState()
    }

    @objc private func handleScreenCaptureDidChange() {
        isScreenCaptured = UIScreen.main.isCaptured
        updateProtectionState()
    }

    @objc private func handleScreenshotTaken() {
        screenshotLockActive = true
        backgroundedAfterScreenshot = false
        pauseWebMedia()
        presentOverlay(message: "Screenshots are not allowed")
        notifyWebLayer(isProtected: true, reason: "screenshot")
        updateProtectionState()
    }

    private func updateProtectionState() {
        DispatchQueue.main.async {
            self.isScreenCaptured = UIScreen.main.isCaptured
            let shouldProtect = self.isAppInactive || self.isScreenCaptured || self.screenshotLockActive

            if shouldProtect {
                let message: String
                if self.isScreenCaptured {
                    message = "Screen recording is not allowed"
                } else if self.screenshotLockActive {
                    message = "Screenshot detected. Reopen the app to continue."
                } else {
                    message = "Protected content"
                }
                self.pauseWebMedia()
                self.presentOverlay(message: message)
            } else {
                self.removeOverlay()
            }

            let reason: String
            if self.isScreenCaptured {
                reason = "capture"
            } else if self.screenshotLockActive {
                reason = "screenshot"
            } else if self.isAppInactive {
                reason = "background"
            } else {
                reason = "none"
            }

            self.notifyWebLayer(isProtected: shouldProtect, reason: reason)
        }
    }

    private func presentOverlay(message: String) {
        guard let window = activeWindow() else {
            return
        }

        let overlay: UIView
        let label: UILabel

        if let existing = window.viewWithTag(overlayTag),
           let existingLabel = existing.viewWithTag(overlayTag + 1) as? UILabel {
            overlay = existing
            label = existingLabel
        } else {
            overlay = UIView(frame: window.bounds)
            overlay.tag = overlayTag
            overlay.backgroundColor = .black
            overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            overlay.isUserInteractionEnabled = false

            label = UILabel()
            label.tag = overlayTag + 1
            label.translatesAutoresizingMaskIntoConstraints = false
            label.textColor = .white
            label.font = UIFont.systemFont(ofSize: 18, weight: .semibold)
            label.textAlignment = .center
            label.numberOfLines = 0
            overlay.addSubview(label)

            NSLayoutConstraint.activate([
                label.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
                label.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
                label.leadingAnchor.constraint(greaterThanOrEqualTo: overlay.leadingAnchor, constant: 24),
                label.trailingAnchor.constraint(lessThanOrEqualTo: overlay.trailingAnchor, constant: -24)
            ])
        }

        label.text = message

        if overlay.superview !== window {
            window.addSubview(overlay)
        }

        window.bringSubviewToFront(overlay)
        overlay.frame = window.bounds
    }

    private func removeOverlay() {
        activeWindow()?.viewWithTag(overlayTag)?.removeFromSuperview()
    }

    private func pauseWebMedia() {
        guard let webView = locateWebView(in: activeWindow()) else {
            return
        }

        let script = """
        (() => {
          const mediaElements = document.querySelectorAll('video, audio');
          mediaElements.forEach((element) => {
            try {
              element.pause();
            } catch (_) {}
          });
          window.dispatchEvent(new CustomEvent('app-content-protection', {
            detail: { protected: true, reason: 'native' }
          }));
        })();
        """
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private func notifyWebLayer(isProtected: Bool, reason: String) {
        guard let webView = locateWebView(in: activeWindow()) else {
            return
        }

        let script = """
        window.dispatchEvent(new CustomEvent('app-content-protection', {
          detail: { protected: \(isProtected ? "true" : "false"), reason: '\(reason)' }
        }));
        """
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private func activeWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? UIApplication.shared.windows.first(where: \.isKeyWindow)
    }

    private func locateWebView(in root: UIView?) -> WKWebView? {
        guard let root else {
            return nil
        }
        if let webView = root as? WKWebView {
            return webView
        }
        for subview in root.subviews {
            if let webView = locateWebView(in: subview) {
                return webView
            }
        }
        return nil
    }
}
