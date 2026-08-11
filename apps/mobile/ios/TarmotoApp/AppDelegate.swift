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

  /// The React root, built by the first scene to connect and adopted by the
  /// phone window scene.
  private(set) var rootViewController: UIViewController?

  private var launchOptions: [UIApplication.LaunchOptionsKey: Any]?

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

    // React Native is started by whichever scene connects first — the phone
    // window scene or CarPlay. Both entry points are real scene-delegate
    // callbacks, so they run whenever their scene connects, including for a
    // persisted session that iOS reconnects from its saved configuration.
    //
    // Backstop for launches that connect no scene at all, such as a background
    // launch for location or a push. Idempotent, so it is a no-op once a scene
    // has already started things.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      guard let self else { return }
      self.startReactNativeIfNeeded()
      self.adoptOrphanedWindowSceneIfNeeded()
    }

    // The window is deliberately NOT created here. CarPlay makes this a
    // scene-based app (`UIApplicationSceneManifest` in Info.plist), and UIKit
    // does not adopt `UIApplicationDelegate.window` for such apps: a window
    // created here is never bound to a `UIWindowScene`, never becomes key, and
    // its React surface lays out at zero width — a black screen. `SceneDelegate`
    // owns the phone window instead.
    //
    // Scene configuration is left to the Info.plist manifest rather than
    // `configurationForConnecting`, so UIKit's own role lookup stays in charge
    // of wiring `SceneDelegate` and `CarSceneDelegate`, and no app-side
    // override can be skipped for a restored session.
    return true
  }

  /// Rescue path for installs whose `UISceneSession` predates the window-scene
  /// role in the manifest.
  ///
  /// Updating an app does not necessarily recreate its persisted sessions, and
  /// iOS can reconnect one using its saved configuration without ever
  /// instantiating `SceneDelegate` — leaving a live `UIWindowScene` with no
  /// window at all, which is the black screen this change exists to fix, still
  /// present after the update. Attaching a window to that scene here recovers
  /// those installs without requiring a reinstall.
  ///
  /// No-op in the normal case: `SceneDelegate` has already set `window`.
  private func adoptOrphanedWindowSceneIfNeeded() {
    guard window == nil, let rootViewController else { return }
    guard
      let orphanedScene = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .first(where: { $0.windows.isEmpty })
    else {
      return
    }

    let window = UIWindow(windowScene: orphanedScene)
    window.rootViewController = rootViewController
    window.makeKeyAndVisible()
    self.window = window
  }

  /// Builds the React root exactly once, from whichever scene connects first.
  ///
  /// Exposed to Objective-C so `CarSceneDelegate` can start the JS application
  /// before it connects `RNCarPlay`: a CarPlay-only or restored CarPlay session
  /// has no phone scene to do it, and root-mounted components such as
  /// `CarPlayRideMirror` have to be running for the head unit to get templates.
  @objc
  func startReactNativeIfNeeded() {
    guard rootViewController == nil,
      let factory = reactNativeFactory,
      let delegate = reactNativeDelegate
    else {
      return
    }

    let rootView = factory.rootViewFactory.view(
      withModuleName: "TarmotoApp",
      initialProperties: nil,
      launchOptions: launchOptions
    )
    let rootViewController = delegate.createRootViewController()
    delegate.setRootView(rootView, toRootViewController: rootViewController)
    self.rootViewController = rootViewController
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

    appDelegate.startReactNativeIfNeeded()

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    // Mirrored onto the app delegate so `RCTKeyWindow()` and any UIKit code
    // reaching for the app-delegate window keeps resolving to the live window.
    appDelegate.window = window
    window.rootViewController = appDelegate.rootViewController
    window.makeKeyAndVisible()
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
