#import <CarPlay/CarPlay.h>
#import <react-native-carplay/RNCarPlay.h>

/// The slice of `AppDelegate` this scene needs. Declared locally rather than
/// importing `TarmotoApp-Swift.h`, whose generated declarations reference
/// `React_RCTAppDelegate` types that are not visible from this file — the same
/// header-visibility split this adapter exists to avoid.
@protocol TarmotoReactNativeStarting <NSObject>
- (void)startReactNativeIfNeeded;
@end

/// Bridges the CarPlay scene lifecycle into react-native-carplay. Keeping this
/// adapter in Objective-C prevents the package's React headers from changing
/// which React types are visible to the Swift AppDelegate compiler.
API_AVAILABLE(ios(13.0))
@interface CarSceneDelegate : UIResponder <CPTemplateApplicationSceneDelegate>
@end

@implementation CarSceneDelegate

- (void)templateApplicationScene:(CPTemplateApplicationScene *)templateApplicationScene
    didConnectInterfaceController:(CPInterfaceController *)interfaceController
                          toWindow:(CPWindow *)window
{
  // A CarPlay-only launch — process started from the head unit with no phone
  // window scene — must still bring up the JS application, otherwise
  // root-mounted components such as `CarPlayRideMirror` never run and the head
  // unit gets no templates. This runs for a reconnected session too, which
  // `configurationForConnecting` does not reliably do.
  id appDelegate = UIApplication.sharedApplication.delegate;
  if ([appDelegate respondsToSelector:@selector(startReactNativeIfNeeded)]) {
    [(id<TarmotoReactNativeStarting>)appDelegate startReactNativeIfNeeded];
  }

  [RNCarPlay connectWithInterfaceController:interfaceController window:window];
}

// Navigation apps receive the window-bearing disconnect callback.
- (void)templateApplicationScene:(CPTemplateApplicationScene *)templateApplicationScene
    didDisconnectInterfaceController:(CPInterfaceController *)interfaceController
                            fromWindow:(CPWindow *)window
{
  [RNCarPlay disconnect];
}

// Apps without the navigation entitlement receive the legacy callback.
- (void)templateApplicationScene:(CPTemplateApplicationScene *)templateApplicationScene
    didDisconnectInterfaceController:(CPInterfaceController *)interfaceController
{
  [RNCarPlay disconnect];
}

@end
