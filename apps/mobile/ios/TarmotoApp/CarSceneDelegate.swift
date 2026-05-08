import CarPlay
import Foundation
import react_native_carplay

/// Bridges the iOS `CPTemplateApplicationScene` lifecycle into the
/// `react-native-carplay` package for US-17.
///
/// `Info.plist` declares this class as the scene delegate for the
/// `CPTemplateApplicationSceneSessionRoleApplication` role. When iOS
/// instantiates the CarPlay scene (rider plugs the phone into a head
/// unit) the OS calls `templateApplicationScene(_:didConnect:to:)`,
/// which we forward into the package's
/// `+[RNCarPlay connectWithInterfaceController:window:]` shared store.
/// Disconnect calls `+[RNCarPlay disconnect]` so `CarPlay.connected`
/// flips back to `false` and the JS bridge stops trying to update a
/// dismantled scene.
///
/// The package does NOT ship a ready-made scene delegate of its own
/// (verified against `node_modules/react-native-carplay@2.4.1-beta.0/
/// ios/RNCarPlay.{h,m}`) — the only iOS entry point it exposes is the
/// `connectWithInterfaceController:window:` class method, and the host
/// app is expected to provide the scene delegate that calls it. Without
/// this class the scene manifest in `Info.plist` would point at a
/// missing class and `CarPlay.connected` would stay `false` forever
/// because the JS side would never receive the `didConnect` event.
///
/// Disconnect handling is split into two callbacks because Apple routes
/// CarPlay disconnect events through different selectors depending on
/// the entitlement the app holds. Tarmoto requests
/// `com.apple.developer.carplay-maps` (the navigation-app entitlement),
/// for which Apple documents the
/// `templateApplicationScene(_:didDisconnect:from:)` variant — the
/// older `didDisconnectInterfaceController` selector is *not* called
/// for navigation apps, so we'd otherwise leak the package's
/// `interfaceController`/`window` references and leave
/// `CarPlay.connected` stuck at `true` until a future reconnect
/// arrived. Apps without the maps entitlement still receive the older
/// selector; we implement both so the same delegate works regardless
/// of whether the rider is on a build with or without entitlement
/// approval.
@available(iOS 13.0, *)
@objc(CarSceneDelegate)
public class CarSceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {

  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController,
    to window: CPWindow
  ) {
    RNCarPlay.connect(with: interfaceController, window: window)
  }

  // Navigation-app variant — fires on builds carrying the
  // `com.apple.developer.carplay-maps` entitlement, which is the
  // production path for Tarmoto. Without this method the package's
  // `disconnect()` would never run on unplug under the maps
  // entitlement and the JS bridge would believe the destroyed
  // CarPlay scene is still connected.
  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnect interfaceController: CPInterfaceController,
    from window: CPWindow
  ) {
    RNCarPlay.disconnect()
  }

  // Audio/non-navigation variant — fires on builds without the maps
  // entitlement (e.g. an interim TestFlight while Apple paperwork is
  // pending). Belt-and-braces so a developer testing locally without
  // the entitlement still gets a clean disconnect.
  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    RNCarPlay.disconnect()
  }
}
