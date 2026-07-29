/**
 * Tarmoto Location Service
 * GPS tracking with haversine distance calculation.
 */

import Geolocation from "@react-native-community/geolocation";
import { sensorService } from "./sensors";

export interface LocationUpdate {
  lat: number;
  lng: number;
  speed: number; // km/h
  accuracy: number; // meters
  altitude: number;
  timestamp: number;
}

type LocationCallback = (location: LocationUpdate) => void;

class LocationService {
  private watchId: number | null = null;
  private lastLocation: LocationUpdate | null = null;
  private totalDistance = 0; // meters
  // Two independent classes of consumer share ONE OS watch:
  //   - `primaryCallback`: the ride recorder. It owns the trip odometer, so
  //     `start()` resets distance. There is at most one.
  //   - `subscribers`: everything else that just needs live fixes (turn-by-turn
  //     navigation). They must NOT reset the odometer, and unsubscribing one
  //     must not tear the watch out from under the ride.
  // The watch runs while EITHER has a consumer; it's cleared only when both are
  // empty. This lets navigation open/close over a recording ride (or vice
  // versa) without stealing the other's GPS or zeroing the ride's distance.
  private primaryCallback: LocationCallback | null = null;
  private subscribers = new Set<LocationCallback>();

  /**
   * Start the ride recorder's location feed. Resets the trip odometer and
   * ensures the OS watch is running. Kept single-slot: a second `start()`
   * replaces the previous recorder (a new ride supersedes an old one).
   */
  start(onUpdate: LocationCallback): void {
    this.primaryCallback = onUpdate;
    this.totalDistance = 0;
    this.lastLocation = null;
    this.ensureWatch();
  }

  /** Stop the ride recorder. The watch keeps running if a subscriber (e.g. an
   *  open navigation session) still needs it. */
  stop(): void {
    this.primaryCallback = null;
    this.maybeStopWatch();
  }

  /**
   * Subscribe an INDEPENDENT consumer (navigation) to live fixes. Does not
   * touch the odometer or the ride recorder. Returns an unsubscribe that
   * removes only this listener and stops the watch only when nothing else
   * needs it.
   */
  subscribe(onUpdate: LocationCallback): () => void {
    this.subscribers.add(onUpdate);
    this.ensureWatch();
    return () => {
      this.subscribers.delete(onUpdate);
      this.maybeStopWatch();
    };
  }

  private ensureWatch(): void {
    if (this.watchId !== null) return;
    this.watchId = Geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, speed, accuracy, altitude } =
          position.coords;
        const speedKmh = (speed || 0) * 3.6;

        const update: LocationUpdate = {
          lat: latitude,
          lng: longitude,
          speed: speedKmh,
          accuracy: accuracy || 0,
          altitude: altitude || 0,
          timestamp: position.timestamp,
        };

        // Calculate distance
        if (this.lastLocation) {
          const dist = this.haversine(
            this.lastLocation.lat,
            this.lastLocation.lng,
            latitude,
            longitude,
          );
          if (dist > 1 && dist < 500) {
            this.totalDistance += dist;
          }
        }

        this.lastLocation = update;
        sensorService.updateLocation(latitude, longitude, speedKmh);
        // Fan out to the ride recorder and every independent subscriber. A
        // throwing listener must not starve the others (a ride-recorder throw
        // must not stop navigation from getting the fix, and vice versa), so
        // isolate EVERY call and report rather than silently swallow.
        const deliver = (listener: LocationCallback, label: string) => {
          try {
            listener(update);
          } catch (error) {
            console.warn(
              `Location ${label} threw:`,
              error instanceof Error ? error.message : error,
            );
          }
        };
        if (this.primaryCallback) deliver(this.primaryCallback, "recorder");
        for (const subscriber of [...this.subscribers]) {
          deliver(subscriber, "subscriber");
        }
      },
      (error) => console.warn("GPS error:", error.message),
      {
        enableHighAccuracy: true,
        distanceFilter: 5,
        interval: 1000,
        fastestInterval: 500,
      },
    );
  }

  private maybeStopWatch(): void {
    if (this.primaryCallback !== null || this.subscribers.size > 0) return;
    if (this.watchId !== null) {
      Geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  getDistance(): number {
    return this.totalDistance;
  }

  getLastLocation(): LocationUpdate | null {
    return this.lastLocation;
  }

  /**
   * One-shot fix for callers that need a current location without
   * subscribing to the live watch — e.g. the hazard report modal opened
   * from the Map tab where `start()` is not running and `lastLocation`
   * may be `null` or stale. Resolves with the freshest available reading
   * (ideally a brand-new fix; falls back to `lastLocation` on timeout
   * so the rider still sees something rather than a permanent spinner).
   *
   * `maximumAge` is intentionally short (5s) so the rider isn't shown a
   * coordinate from minutes ago when they tap "Refresh" right after
   * arriving on a new road.
   */
  async getCurrentLocation(
    options: { timeoutMs?: number; maximumAgeMs?: number } = {},
  ): Promise<LocationUpdate | null> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maximumAgeMs = options.maximumAgeMs ?? 5000;
    return new Promise((resolve) => {
      Geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude, speed, accuracy, altitude } =
            position.coords;
          const update: LocationUpdate = {
            lat: latitude,
            lng: longitude,
            speed: (speed || 0) * 3.6,
            accuracy: accuracy || 0,
            altitude: altitude || 0,
            timestamp: position.timestamp,
          };
          // Prime the cache so a follow-up `getLastLocation()` call
          // (e.g. from a screen that mounts shortly after) sees the
          // fresh fix instead of `null`.
          this.lastLocation = update;
          resolve(update);
        },
        () => {
          // GPS denied / timeout / no-fix-available — fall back to the
          // last known location so the caller still has something to
          // work with. Caller can decide what to do with `null`.
          resolve(this.lastLocation);
        },
        {
          enableHighAccuracy: true,
          timeout: timeoutMs,
          maximumAge: maximumAgeMs,
        },
      );
    });
  }

  /**
   * Haversine distance in meters
   */
  private haversine(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}

export const locationService = new LocationService();
