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

  /// The React root, built once by whichever scene connects first and adopted
  /// by the phone window when it arrives.
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

    // React Native is NOT started here. In a scene-based app a cold-start
    // `tarmoto://` URL is delivered to the connecting scene, never in these
    // launch options, and `Linking.getInitialURL()` reads whatever launch
    // options the surface was created with. Starting here would bake in a
    // dictionary that can never contain the URL, so startup is deferred to
    // `configurationForConnecting`, which sees the URL and still runs before
    // any scene delegate connects.
    return true
  }

  /// Called for the first scene of **every** role — the phone window scene and
  /// CarPlay's `CPTemplateApplicationScene` alike — and always before that
  /// scene's delegate connects.
  ///
  /// Starting React Native here means a CarPlay-only cold start (process
  /// launched from the head unit, no window scene at all) still boots the JS
  /// application, so root-mounted components such as `CarPlayRideMirror` run
  /// and the head unit gets its templates. It also preserves the ordering
  /// `CarSceneDelegate` relies on: React Native is up before
  /// `connectWithInterfaceController:window:` fires.
  func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    startReactNativeIfNeeded(coldStartURL: options.urlContexts.first?.url)
    // `name: nil` resolves the Info.plist configuration for this role, so both
    // `SceneDelegate` and `CarSceneDelegate` keep their declared wiring.
    return UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
  }

  /// Builds the React root exactly once.
  ///
  /// `coldStartURL` is merged into the launch options the surface is created
  /// with so `Linking.getInitialURL()` can resolve it. Delivering the URL as an
  /// `RCTLinkingManager` event instead would be lost on a killed-app launch:
  /// that event only reaches JS once `Linking` has added a listener, which has
  /// not happened while the bundle is still loading.
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

    // Normally already started from `configurationForConnecting`; this keeps the
    // window from coming up empty if the app is ever restored without it.
    appDelegate.startReactNativeIfNeeded(coldStartURL: connectionOptions.urlContexts.first?.url)

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    // Mirrored onto the app delegate so `RCTKeyWindow()` and any UIKit code
    // reaching for the app-delegate window keeps resolving to the live window.
    appDelegate.window = window
    window.rootViewController = appDelegate.rootViewController
    window.makeKeyAndVisible()
  }

  /// Warm deep links. UIKit routes these to the scene, not to
  /// `UIApplicationDelegate.application(_:open:options:)`. By this point JS is
  /// running and `Linking` has a listener, so the event delivery is sound.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
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
