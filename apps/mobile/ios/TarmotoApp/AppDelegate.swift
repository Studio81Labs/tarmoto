import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import Firebase

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  /// The React root, built at launch and adopted by whichever window scene
  /// connects. Held here (rather than created in `SceneDelegate`) so the JS
  /// application boots for *every* launch path.
  var rootViewController: UIViewController?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Local simulator builds may intentionally omit Firebase credentials.
    // Preview/release preflight requires the plist, so distributed builds
    // always configure the default app before messaging is used.
    if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
      FirebaseApp.configure()
    }

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    // React Native is started HERE, not in `SceneDelegate`. A CarPlay-only
    // cold start (process launched from the head unit with the phone locked)
    // connects a `CPTemplateApplicationScene` and never a window scene, so
    // gating startup on the phone scene would leave the JS application — and
    // root-mounted components like `CarPlayRideMirror` — unstarted, and the
    // head unit without templates. Starting here also preserves the previous
    // ordering guarantee that React Native is up before any scene connects.
    let rootView = factory.rootViewFactory.view(
      withModuleName: "TarmotoApp",
      initialProperties: nil,
      launchOptions: launchOptions
    )
    let rootViewController = delegate.createRootViewController()
    delegate.setRootView(rootView, toRootViewController: rootViewController)
    self.rootViewController = rootViewController

    // The window is deliberately NOT created here. CarPlay makes this a
    // scene-based app (`UIApplicationSceneManifest` in Info.plist), and UIKit
    // does not adopt `UIApplicationDelegate.window` for such apps: a window
    // created here is never bound to a `UIWindowScene`, never becomes key, and
    // its React surface lays out at zero width — a black screen. `SceneDelegate`
    // owns the phone window instead.
    return true
  }
}

/// Phone/tablet window scene.
///
/// CarPlay declares its own scene (`CarSceneDelegate`) in the manifest. Once a
/// scene manifest exists, every role the app is handed — including
/// `UIWindowSceneSessionRoleApplication` — needs a delegate to create and
/// attach its window, otherwise the scene comes up with no windows at all.
@objc(SceneDelegate)
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate
    else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    // Mirrored onto the app delegate so `RCTKeyWindow()` and any UIKit code
    // reaching for the app-delegate window keeps resolving to the live window.
    appDelegate.window = window
    window.rootViewController = appDelegate.rootViewController
    window.makeKeyAndVisible()

    // A scene-based app receives a cold-start `tarmoto://` URL here, in
    // `connectionOptions` — never in the app delegate's launch options — so it
    // has to be handed to the linking module explicitly.
    open(urlContexts: connectionOptions.urlContexts)
  }

  /// Warm deep links. UIKit routes these to the scene, not to
  /// `UIApplicationDelegate.application(_:open:options:)`.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    open(urlContexts: URLContexts)
  }

  private func open(urlContexts: Set<UIOpenURLContext>) {
    for context in urlContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
      if let sourceApplication = context.options.sourceApplication {
        options[.sourceApplication] = sourceApplication
      }
      if let annotation = context.options.annotation {
        options[.annotation] = annotation
      }
      RCTLinkingManager.application(UIApplication.shared, open: context.url, options: options)
    }
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
