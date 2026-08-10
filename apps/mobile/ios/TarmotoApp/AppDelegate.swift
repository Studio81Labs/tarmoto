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

  /// The React root, built at launch and adopted by the phone window scene
  /// once it connects.
  private(set) var rootViewController: UIViewController?

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

    // React Native starts here, unconditionally, for every launch path.
    //
    // Scene callbacks are not a safe place to own this. When iOS reconnects a
    // persisted `UISceneSession` it reuses the session's saved configuration
    // and can skip `configurationForConnecting` entirely, so a restored CarPlay
    // session would reach `CarSceneDelegate` — which connects `RNCarPlay`
    // immediately — with no JS application running, and the head unit would get
    // no templates. Starting at launch also keeps the ordering guarantee that
    // React Native is up before any scene delegate connects.
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
    //
    // Scene configuration is left to the Info.plist manifest rather than
    // `configurationForConnecting`, so UIKit's own role lookup stays in charge
    // of wiring `SceneDelegate` and `CarSceneDelegate`.
    return true
  }
}

/// Phone/tablet window scene.
///
/// CarPlay declares its own scene (`CarSceneDelegate`) in the manifest. Once a
/// scene manifest exists, every role the app is handed — including
/// `UIWindowSceneSessionRoleApplication` — needs a delegate to create and
/// attach its window, otherwise the scene comes up with no windows at all and
/// the React surface lays out at zero width (a black screen).
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

    // Best effort only. `Linking.getInitialURL()` reads the launch options the
    // surface was built with, and the surface already exists by now, so a
    // killed-app launch through `tarmoto://` cannot be resolved that way. This
    // event reaches JS only once `Linking` has added a listener; see the
    // cold-start deep-link follow-up noted on the PR.
    open(urlContexts: connectionOptions.urlContexts)
  }

  /// Warm deep links. UIKit routes these to the scene, not to
  /// `UIApplicationDelegate.application(_:open:options:)`. JS is running and
  /// `Linking` has a listener by this point, so delivery here is sound.
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
