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

  /// Builds the React root exactly once, from whichever scene connects first.
  ///
  /// `coldStartURL` is merged into the launch options the surface is created
  /// with, which is the only way a killed-app `tarmoto://` launch can reach
  /// `Linking.getInitialURL()`. Delivering it as an `RCTLinkingManager` event
  /// instead is lost: that posts `RCTOpenURLNotification`, which the module
  /// only observes once JS has added a `Linking` listener — something that has
  /// not happened while the bundle is still loading.
  ///
  /// Exposed to Objective-C so `CarSceneDelegate` can start the JS application
  /// before it connects `RNCarPlay`.
  @objc(startReactNativeIfNeededWithColdStartURL:)
  func startReactNativeIfNeeded(coldStartURL: URL? = nil) {
    guard rootViewController == nil,
      let factory = reactNativeFactory,
      let delegate = reactNativeDelegate
    else {
      return
    }

    var options = launchOptions ?? [:]
    if let coldStartURL {
      options[.url] = coldStartURL
    }

    let rootView = factory.rootViewFactory.view(
      withModuleName: "TarmotoApp",
      initialProperties: nil,
      launchOptions: options
    )
    let rootViewController = delegate.createRootViewController()
    delegate.setRootView(rootView, toRootViewController: rootViewController)
    self.rootViewController = rootViewController
  }

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
    // window scene or CarPlay — because a cold-start `tarmoto://` URL only
    // exists at that point, and `Linking.getInitialURL()` can only see it if it
    // is in the launch options the surface was created with.
    //
    // Both entry points are real scene-delegate callbacks, which always run
    // when their scene connects, including for a persisted session that UIKit
    // reconnects using its saved configuration. That is the failure mode
    // `configurationForConnecting` had.
    //
    // Backstop for launches that connect no scene at all (a background launch
    // for location or a push), where there is no URL to wait for anyway. It is
    // idempotent, so it is a no-op once a scene has already started things.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      self?.startReactNativeIfNeeded()
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

    // Starts React Native if this is the first scene to connect, carrying a
    // killed-app `tarmoto://` URL into the surface's launch options so
    // `Linking.getInitialURL()` resolves it.
    appDelegate.startReactNativeIfNeeded(
      coldStartURL: connectionOptions.urlContexts.first?.url
    )

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    // Mirrored onto the app delegate so `RCTKeyWindow()` and any UIKit code
    // reaching for the app-delegate window keeps resolving to the live window.
    appDelegate.window = window
    window.rootViewController = appDelegate.rootViewController
    window.makeKeyAndVisible()
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
