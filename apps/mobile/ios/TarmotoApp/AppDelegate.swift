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

  /// Held for `SceneDelegate`, which starts the React Native surface when the
  /// window scene connects — after `didFinishLaunching` has returned.
  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?

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
    self.launchOptions = launchOptions

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
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    // Mirrored onto the app delegate so `RCTKeyWindow()` and any UIKit code
    // reaching for the app-delegate window keeps resolving to the live window.
    appDelegate.window = window

    // Sets the root view controller and calls `makeKeyAndVisible`.
    factory.startReactNative(
      withModuleName: "TarmotoApp",
      in: window,
      launchOptions: appDelegate.launchOptions
    )
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
