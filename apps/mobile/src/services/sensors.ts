/**
 * Tarmoto Sensor Service
 * Manages accelerometer and gyroscope data collection.
 * Handles feature extraction and on-device classification.
 */

import { accelerometer, gyroscope, setUpdateIntervalForType, SensorTypes } from 'react-native-sensors';
import { Subscription } from 'rxjs';
import { map, bufferCount } from 'rxjs/operators';
import type { SensorReading, QualityClass, SurfaceType } from '@/types';

const SAMPLE_RATE_MS = 20; // 50Hz
const WINDOW_SIZE = 100;   // 2 seconds at 50Hz
const WINDOW_STEP = 50;    // 50% overlap = 1 second step

export interface WindowFeatures {
  rms: number;
  std: number;
  peak_to_peak: number;
  crest_factor: number;
  zero_crossing_rate: number;
  percentile_95: number;
  kurtosis: number;
  skewness: number;
  gyro_rms: number;
  speed_kmh: number;
  speed_normalized_rms: number;
  timestamp: number;
}

export interface ClassificationResult {
  quality_class: QualityClass;
  quality_score: number;
  surface_type: SurfaceType;
  rms: number;
  confidence: number;
}

type SensorCallback = (features: WindowFeatures, classification: ClassificationResult) => void;

class SensorService {
  private accelSub: Subscription | null = null;
  private gyroSub: Subscription | null = null;
  private buffer: SensorReading[] = [];
  private rawReadings: SensorReading[] = [];
  private isRecording = false;
  private callback: SensorCallback | null = null;
  private currentSpeed = 0;
  private currentLat = 0;
  private currentLng = 0;

  /**
   * Start recording sensor data
   */
  start(onWindow: SensorCallback): void {
    if (this.isRecording) return;
    this.isRecording = true;
    this.callback = onWindow;
    this.buffer = [];
    this.rawReadings = [];

    setUpdateIntervalForType(SensorTypes.accelerometer, SAMPLE_RATE_MS);
    setUpdateIntervalForType(SensorTypes.gyroscope, SAMPLE_RATE_MS);

    // Accelerometer stream
    this.accelSub = accelerometer.subscribe(({ x, y, z, timestamp }) => {
      if (!this.isRecording) return;

      const reading: SensorReading = {
        t: timestamp || Date.now(),
        ax: x, ay: y, az: z,
        lat: this.currentLat,
        lng: this.currentLng,
        speed: this.currentSpeed / 3.6, // store as m/s
      };

      this.buffer.push(reading);
      this.rawReadings.push(reading);

      // Process window when we have enough samples
      if (this.buffer.length >= WINDOW_SIZE) {
        const window = this.buffer.slice(0, WINDOW_SIZE);
        this.buffer = this.buffer.slice(WINDOW_STEP); // slide by step

        const features = this.extractFeatures(window);
        const classification = this.classify(features);
        this.callback?.(features, classification);
      }
    });

    // Gyroscope stream (merge into readings)
    this.gyroSub = gyroscope.subscribe(({ x, y, z }) => {
      // Attach to most recent reading
      if (this.rawReadings.length > 0) {
        const last = this.rawReadings[this.rawReadings.length - 1];
        last.gx = x;
        last.gy = y;
        last.gz = z;
      }
    });
  }

  /**
   * Stop recording
   */
  stop(): SensorReading[] {
    this.isRecording = false;
    this.accelSub?.unsubscribe();
    this.gyroSub?.unsubscribe();
    this.accelSub = null;
    this.gyroSub = null;
    this.callback = null;

    const readings = [...this.rawReadings];
    this.rawReadings = [];
    this.buffer = [];
    return readings;
  }

  /**
   * Update GPS data (called from location service)
   */
  updateLocation(lat: number, lng: number, speedKmh: number): void {
    this.currentLat = lat;
    this.currentLng = lng;
    this.currentSpeed = speedKmh;
  }

  /**
   * Extract features from a 2-second window of accelerometer data
   */
  private extractFeatures(window: SensorReading[]): WindowFeatures {
    // Calculate acceleration magnitude minus gravity
    const deviations = window.map(r => {
      const mag = Math.sqrt(r.ax ** 2 + r.ay ** 2 + r.az ** 2);
      return Math.abs(mag - 9.81);
    });

    const n = deviations.length;
    const mean = deviations.reduce((s, v) => s + v, 0) / n;
    const rms = Math.sqrt(deviations.reduce((s, v) => s + v * v, 0) / n);
    const std = Math.sqrt(deviations.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    const sorted = [...deviations].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[n - 1];
    const peak_to_peak = max - min;
    const crest_factor = rms > 0 ? max / rms : 0;
    const percentile_95 = sorted[Math.floor(n * 0.95)];

    // Zero crossing rate
    let zeroCrossings = 0;
    for (let i = 1; i < n; i++) {
      if ((deviations[i] - mean) * (deviations[i - 1] - mean) < 0) zeroCrossings++;
    }
    const zero_crossing_rate = zeroCrossings / n;

    // Kurtosis
    const m4 = deviations.reduce((s, v) => s + (v - mean) ** 4, 0) / n;
    const kurtosis = std > 0 ? m4 / (std ** 4) - 3 : 0;

    // Skewness
    const m3 = deviations.reduce((s, v) => s + (v - mean) ** 3, 0) / n;
    const skewness = std > 0 ? m3 / (std ** 3) : 0;

    // Gyroscope RMS
    const gyroMags = window
      .filter(r => r.gx !== undefined)
      .map(r => Math.sqrt((r.gx || 0) ** 2 + (r.gy || 0) ** 2 + (r.gz || 0) ** 2));
    const gyro_rms = gyroMags.length > 0
      ? Math.sqrt(gyroMags.reduce((s, v) => s + v * v, 0) / gyroMags.length)
      : 0;

    // Speed
    const speed_kmh = this.currentSpeed;
    const speed_normalized_rms = speed_kmh > 10 ? rms / (speed_kmh / 50) : rms;

    return {
      rms, std, peak_to_peak, crest_factor, zero_crossing_rate,
      percentile_95, kurtosis, skewness, gyro_rms,
      speed_kmh, speed_normalized_rms,
      timestamp: Date.now(),
    };
  }

  /**
   * Classify road quality from features
   * v0: Simple threshold-based (replaced by TF Lite model in v1)
   */
  private classify(features: WindowFeatures): ClassificationResult {
    const rms = features.speed_normalized_rms;

    let quality_class: QualityClass;
    let quality_score: number;

    if (rms < 1.5) {
      quality_class = 'excellent';
      quality_score = 5.0 - (rms / 1.5) * 0.5;
    } else if (rms < 3.0) {
      quality_class = 'good';
      quality_score = 4.0 - ((rms - 1.5) / 1.5) * 1.0;
    } else if (rms < 5.5) {
      quality_class = 'fair';
      quality_score = 3.0 - ((rms - 3.0) / 2.5) * 1.0;
    } else if (rms < 9.0) {
      quality_class = 'poor';
      quality_score = 2.0 - ((rms - 5.5) / 3.5) * 1.0;
    } else {
      quality_class = 'very_poor';
      quality_score = Math.max(0.5, 1.0 - ((rms - 9.0) / 5.0) * 0.5);
    }

    // Surface type heuristic (replaced by ML model later)
    let surface_type: SurfaceType = 'asphalt';
    if (features.zero_crossing_rate > 0.4 && rms > 3.0) {
      surface_type = 'gravel';
    } else if (features.crest_factor > 5.0) {
      surface_type = 'cobblestone';
    }

    return {
      quality_class,
      quality_score: Math.round(quality_score * 10) / 10,
      surface_type,
      rms: features.rms,
      confidence: features.speed_kmh > 20 ? 70 : 30, // Higher confidence at speed
    };
  }

  get recording(): boolean {
    return this.isRecording;
  }
}

export const sensorService = new SensorService();
