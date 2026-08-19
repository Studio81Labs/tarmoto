# Tarmoto — ML Model Specification

> Road Surface Quality Classification from Smartphone Sensors

Version 1.0 | April 2026

---

## 1. Objective

Build a machine learning model that classifies road surface quality from smartphone accelerometer and gyroscope data. The model must:

- Classify each 100m road segment into quality tiers (Excellent / Good / Fair / Poor / Very Poor)
- Detect surface type (asphalt, concrete, cobblestone, gravel, dirt)
- Run on-device in real-time (TensorFlow Lite, < 50ms inference)
- Work across different phone models, mounting positions, and motorcycle types
- Improve over time with server-side aggregation from multiple riders

---

## 2. System Overview

```
┌──────────────────────────────────────────────────────────┐
│  ON-DEVICE (React Native + TF Lite)                      │
│                                                          │
│  Accelerometer (50Hz) ──→ Feature Extraction ──→ TF Lite │
│  Gyroscope (50Hz) ──────┘   (per window)        Model   │
│  GPS (1Hz) ─────────────────────┐                  │     │
│                                 │                  ▼     │
│                          Segment Builder    Classification│
│                           (100m chunks)     + Confidence  │
│                                 │                  │     │
│                                 ▼                  ▼     │
│                          Upload Queue ◄──── Results       │
└─────────────────────────────────┬────────────────────────┘
                                  │ (batch upload)
┌─────────────────────────────────▼────────────────────────┐
│  SERVER                                                  │
│                                                          │
│  Ingestion ──→ Aggregation ──→ Confidence ──→ PostGIS    │
│     API         Pipeline        Scoring       Storage    │
│                    │                             │       │
│                    ▼                             ▼       │
│             Model Retraining              Vector Tiles   │
│             (periodic, offline)           (map overlay)  │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Input Data

### 3.1 Raw Sensor Streams

| Sensor        | Sample Rate | Fields                              | Purpose                                        |
| ------------- | ----------- | ----------------------------------- | ---------------------------------------------- |
| Accelerometer | 50 Hz       | ax, ay, az (m/s²)                   | Road roughness, bumps, vibration               |
| Gyroscope     | 50 Hz       | gx, gy, gz (rad/s)                  | Lean angle, orientation changes                |
| GPS           | 1 Hz        | lat, lng, speed, accuracy, altitude | Location, speed normalization, segment mapping |

### 3.2 Feature Extraction Window

Sensor data is processed in sliding windows before classification:

| Parameter           | Value                              | Rationale                                     |
| ------------------- | ---------------------------------- | --------------------------------------------- |
| Window size         | 2 seconds (100 samples at 50Hz)    | Captures enough road texture information      |
| Window overlap      | 50% (1 second step)                | Smooth transitions, no data gaps              |
| Segment length      | 100 meters                         | Practical granularity for routing decisions   |
| Samples per segment | ~50-500 windows depending on speed | Aggregated for one classification per segment |

### 3.3 Engineered Features (per window)

**Time-domain features (from accelerometer magnitude):**

| Feature              | Description                                                       | Why                                                      |
| -------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `rms`                | Root mean square of acceleration magnitude deviation from gravity | Primary roughness indicator                              |
| `std`                | Standard deviation of acceleration magnitude                      | Vibration intensity                                      |
| `peak_to_peak`       | Max - Min acceleration in window                                  | Detects potholes and large bumps                         |
| `crest_factor`       | Peak / RMS ratio                                                  | Distinguishes impulse (pothole) from continuous (gravel) |
| `zero_crossing_rate` | Rate of crossing the mean value                                   | Higher for gravel, lower for smooth                      |
| `percentile_95`      | 95th percentile of absolute deviation                             | Robust outlier measure                                   |
| `kurtosis`           | Tailedness of distribution                                        | Spiky (potholes) vs flat (smooth)                        |
| `skewness`           | Asymmetry of distribution                                         | Directional bump pattern                                 |

**Frequency-domain features (FFT of acceleration magnitude):**

| Feature                | Description                          | Why                                                    |
| ---------------------- | ------------------------------------ | ------------------------------------------------------ |
| `spectral_centroid`    | Center of mass of frequency spectrum | Different surfaces have different frequency signatures |
| `spectral_energy_low`  | Energy in 0-5 Hz band                | Large bumps, body roll                                 |
| `spectral_energy_mid`  | Energy in 5-15 Hz band               | Road texture, medium roughness                         |
| `spectral_energy_high` | Energy in 15-25 Hz band              | Fine surface texture, gravel                           |
| `dominant_frequency`   | Frequency with highest amplitude     | Characteristic of surface type                         |
| `spectral_entropy`     | Disorder in frequency distribution   | Uniform (smooth) vs varied (rough)                     |
| `band_ratio_high_low`  | High freq energy / Low freq energy   | Gravel (high ratio) vs pothole (low ratio)             |

**Gyroscope features:**

| Feature          | Description                       | Why                                |
| ---------------- | --------------------------------- | ---------------------------------- |
| `gyro_rms`       | RMS of angular velocity magnitude | Handlebar vibration intensity      |
| `gyro_pitch_var` | Variance of pitch rate            | Forward/backward motion from bumps |
| `gyro_roll_var`  | Variance of roll rate             | Side-to-side from uneven surface   |

**Context features (from GPS):**

| Feature                     | Description                   | Why                                                      |
| --------------------------- | ----------------------------- | -------------------------------------------------------- |
| `speed_kmh`                 | Current speed                 | Critical: vibration increases with speed on ALL surfaces |
| `speed_normalized_rms`      | RMS / speed                   | Removes speed dependency                                 |
| `acceleration_longitudinal` | Forward/backward acceleration | Braking and accelerating add noise                       |

**Total: ~22 features per window**

### 3.4 Speed Normalization

This is the most critical preprocessing step. A smooth road at 100 km/h produces more vibration than a rough road at 20 km/h. Without normalization, the model would classify fast smooth roads as rough.

**Approach:**

- Divide all vibration features by `max(speed_kmh, 10)` to get speed-normalized values
- The `10` floor prevents division by near-zero at stops
- Alternatively, include speed as a feature and let the model learn the relationship
- Both approaches should be tested — normalized features are more interpretable, but raw + speed gives the model more flexibility

**Speed bins for analysis:**

- < 30 km/h: urban / slow — high noise from stops, turns
- 30-60 km/h: suburban — good measurement range
- 60-100 km/h: rural roads — ideal measurement range
- > 100 km/h: highway — less relevant for surface quality

Readings at < 10 km/h should be discarded (stopped at lights, parking) as they contain no useful road surface information.

---

## 4. Model Architecture

### 4.1 On-Device Model (TF Lite)

**Architecture: Lightweight 1D CNN**

```
Input: [batch, 22 features] (one feature vector per window)

Dense(64, ReLU) → BatchNorm → Dropout(0.3)
Dense(32, ReLU) → BatchNorm → Dropout(0.2)
Dense(16, ReLU)

Output heads:
  ├─ Quality: Dense(5, Softmax)     → [excellent, good, fair, poor, very_poor]
  └─ Surface: Dense(5, Softmax)     → [asphalt, cobblestone, gravel, dirt, unknown]
```

**Alternative: Sequence model (if per-window features aren't enough)**

```
Input: [batch, 100 timesteps, 6 channels (ax,ay,az,gx,gy,gz)]

Conv1D(32, kernel=5, ReLU) → MaxPool(2)
Conv1D(64, kernel=5, ReLU) → MaxPool(2)
Conv1D(64, kernel=3, ReLU) → GlobalAvgPool

Dense(32, ReLU) → Dropout(0.3)

Output heads:
  ├─ Quality: Dense(5, Softmax)
  └─ Surface: Dense(5, Softmax)
```

The feature-based approach (first option) is preferred for v1 because:

- Smaller model (~50KB vs ~500KB)
- Faster inference (~5ms vs ~30ms)
- More interpretable (you can inspect which features matter)
- Easier to debug and calibrate thresholds
- The raw sequence model can be explored in v2 if needed

### 4.2 Model Constraints (TF Lite)

| Constraint     | Target                     | Rationale                       |
| -------------- | -------------------------- | ------------------------------- |
| Model size     | < 500 KB                   | Minimal app size impact         |
| Inference time | < 50 ms                    | Real-time on mid-range phones   |
| Memory         | < 10 MB during inference   | No impact on app performance    |
| Battery        | < 2% additional drain/hour | Users must not notice           |
| Quantization   | INT8 post-training         | Reduces size and improves speed |

### 4.3 Server-Side Model

The server model is more powerful — it processes aggregated data from multiple riders:

**Purpose:** Refine quality scores, detect anomalies, retrain on-device model

```
Input per segment: [N rider passes × 22 features] + metadata

Features:
  - Mean, median, std of each feature across all rider passes
  - Number of unique riders
  - Number of passes
  - Time distribution (recency weighting)
  - Device diversity score
  - Speed distribution across passes

Model: Gradient Boosted Trees (XGBoost/LightGBM)
  - More robust than neural nets for tabular data
  - Handles missing features well
  - Feature importance analysis built in
  - No GPU required for inference

Output:
  - quality_score: float 1.0-5.0 (continuous, not categorical)
  - surface_type: categorical
  - confidence: 0-100 (based on pass count and agreement)
```

---

## 5. Training Data Strategy

### 5.1 Data Collection Phases

**Phase 1: Founder Rides (now — May 2026)**

- Target: 200+ km across 3-5 surface types
- Riders: founder + 3-5 friends
- Method: PoC app with manual road tagging
- Phones: iPhone 14/15/16, Samsung Galaxy S23/S24, Pixel 7/8
- Bikes: at least 3 different types (sport, naked, adventure)
- Output: Labeled segments with `road_tag` from PoC

**Phase 2: Beta Campaign (June-August 2026)**

- Target: 5,000+ km, 50+ riders
- Region: CZ/SK/AT
- Method: PoC app distributed to beta testers
- Incentive: early access to premium features
- Key goal: device and bike diversity

**Phase 3: Community Crowdsourcing (post-launch)**

- Continuous data collection from all users
- Manual reviews serve as weak labels
- Anomaly detection flags segments needing re-verification

### 5.2 Labeling Strategy

**Ground truth sources (in priority order):**

1. **Manual tagging during ride** (highest quality)
   - Rider taps "smooth / rough / gravel" in the PoC
   - Timestamp + GPS linked to each tag
   - Each tag applies to all readings until the next tag

2. **Post-ride labeling** (good quality)
   - Rider reviews the ride on a map
   - Marks segments with known conditions
   - Can use Google Street View to verify

3. **OSM surface tags** (weak labels, good for pre-seeding)
   - `surface=asphalt`, `surface=gravel`, `surface=cobblestone` etc.
   - Coverage varies by region — ~30-50% of roads in Central Europe
   - Surface tag doesn't indicate quality (old asphalt can be rough)

4. **Community reviews** (weak labels, post-launch)
   - 1-5 star ratings on segments
   - Aggregated as soft labels for retraining

### 5.3 Label Mapping

**Quality labels (what we're predicting):**

| Label     | Score | Description                               | Typical RMS (est.) |
| --------- | ----- | ----------------------------------------- | ------------------ |
| Excellent | 5     | Fresh smooth asphalt, no defects          | < 1.5              |
| Good      | 4     | Normal asphalt, minor imperfections       | 1.5 - 3.0          |
| Fair      | 3     | Aged asphalt, patches, some cracks        | 3.0 - 5.5          |
| Poor      | 2     | Significant damage, many patches/cracks   | 5.5 - 9.0          |
| Very Poor | 1     | Heavily damaged, potholes, broken surface | > 9.0              |

**Surface type labels:**

| Label       | Typical Vibration Pattern                |
| ----------- | ---------------------------------------- |
| Asphalt     | Low-mid frequency, uniform               |
| Concrete    | Mid frequency, periodic (slab joints)    |
| Cobblestone | High frequency, very regular pattern     |
| Gravel      | High frequency, irregular, high energy   |
| Dirt        | Mid-high frequency, depends on condition |

### 5.4 Data Split

| Set        | Percentage | Purpose               | Constraint                                   |
| ---------- | ---------- | --------------------- | -------------------------------------------- |
| Train      | 70%        | Model training        | Stratified by surface type and quality       |
| Validation | 15%        | Hyperparameter tuning | Same road should not appear in train AND val |
| Test       | 15%        | Final evaluation      | Held-out riders AND roads (no data leakage)  |

**Critical: Split by road segment, not by window.** If the same road appears in both train and test, the model memorizes roads instead of learning surface patterns.

---

## 6. Training Pipeline

### 6.1 Preprocessing

```python
def preprocess_ride(raw_csv_path):
    """
    1. Load raw accelerometer + GPS data
    2. Filter out readings < 10 km/h (stopped)
    3. Remove first/last 30 seconds (startup/shutdown noise)
    4. Apply low-pass filter (25Hz cutoff) to remove phone vibration artifacts
    5. Calculate acceleration magnitude: sqrt(ax² + ay² + az²)
    6. Subtract gravity (9.81) to get deviation
    7. Segment into 2-second windows with 50% overlap
    8. Extract 22 features per window
    9. Group windows into 100m road segments
    10. Aggregate features per segment (mean, std, max)
    11. Apply speed normalization
    12. Attach ground truth label from road tags
    """
    pass
```

### 6.2 Device Calibration

Different phones have different accelerometer characteristics:

- Sensitivity and noise floor vary
- Mounting position (handlebar vs pocket vs tank bag) dramatically affects readings
- Phone case adds damping

**Calibration approach:**

- First 30 seconds of each ride: phone should be stationary on the mounted bike
- Record baseline vibration at idle
- Subtract device-specific noise floor from all readings
- Alternatively: include `device_model` as a categorical feature and let the model learn per-device adjustments

### 6.3 Data Augmentation

- **Speed jitter:** Add ±5% random noise to speed values (robustness to GPS inaccuracy)
- **Amplitude scaling:** Scale acceleration values by 0.8-1.2x (simulates different phone sensitivities)
- **Window shift:** Shift window start by ±0.5 seconds (reduces segment boundary sensitivity)
- **Synthetic mixtures:** Blend features from two segments to create borderline examples (helps with class boundaries)

### 6.4 Class Imbalance

Real-world distribution will be heavily skewed toward "Good" and "Excellent" (most roads are fine). Expected:

| Quality   | Expected % | Strategy                     |
| --------- | ---------- | ---------------------------- |
| Excellent | ~35%       | Undersample                  |
| Good      | ~30%       | Keep as-is                   |
| Fair      | ~20%       | Keep as-is                   |
| Poor      | ~10%       | Oversample 2x                |
| Very Poor | ~5%        | Oversample 3x + augmentation |

Use class weights in the loss function: `weight = 1 / class_frequency`

---

## 7. Evaluation Metrics

### 7.1 Primary Metrics

| Metric                         | Target | Why                                                                                         |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------- |
| **Weighted F1**                | > 0.80 | Balanced measure across imbalanced classes                                                  |
| **Adjacent accuracy**          | > 0.95 | Prediction within ±1 class (e.g. predicting "Good" when truth is "Excellent" is acceptable) |
| **Confusion between extremes** | < 2%   | Predicting "Excellent" when road is "Poor" is dangerous — must be near zero                 |

### 7.2 Secondary Metrics

| Metric                      | Target | Why                                                       |
| --------------------------- | ------ | --------------------------------------------------------- |
| Mean Absolute Error (score) | < 0.5  | On the 1-5 scale, average error should be small           |
| Surface type accuracy       | > 0.85 | Secondary task, useful but less critical                  |
| Cross-device agreement      | > 0.80 | Same road, different phones → same classification         |
| Cross-bike agreement        | > 0.75 | Same road, different motorcycles → similar classification |

### 7.3 Safety Metric

The most important metric is the **dangerous misclassification rate**: how often does the model say a road is Excellent or Good when it's actually Poor or Very Poor?

**Target: < 1%**

This is checked separately because it has real safety implications — a rider trusting a "green" road that's actually potholed could crash.

---

## 8. Deployment

### 8.1 On-Device Deployment

```
Model file: tarmoto_road_quality_v1.tflite (~100-500 KB)
Bundled with app, updated via OTA

Inference pipeline:
  1. Sensor data streams into a ring buffer (2 sec window)
  2. Every 1 second: extract features from current window
  3. Run TF Lite inference → quality + surface prediction
  4. Store result with GPS coordinates in local DB
  5. Every 100m of travel: aggregate all window predictions
     → majority vote for quality class
     → weighted average for quality score
     → store as segment result
  6. Display current quality on ride screen
  7. Batch upload segment results to server every 5 minutes (or on WiFi)
```

### 8.2 Model Updates

```
v1.0: Initial model trained on founder ride data (~200 km)
      - Simple feature thresholds as fallback
      - Conservative: may under-classify (say "Fair" when it's "Good")

v1.1: Retrained after beta campaign (~5,000 km, 50 riders)
      - Device-specific calibration learned
      - Speed normalization refined

v2.0: Sequence model (1D CNN on raw accelerometer)
      - Only if feature-based model plateaus below targets
      - Requires more training data (~50,000+ km)

Model updates delivered via app update or OTA model download
(TF Lite model file can be downloaded separately from app binary)
```

### 8.3 Server-Side Aggregation

When multiple riders traverse the same segment:

```python
def aggregate_segment_quality(readings):
    """
    Input: list of quality readings from different riders

    1. Remove outliers (readings > 2 std from mean)
    2. Apply recency weighting:
       - Last 30 days: weight = 1.0
       - 30-90 days: weight = 0.7
       - 90-180 days: weight = 0.4
       - > 180 days: weight = 0.2
    3. Apply confidence based on reader count:
       - 1 reading: confidence = 20
       - 3 readings: confidence = 50
       - 5 readings: confidence = 70
       - 10+ readings: confidence = 90
       - 20+ readings from 5+ unique riders: confidence = 100
    4. Weighted average → final quality score
    5. Mode → surface type classification
    """
    pass
```

---

## 9. Fallback Strategy

If the ML model doesn't reach acceptable accuracy:

### Level 1: Better Features

- Add frequency-domain features (FFT, wavelet transform)
- Use gyroscope data more aggressively
- Explore phone-specific calibration models

### Level 2: Different Model Architecture

- 1D CNN on raw sensor data (bypass feature engineering)
- LSTM/GRU for temporal patterns across windows
- Multi-task learning with auxiliary objectives (speed prediction, bike type)

### Level 3: Hybrid Approach

- ML model provides a rough estimate
- Community ratings refine the score
- High-confidence segments labeled by ML, low-confidence flagged for manual review
- OSM surface tags as prior: if OSM says "gravel", bias the model toward gravel-like predictions

### Level 4: Manual-First Approach (no ML)

- Road quality from community ratings only (1-5 stars per segment)
- Surface type from OSM tags + manual reports
- Accelerometer used only for pothole/bump detection (simpler binary classification)
- This still provides value — just without the "every rider is a sensor" automation

---

## 10. Risks & Mitigations

| Risk                                                           | Impact | Mitigation                                                                                                                                   |
| -------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone mounting position varies wildly                          | High   | Calibration routine + include orientation features. Recommend handlebar mount in onboarding.                                                 |
| Motorcycle suspension absorbs vibration differently            | High   | Include bike_type as feature. Adventure bikes with long travel will dampen readings vs sport bikes.                                          |
| Speed strongly correlates with vibration                       | High   | Speed normalization in preprocessing. Discard readings < 10 km/h.                                                                            |
| Cobblestone classified as "Poor" quality when it's intentional | Medium | Surface type is a separate output. Cobblestone can have high quality AND high vibration. Quality score should consider surface type context. |
| Not enough labeled data for rare classes                       | Medium | Data augmentation, class weighting, active learning (flag uncertain predictions for manual labeling).                                        |
| Model drift over time as phones and roads change               | Low    | Periodic retraining schedule. Monitor prediction distributions for drift.                                                                    |
| Privacy: raw accelerometer data could be re-identified via GPS | High   | Anonymize before upload. Strip user IDs from sensor data. Aggregate at segment level server-side.                                            |

---

## 11. Success Criteria for PoC Validation

Before committing to full model development, the PoC ride data must show:

| Test                           | Pass Criteria                                                         | Method                     |
| ------------------------------ | --------------------------------------------------------------------- | -------------------------- |
| **Smooth vs Rough separation** | Mean RMS differs by > 2x between tagged "smooth" and "rough" segments | Box plot comparison        |
| **Gravel distinctiveness**     | Gravel has different frequency profile than rough asphalt             | FFT spectral analysis      |
| **Speed independence**         | Speed-normalized RMS is consistent across 30-100 km/h on same road    | Scatter plot + correlation |
| **Cross-device agreement**     | Two phones on same bike produce similar relative rankings             | Paired ride test           |
| **Repeatability**              | Same road ridden twice produces similar RMS (±20%)                    | Repeated ride comparison   |

If 4 out of 5 tests pass → proceed with ML model development.
If 2-3 pass → investigate Level 1-2 fallbacks.
If < 2 pass → pivot to Level 3-4 (manual approach).

---

## 12. Timeline

| Phase                                | Timeline         | Deliverable                                  |
| ------------------------------------ | ---------------- | -------------------------------------------- |
| PoC rides + data collection          | April-May 2026   | 200+ km labeled ride data                    |
| Data analysis + validation           | May 2026         | Pass/fail decision on accelerometer approach |
| Feature engineering + baseline model | June 2026        | v0.1 model with threshold-based fallback     |
| Beta data collection                 | June-August 2026 | 5,000+ km from 50+ riders                    |
| Model v1.0 training                  | August 2026      | TF Lite model ready for app integration      |
| Integration + on-device testing      | September 2026   | Running in React Native app                  |
| Server aggregation pipeline          | September 2026   | Multi-rider quality scoring                  |
| Model v1.1 (beta-tuned)              | October 2026     | Refined model for MVP launch                 |

---

## 13. Tools & Libraries

### Training Pipeline (Python)

| Tool                | Purpose                              |
| ------------------- | ------------------------------------ |
| Python 3.11+        | Training pipeline                    |
| pandas, numpy       | Data processing                      |
| scikit-learn        | Feature engineering, baseline models |
| XGBoost / LightGBM  | Server-side model                    |
| TensorFlow / Keras  | On-device neural network model       |
| TensorFlow Lite     | Model conversion and optimization    |
| scipy.signal        | FFT, filtering, signal processing    |
| matplotlib, seaborn | Analysis and visualization           |
| MLflow              | Experiment tracking                  |
| DVC                 | Data versioning                      |

### On-Device (React Native)

| Package                               | Purpose                            |
| ------------------------------------- | ---------------------------------- |
| `react-native-tflite`                 | TensorFlow Lite inference          |
| `react-native-sensors`                | Accelerometer + Gyroscope access   |
| `@react-native-community/geolocation` | GPS positioning                    |
| `react-native-background-actions`     | Background sensor recording        |
| `@maplibre/maplibre-react-native`     | Map rendering with quality overlay |
| `react-native-carplay`                | CarPlay integration                |

### Backend (NestJS)

| Package               | Purpose                              |
| --------------------- | ------------------------------------ |
| `@nestjs/swagger`     | Auto-generated OpenAPI from DTOs     |
| `@nestjs/websockets`  | Real-time hazard alerts              |
| `typeorm` + `postgis` | Database with geospatial queries     |
| `bull` / `bullmq`     | Job queue for sensor data processing |

---

_End of Document_

**Tarmoto — Know the road before you ride it.**
