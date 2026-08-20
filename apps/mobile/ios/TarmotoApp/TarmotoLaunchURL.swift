import Foundation
import React
import UIKit

/// Process-wide slot for `tarmoto://` URLs delivered through the scene
/// lifecycle (#1189).
///
/// CarPlay makes this a scene-based app, so URLs arrive at the scene
/// delegate — `scene(_:willConnectTo:options:)` for a cold start and
/// `scene(_:openURLContexts:)` for a running app — never at
/// `application(_:open:options:)`. Neither path reaches JS on its own:
///
/// - `Linking.getInitialURL()` reads the app delegate's `launchOptions`, which
///   iOS leaves empty for scene-based apps (the URL travels in the scene's
///   `connectionOptions` instead).
/// - Forwarding to `RCTLinkingManager` while the bundle is still loading is
///   silently dropped: the module only observes `RCTOpenURLNotification` after
///   JS adds its first `Linking` listener, and bridgeless has no
///   `RCTJavaScriptDidLoadNotification` to queue against.
///
/// So the scene delegate hands every URL to `handle(_:)`, which either retains
/// it for JS to drain later (bundle not up yet) or forwards it as a live
/// `Linking` event (JS already running). JS drains the retained slot exactly
/// once, from the `getInitialURL` override in
/// `apps/mobile/src/navigation/linking.ts`.
///
/// Main-thread confined: scene callbacks already run on the main thread and
/// `TarmotoLaunchURL.consumePendingLaunchURL` hops to it, so `pendingURL` and
/// `consumed` need no further synchronisation.
final class TarmotoLaunchURLStore: NSObject {
  static let shared = TarmotoLaunchURLStore()

  private var pendingURL: URL?

  /// Flips when JS drains the slot at startup. Before that, a forwarded
  /// `Linking` event would have no observer and be dropped, so URLs are
  /// retained instead; after it, the pending slot is never read again, so
  /// URLs are forwarded.
  private var consumed = false

  private override init() {
    super.init()
  }

  /// Entry point for every scene-delivered URL, cold or warm.
  ///
  /// Retain-vs-forward is decided by whether JS has already drained the
  /// pending slot:
  ///
  /// - Not yet drained → JS is still booting; retain the URL for the
  ///   `getInitialURL` override. Last writer wins — a second link tapped
  ///   before JS is up replaces the first, matching the rider's latest intent.
  /// - Already drained → JS is running with `Linking` listeners registered
  ///   (React Navigation subscribes when the container mounts, right after it
  ///   drains the slot); forward as a normal `Linking` event. This covers warm
  ///   links and the headless case: a process launched for CarPlay only or in
  ///   the background runs JS with no phone scene, and the link that later
  ///   connects the phone scene arrives here through
  ///   `scene(_:willConnectTo:options:)` long after cold-start consumption.
  func handle(_ url: URL) {
    if consumed {
      RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
    } else {
      pendingURL = url
    }
  }

  /// Drains the pending slot. One-shot: after the first call the store
  /// forwards instead of retaining, and a container remount (dev reload)
  /// cannot re-navigate to a stale launch URL.
  func consumePendingURL() -> URL? {
    let url = pendingURL
    pendingURL = nil
    consumed = true
    return url
  }
}

/// The JS-facing module (`NativeModules.TarmotoLaunchURL`). Registered by the
/// `RCT_EXTERN_MODULE` shim in `TarmotoLaunchURLBridge.m`; instances are
/// created by React Native, so all state lives in `TarmotoLaunchURLStore`.
@objc(TarmotoLaunchURL)
class TarmotoLaunchURL: NSObject {
  /// No UIKit work at init time; keeps module setup off the main queue.
  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  /// Resolves the retained launch URL (or `null`) and marks the slot drained.
  /// `reject` is unused — draining an empty slot is the normal cold start
  /// without a link, not an error.
  @objc(consumePendingLaunchURL:reject:)
  func consumePendingLaunchURL(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      resolve(TarmotoLaunchURLStore.shared.consumePendingURL()?.absoluteString)
    }
  }
}
