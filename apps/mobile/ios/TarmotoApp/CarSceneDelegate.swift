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

  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    RNCarPlay.disconnect()
  }

  // The single-argument variant fires on older iOS versions; defer to
  // the disconnect handler above on supported ones.
  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnect interfaceController: CPInterfaceController
  ) {
    RNCarPlay.disconnect()
  }
}
