#import <React/RCTBridgeModule.h>

/// Registers the Swift `TarmotoLaunchURL` module (TarmotoLaunchURL.swift) with
/// React Native, exposing it as `NativeModules.TarmotoLaunchURL`. Swift cannot
/// expand the registration macros itself, so this shim carries them; the class
/// is resolved by its Objective-C name at runtime, which keeps this file free
/// of `TarmotoApp-Swift.h` — the same header-visibility split
/// `CarSceneDelegate.m` documents.
@interface RCT_EXTERN_MODULE(TarmotoLaunchURL, NSObject)

RCT_EXTERN_METHOD(consumePendingLaunchURL:(RCTPromiseResolveBlock)resolve
                                   reject:(RCTPromiseRejectBlock)reject)

@end
