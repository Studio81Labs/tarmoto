#import <CarPlay/CarPlay.h>
#import <react-native-carplay/RNCarPlay.h>

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
