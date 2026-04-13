import { useState, useRef, useEffect, useCallback } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Classification {
  label: string;
  color: string;
  score: number;
}

interface GPSData {
  lat: number;
  lng: number;
  speed: number | null;
  accuracy: number | null;
}

interface Segment extends Classification {
  rms: number;
  distance: number;
  lat?: number;
  lng?: number;
  samples: number;
  timestamp: number;
  tag: string;
  partial?: boolean;
}

interface RawReading {
  t: number;
  ax: number | null;
  ay: number | null;
  az: number | null;
  mag: number;
  deviation: number;
  tag: string;
  lat?: number;
  lng?: number;
  speed?: number | null;
  accuracy?: number | null;
}

interface TagEvent {
  tag: string;
  timestamp: number;
  lat?: number;
  lng?: number;
  distance: number;
}

interface TagLogEntry {
  tag: string;
  distance: number;
  timeLabel: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const SEGMENT_LEN = 100;
const GRAPH_PTS = 200;

const TAG_OPTIONS: Array<{ id: string; icon: string; name: string }> = [
  { id: "smooth", icon: "\u{1F6E3}\uFE0F", name: "Smooth" },
  { id: "rough", icon: "\u{1F6A7}", name: "Rough" },
  { id: "gravel", icon: "\u{1FAA8}", name: "Gravel" },
  { id: "cobblestone", icon: "\u{1F9F1}", name: "Cobblestone" },
  { id: "dirt", icon: "\u{1F33F}", name: "Dirt" },
  { id: "unknown", icon: "\u2753", name: "Unknown" },
];

const TAG_COLORS: Record<string, string> = {
  smooth: "#22c55e",
  rough: "#f97316",
  gravel: "#eab308",
  cobblestone: "#a78bfa",
  dirt: "#78716c",
  unknown: "#64748b",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function haversine(a: number, b: number, c: number, d: number): number {
  const R = 6371000;
  const x = ((c - a) * Math.PI) / 180;
  const y = ((d - b) * Math.PI) / 180;
  const s =
    Math.sin(x / 2) ** 2 +
    Math.cos((a * Math.PI) / 180) *
      Math.cos((c * Math.PI) / 180) *
      Math.sin(y / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function classify(rms: number): Classification {
  if (rms < 1.5) return { label: "Excellent", color: "#22c55e", score: 5 };
  if (rms < 3) return { label: "Good", color: "#84cc16", score: 4 };
  if (rms < 5.5) return { label: "Fair", color: "#eab308", score: 3 };
  if (rms < 9) return { label: "Poor", color: "#f97316", score: 2 };
  return { label: "Very poor", color: "#ef4444", score: 1 };
}

function fmtDur(s: number): string {
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function downloadBlob(content: string, mimeType: string, filename: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function PocSensor() {
  /* ---- state ---- */
  const [recording, setRecording] = useState(false);
  const [sensorError, setSensorError] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [showSetup, setShowSetup] = useState(true);
  const [showTagSection, setShowTagSection] = useState(false);
  const [showQualityBanner, setShowQualityBanner] = useState(false);
  const [showStatsGrid, setShowStatsGrid] = useState(false);
  const [showGraphSection, setShowGraphSection] = useState(false);
  const [showSegmentsSection, setShowSegmentsSection] = useState(false);
  const [showExportSection, setShowExportSection] = useState(false);
  const [btnStartLabel, setBtnStartLabel] = useState("Start recording");

  const [riderId, setRiderId] = useState("");
  const [gpsToggle, setGpsToggle] = useState(true);
  const [wakelockToggle, setWakelockToggle] = useState(true);

  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [currentTagDisplay, setCurrentTagDisplay] = useState<{
    tag: string;
    color: string;
  } | null>(null);
  const [tagLog, setTagLog] = useState<TagLogEntry[]>([]);

  const [qbLabel, setQbLabel] = useState("\u2014");
  const [qbRms, setQbRms] = useState("0.0");
  const [qbColor, setQbColor] = useState("#0ED3CF");

  const [speed, setSpeed] = useState("0");
  const [dist, setDist] = useState("0");
  const [distUnit, setDistUnit] = useState("m");
  const [time, setTime] = useState("0:00");
  const [samples, setSamples] = useState("0");
  const [gpsAcc, setGpsAcc] = useState("");

  const [segments, setSegments] = useState<Segment[]>([]);
  const [exportInfo, setExportInfo] = useState("");

  /* ---- refs (mutable buffers, not triggering re-renders) ---- */
  const accelBufRef = useRef<number[]>([]);
  const segBufRef = useRef<number[]>([]);
  const graphBufRef = useRef<number[]>([]);
  const rawDataRef = useRef<RawReading[]>([]);
  const tagEventsRef = useRef<TagEvent[]>([]);
  const segmentsRef = useRef<Segment[]>([]);

  const lastGPSRef = useRef<GPSData | null>(null);
  const segDistRef = useRef(0);
  const totalDistRef = useRef(0);
  const sampleCountRef = useRef(0);
  const currentTagRef = useRef("unknown");
  const currentColorRef = useRef("#0ED3CF");

  const recordingRef = useRef(false);
  const startTimeRef = useRef<number | null>(null);
  const gpsEnabledRef = useRef(true);

  const watchIdRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const permGrantedRef = useRef(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tagLogRef = useRef<HTMLDivElement>(null);
  const segListRef = useRef<HTMLDivElement>(null);

  /* ---- initialize rider ID from localStorage ---- */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem("tm_rider");
    if (stored) setRiderId(stored);

    if (!("DeviceMotionEvent" in window)) {
      setSensorError(true);
    }
  }, []);

  /* ---- rider ID persistence ---- */
  const handleRiderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setRiderId(e.target.value);
      localStorage.setItem("tm_rider", e.target.value);
    },
    []
  );

  /* ---- helpers ---- */
  const getRiderId = useCallback(() => {
    return riderId.trim() || "anonymous";
  }, [riderId]);

  /* ---- canvas draw ---- */
  const drawGraph = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const buf = graphBufRef.current;
    if (buf.length < 2) return;
    const max = Math.max(...buf, 15);
    ctx.beginPath();
    ctx.strokeStyle = currentColorRef.current;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < buf.length; i++) {
      const x = (i / (buf.length - 1)) * w;
      const y = h - (buf[i] / max) * (h - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, []);

  /* ---- update quality banner ---- */
  const updateQB = useCallback((rms: number, cls: Classification) => {
    setShowQualityBanner(true);
    setQbLabel(cls.label);
    setQbRms(rms.toFixed(1));
    setQbColor(cls.color);
  }, []);

  /* ---- update segments UI ---- */
  const updateSegmentsUI = useCallback((segs: Segment[]) => {
    setSegments([...segs]);
  }, []);

  /* ---- motion handler ---- */
  const handleMotion = useCallback(
    (e: DeviceMotionEvent) => {
      if (!recordingRef.current) return;
      const a = e.accelerationIncludingGravity;
      if (!a || a.z === null) return;

      const mag = Math.sqrt(
        (a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2
      );
      const dev = Math.abs(mag - 9.81);

      sampleCountRef.current++;
      accelBufRef.current.push(dev);
      segBufRef.current.push(dev);

      const r: RawReading = {
        t: Date.now(),
        ax: a.x,
        ay: a.y,
        az: a.z,
        mag,
        deviation: dev,
        tag: currentTagRef.current,
      };
      const gps = lastGPSRef.current;
      if (gpsEnabledRef.current && gps) {
        r.lat = gps.lat;
        r.lng = gps.lng;
        r.speed = gps.speed;
        r.accuracy = gps.accuracy;
      }
      rawDataRef.current.push(r);

      if (accelBufRef.current.length >= 25) {
        const buf = accelBufRef.current;
        const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
        accelBufRef.current = [];
        const cls = classify(rms);
        currentColorRef.current = cls.color;
        updateQB(rms, cls);
        graphBufRef.current.push(rms);
        if (graphBufRef.current.length > GRAPH_PTS) {
          graphBufRef.current = graphBufRef.current.slice(-GRAPH_PTS);
        }
        drawGraph();
      }
    },
    [updateQB, drawGraph]
  );

  /* ---- permissions ---- */
  const requestPerms = useCallback(async (): Promise<boolean> => {
    setErrorMsg("");
    const gpsOn = gpsToggle;
    try {
      // iOS DeviceMotion permission
      const DME = DeviceMotionEvent as unknown as {
        requestPermission?: () => Promise<string>;
      };
      if (typeof DME.requestPermission === "function") {
        const p = await DME.requestPermission();
        if (p !== "granted") {
          setErrorMsg("Motion sensor permission denied.");
          return false;
        }
      }
      if (gpsOn) {
        await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 10000,
          })
        );
      }
      permGrantedRef.current = true;
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown";
      setErrorMsg("Permission error: " + msg);
      return false;
    }
  }, [gpsToggle]);

  /* ---- set tag ---- */
  const setTag = useCallback((tag: string) => {
    currentTagRef.current = tag;
    setActiveTag(tag);
    tagEventsRef.current.push({
      tag,
      timestamp: Date.now(),
      lat: lastGPSRef.current?.lat,
      lng: lastGPSRef.current?.lng,
      distance: Math.round(totalDistRef.current),
    });
    setCurrentTagDisplay({ tag, color: TAG_COLORS[tag] });
    const entry: TagLogEntry = {
      tag,
      distance: Math.round(totalDistRef.current),
      timeLabel: fmtDur(
        Math.floor(
          (Date.now() - (startTimeRef.current || Date.now())) / 1000
        )
      ),
    };
    setTagLog((prev) => [...prev, entry]);
    // scroll log to bottom
    setTimeout(() => {
      if (tagLogRef.current) {
        tagLogRef.current.scrollTop = tagLogRef.current.scrollHeight;
      }
    }, 0);
  }, []);

  /* ---- start recording ---- */
  const startRecording = useCallback(async () => {
    if (!permGrantedRef.current) {
      if (!(await requestPerms())) return;
    }

    const gpsOn = gpsToggle;
    gpsEnabledRef.current = gpsOn;
    recordingRef.current = true;
    setRecording(true);
    startTimeRef.current = Date.now();

    // Reset buffers
    accelBufRef.current = [];
    segBufRef.current = [];
    graphBufRef.current = [];
    segmentsRef.current = [];
    rawDataRef.current = [];
    tagEventsRef.current = [];
    lastGPSRef.current = null;
    segDistRef.current = 0;
    totalDistRef.current = 0;
    sampleCountRef.current = 0;
    currentTagRef.current = "unknown";
    currentColorRef.current = "#0ED3CF";

    // UI state
    setShowSetup(false);
    setShowTagSection(true);
    setShowStatsGrid(true);
    setShowGraphSection(true);
    setShowSegmentsSection(false);
    setShowExportSection(false);
    setShowQualityBanner(false);
    setErrorMsg("");
    setSegments([]);
    setTagLog([]);
    setActiveTag(null);
    setCurrentTagDisplay(null);
    setSpeed("0");
    setDist("0");
    setDistUnit("m");
    setTime("0:00");
    setSamples("0");
    setGpsAcc("");

    // Clear canvas
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    // Wake lock
    if (wakelockToggle && "wakeLock" in navigator) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      } catch {
        // ignore
      }
    }

    // Motion listener
    window.addEventListener("devicemotion", handleMotion as EventListener);

    // GPS
    if (gpsOn) {
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          const { latitude: lat, longitude: lng, speed: spd, accuracy: acc } =
            pos.coords;
          const prev = lastGPSRef.current;
          if (prev) {
            const d = haversine(prev.lat, prev.lng, lat, lng);
            if (d > 1 && d < 500) {
              segDistRef.current += d;
              totalDistRef.current += d;
            }
            if (
              segDistRef.current >= SEGMENT_LEN &&
              segBufRef.current.length > 10
            ) {
              const buf = segBufRef.current;
              const rms = Math.sqrt(
                buf.reduce((s, v) => s + v * v, 0) / buf.length
              );
              const cls = classify(rms);
              segmentsRef.current.push({
                rms,
                ...cls,
                distance: segDistRef.current,
                lat,
                lng,
                samples: buf.length,
                timestamp: Date.now(),
                tag: currentTagRef.current,
              });
              segBufRef.current = [];
              segDistRef.current = 0;
              setShowSegmentsSection(true);
              updateSegmentsUI(segmentsRef.current);
            }
          }
          lastGPSRef.current = { lat, lng, speed: spd, accuracy: acc };
          setSpeed(String(Math.round((spd || 0) * 3.6)));
          setGpsAcc(acc ? "\u00B1" + Math.round(acc) + "m" : "");
        },
        (e) => console.warn("GPS:", e.message),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 }
      );
    }

    // Timer
    timerRef.current = setInterval(() => {
      const d = Math.floor(
        (Date.now() - (startTimeRef.current || Date.now())) / 1000
      );
      setTime(fmtDur(d));
      const td = totalDistRef.current;
      setDist(td > 1000 ? (td / 1000).toFixed(1) : String(Math.round(td)));
      setDistUnit(td > 1000 ? "km" : "m");
      const sc = sampleCountRef.current;
      setSamples(sc > 1000 ? (sc / 1000).toFixed(1) + "k" : String(sc));
    }, 500);
  }, [
    gpsToggle,
    wakelockToggle,
    requestPerms,
    handleMotion,
    updateSegmentsUI,
  ]);

  /* ---- stop recording ---- */
  const stopRecording = useCallback(() => {
    recordingRef.current = false;
    setRecording(false);

    window.removeEventListener("devicemotion", handleMotion as EventListener);

    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (wakeLockRef.current) {
      try {
        wakeLockRef.current.release();
      } catch {
        // ignore
      }
      wakeLockRef.current = null;
    }

    // Flush remaining segment
    if (segBufRef.current.length > 10 && segDistRef.current > 20) {
      const buf = segBufRef.current;
      const rms = Math.sqrt(
        buf.reduce((s, v) => s + v * v, 0) / buf.length
      );
      const cls = classify(rms);
      segmentsRef.current.push({
        rms,
        ...cls,
        distance: segDistRef.current,
        lat: lastGPSRef.current?.lat,
        lng: lastGPSRef.current?.lng,
        samples: buf.length,
        timestamp: Date.now(),
        tag: currentTagRef.current,
        partial: true,
      });
      setShowSegmentsSection(true);
      updateSegmentsUI(segmentsRef.current);
    }

    setShowQualityBanner(false);
    setShowTagSection(false);
    setShowSetup(true);
    setBtnStartLabel("Start new recording");

    if (rawDataRef.current.length > 0) {
      setShowExportSection(true);
      const raw = rawDataRef.current.length;
      const segs = segmentsRef.current.length;
      const tags = tagEventsRef.current.length;
      setExportInfo(
        "Collected " +
          raw +
          " raw readings" +
          (segs ? " + " + segs + " segments" : "") +
          " \u00B7 " +
          tags +
          " road tags"
      );
    }
  }, [handleMotion, updateSegmentsUI]);

  /* ---- exports ---- */
  const exportCSV = useCallback(
    (type: "segments" | "raw") => {
      const date = new Date().toISOString().slice(0, 10);
      const rider = getRiderId();
      let csv = "";
      let fn = "";

      if (type === "segments") {
        csv =
          "rider,index,timestamp,lat,lng,rms,classification,score,distance_m,samples,road_tag\n";
        segmentsRef.current.forEach((s, i) => {
          csv +=
            rider +
            "," +
            i +
            "," +
            new Date(s.timestamp).toISOString() +
            "," +
            (s.lat || "") +
            "," +
            (s.lng || "") +
            "," +
            s.rms.toFixed(3) +
            "," +
            s.label.toLowerCase().replace(" ", "_") +
            "," +
            s.score +
            "," +
            Math.round(s.distance) +
            "," +
            s.samples +
            "," +
            (s.tag || "unknown") +
            "\n";
        });
        fn = "tarmoto_segments_" + rider + "_" + date + ".csv";
      } else {
        csv =
          "rider,timestamp,ax,ay,az,deviation,lat,lng,speed_kmh,accuracy,road_tag\n";
        rawDataRef.current.forEach((r) => {
          csv +=
            rider +
            "," +
            r.t +
            "," +
            (r.ax?.toFixed(3) || "") +
            "," +
            (r.ay?.toFixed(3) || "") +
            "," +
            (r.az?.toFixed(3) || "") +
            "," +
            (r.deviation?.toFixed(4) || "") +
            "," +
            (r.lat?.toFixed(6) || "") +
            "," +
            (r.lng?.toFixed(6) || "") +
            "," +
            (r.speed != null ? (r.speed * 3.6).toFixed(1) : "") +
            "," +
            (r.accuracy?.toFixed(1) || "") +
            "," +
            (r.tag || "unknown") +
            "\n";
        });
        fn = "tarmoto_raw_" + rider + "_" + date + ".csv";
      }

      downloadBlob(csv, "text/csv", fn);
    },
    [getRiderId]
  );

  const exportJSON = useCallback(() => {
    // Bug fix: define `date` here (original poc.html references `date` from
    // exportCSV scope, which is not accessible in exportData/exportJSON)
    const date = new Date().toISOString().slice(0, 10);
    const dur = Math.floor(
      (Date.now() - (startTimeRef.current || Date.now())) / 1000
    );
    const rider = getRiderId();

    const data = {
      metadata: {
        app: "Tarmoto PoC",
        version: "0.2.0",
        rider,
        recorded: new Date(startTimeRef.current || Date.now()).toISOString(),
        duration_s: dur,
        distance_m: Math.round(totalDistRef.current),
        total_samples: rawDataRef.current.length,
        segment_length_m: SEGMENT_LEN,
        gps_enabled: gpsEnabledRef.current,
        device: navigator.userAgent,
      },
      tag_events: tagEventsRef.current.map((e) => ({
        tag: e.tag,
        timestamp: new Date(e.timestamp).toISOString(),
        lat: e.lat,
        lng: e.lng,
        distance_m: e.distance,
      })),
      segments: segmentsRef.current.map((s, i) => ({
        index: i,
        rms: +s.rms.toFixed(3),
        classification: s.label.toLowerCase().replace(" ", "_"),
        score: s.score,
        distance_m: Math.round(s.distance),
        lat: s.lat,
        lng: s.lng,
        samples: s.samples,
        road_tag: s.tag,
        timestamp: new Date(s.timestamp).toISOString(),
      })),
      raw_readings: rawDataRef.current.map((r) => ({
        t: r.t,
        ax: r.ax?.toFixed(3),
        ay: r.ay?.toFixed(3),
        az: r.az?.toFixed(3),
        deviation: r.deviation?.toFixed(4),
        lat: r.lat?.toFixed(6),
        lng: r.lng?.toFixed(6),
        speed: r.speed?.toFixed(1),
        tag: r.tag,
      })),
    };

    downloadBlob(
      JSON.stringify(data, null, 2),
      "application/json",
      "tarmoto_ride_" + rider + "_" + date + ".json"
    );
  }, [getRiderId]);

  /* ---- cleanup on unmount ---- */
  useEffect(() => {
    return () => {
      window.removeEventListener("devicemotion", handleMotion as EventListener);
      if (watchIdRef.current != null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      if (timerRef.current) clearInterval(timerRef.current);
      if (wakeLockRef.current) {
        try {
          wakeLockRef.current.release();
        } catch {
          // ignore
        }
      }
    };
  }, [handleMotion]);

  /* ---- segment-derived data ---- */
  const segmentBadges = (() => {
    const labels: Array<{ label: string; rmsHint: number }> = [
      { label: "Excellent", rmsHint: 0.5 },
      { label: "Good", rmsHint: 2 },
      { label: "Fair", rmsHint: 4 },
      { label: "Poor", rmsHint: 7 },
      { label: "Very poor", rmsHint: 10 },
    ];
    return labels
      .map(({ label, rmsHint }) => {
        const cnt = segments.filter((s) => s.label === label).length;
        if (!cnt) return null;
        const cls = classify(rmsHint);
        return { label, cnt, color: cls.color };
      })
      .filter(Boolean) as Array<{
      label: string;
      cnt: number;
      color: string;
    }>;
  })();

  /* ------------------------------------------------------------------ */
  /*  Render                                                             */
  /* ------------------------------------------------------------------ */

  return (
    <>
      <div className="header">
        <div className="header-inner">
          <div className="logo">
            <svg width="22" height="22" viewBox="0 0 100 100" fill="none">
              <rect x="18" y="20" width="64" height="12" rx="4" fill="#0f172a" />
              <rect x="40" y="20" width="20" height="42" rx="4" fill="#0f172a" />
              <path
                d="M 16 80 L 30 80 L 38 70 L 46 86 L 54 68 L 62 82 L 70 76 L 84 76"
                stroke="#0f172a"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </div>
          <div className="logo-text">
            <h1>TARMOTO</h1>
            <p>Road Quality Sensor — PoC v0.2</p>
          </div>
        </div>
      </div>

      <div className="content">
        {/* Sensor error */}
        {sensorError && (
          <div className="card sensor-error">
            <p style={{ fontWeight: 700, fontSize: "13px" }}>
              Motion sensors not available
            </p>
            <p className="sub">
              This device doesn&apos;t support the DeviceMotion API. Try on a
              smartphone (iOS Safari or Android Chrome).
            </p>
          </div>
        )}

        {/* Error box */}
        {errorMsg && <div className="error-box">{errorMsg}</div>}

        {/* Privacy notice */}
        <div className="privacy-box">
          <p className="title">{"\uD83D\uDD12"} Privacy notice</p>
          <p>
            All data stays on your device — nothing is uploaded to any server.
            Exported files are saved locally. GPS recording can be turned off
            below if you prefer to record vibration data only.
          </p>
        </div>

        {/* Setup section */}
        {showSetup && (
          <div id="setup-section">
            <div className="card">
              <p className="label">RIDER NICKNAME</p>
              <input
                type="text"
                className="input-field"
                placeholder="e.g. Martin_CZ"
                maxLength={30}
                autoComplete="off"
                value={riderId}
                onChange={handleRiderChange}
              />
              <p style={{ color: "#475569", fontSize: "10px", marginTop: "6px" }}>
                Used to identify your data when multiple testers export files.
              </p>
            </div>

            <div className="card">
              <p className="label">SETTINGS</p>
              <div
                className="toggle-row"
                style={{
                  borderBottom: "1px solid rgba(255,255,255,.04)",
                  paddingBottom: "12px",
                }}
              >
                <div>
                  <p className="toggle-label">Record GPS location</p>
                  <p className="toggle-sub">
                    Needed for map overlay &amp; segment distance
                  </p>
                </div>
                <div className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={gpsToggle}
                    onChange={(e) => setGpsToggle(e.target.checked)}
                  />
                  <div className="toggle-track" />
                  <div className="toggle-thumb" />
                </div>
              </div>
              <div className="toggle-row">
                <div>
                  <p className="toggle-label">Keep screen awake</p>
                  <p className="toggle-sub">
                    Prevents screen lock during ride
                  </p>
                </div>
                <div className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={wakelockToggle}
                    onChange={(e) => setWakelockToggle(e.target.checked)}
                  />
                  <div className="toggle-track" />
                  <div className="toggle-thumb" />
                </div>
              </div>
            </div>

            <div className="card">
              <p className="label">HOW TO TEST</p>
              <p className="step">
                1. Mount your phone securely on the handlebars
              </p>
              <p className="step">2. Enter a nickname above</p>
              <p className="step">
                3. Tap &quot;Start recording&quot; and allow sensor access
              </p>
              <p className="step">4. Ride! Tag the road type as you go</p>
              <p className="step" style={{ margin: 0 }}>
                5. Stop and export the data as CSV
              </p>
              <div className="tip">
                {"\uD83D\uDCA1"} Ride roads you know well — smooth, rough, and
                gravel if possible. Tag each section for better training data.
              </div>
            </div>
          </div>
        )}

        {/* Start / Stop buttons */}
        {!recording ? (
          <button
            className="btn btn-primary"
            disabled={sensorError}
            onClick={startRecording}
          >
            {btnStartLabel}
          </button>
        ) : (
          <button className="btn btn-danger" onClick={stopRecording}>
            Stop recording
          </button>
        )}

        {/* Road type tagger */}
        {showTagSection && (
          <div style={{ marginTop: "16px" }}>
            <p className="label">TAP TO TAG CURRENT ROAD TYPE</p>
            <div className="tag-grid">
              {TAG_OPTIONS.map((opt) => (
                <div
                  key={opt.id}
                  className={
                    "tag-btn" + (activeTag === opt.id ? " active" : "")
                  }
                  onClick={() => setTag(opt.id)}
                >
                  <div className="icon">{opt.icon}</div>
                  <div className="name">{opt.name}</div>
                </div>
              ))}
            </div>
            <div
              style={{
                marginTop: "8px",
                textAlign: "center",
                fontSize: "11px",
                color: "#475569",
              }}
            >
              {currentTagDisplay ? (
                <>
                  Current:{" "}
                  <b style={{ color: currentTagDisplay.color }}>
                    {currentTagDisplay.tag}
                  </b>
                </>
              ) : (
                "No tag set \u2014 tap a road type above"
              )}
            </div>
            <div
              ref={tagLogRef}
              style={{ marginTop: "8px", maxHeight: "80px", overflowY: "auto" }}
            >
              {tagLog.map((entry, i) => (
                <div key={i} className="tag-event">
                  <div
                    className="dot"
                    style={{ background: TAG_COLORS[entry.tag] }}
                  />
                  <span
                    style={{
                      color: TAG_COLORS[entry.tag],
                      fontWeight: 600,
                    }}
                  >
                    {entry.tag}
                  </span>
                  <span>
                    at {entry.distance}m / {entry.timeLabel}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quality banner */}
        {showQualityBanner && (
          <div
            className="quality-banner"
            style={{
              background: qbColor + "15",
              border: "1px solid " + qbColor + "40",
            }}
          >
            <div>
              <p
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  letterSpacing: ".06em",
                  color: qbColor,
                }}
              >
                CURRENT ROAD QUALITY
              </p>
              <p
                style={{
                  fontSize: "22px",
                  fontWeight: 900,
                  marginTop: "4px",
                  color: qbColor,
                }}
              >
                {qbLabel}
              </p>
            </div>
            <div style={{ textAlign: "right" }}>
              <p
                style={{
                  fontSize: "28px",
                  fontWeight: 900,
                  opacity: 0.9,
                  color: qbColor,
                }}
              >
                {qbRms}
              </p>
              <p
                style={{
                  fontSize: "10px",
                  opacity: 0.5,
                  color: qbColor,
                }}
              >
                RMS vibration
              </p>
            </div>
          </div>
        )}

        {/* Stats grid */}
        {showStatsGrid && (
          <div className="stats-grid">
            <div className="stat">
              <p className="stat-label">SPEED</p>
              <p className="stat-value">{speed}</p>
              <p className="stat-unit">km/h</p>
            </div>
            <div className="stat">
              <p className="stat-label">DISTANCE</p>
              <p className="stat-value">{dist}</p>
              <p className="stat-unit">{distUnit}</p>
            </div>
            <div className="stat">
              <p className="stat-label">TIME</p>
              <p className="stat-value">{time}</p>
              <p className="stat-unit" />
            </div>
            <div className="stat">
              <p className="stat-label">SAMPLES</p>
              <p className="stat-value">{samples}</p>
              <p className="stat-unit">{gpsAcc}</p>
            </div>
          </div>
        )}

        {/* Graph */}
        {showGraphSection && (
          <div className="graph-container">
            <div className="graph-header">
              <span className="l">VIBRATION (RMS)</span>
              <span className="r">last 200 readings</span>
            </div>
            <div className="graph-inner">
              <div
                className="threshold-line"
                style={{ bottom: "10%", borderColor: "rgba(34,197,94,.2)" }}
              />
              <div
                className="threshold-line"
                style={{ bottom: "20%", borderColor: "rgba(234,179,8,.2)" }}
              />
              <div
                className="threshold-line"
                style={{ bottom: "37%", borderColor: "rgba(249,115,24,.2)" }}
              />
              <canvas
                ref={canvasRef}
                width={600}
                height={90}
                style={{ width: "100%", height: "90px", display: "block" }}
              />
            </div>
            <div className="graph-legend">
              <span style={{ color: "#22c55e" }}>Excellent</span>
              <span style={{ color: "#eab308" }}>Fair</span>
              <span style={{ color: "#f97316" }}>Poor</span>
            </div>
          </div>
        )}

        {/* Segments */}
        {showSegmentsSection && (
          <div style={{ marginTop: "14px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: "6px",
              }}
            >
              <span className="label" style={{ margin: 0 }}>
                ROAD QUALITY TIMELINE ({segments.length} segments)
              </span>
            </div>
            <div className="segment-bar">
              {segments.map((s, i) => (
                <div
                  key={i}
                  style={{ background: s.color }}
                  title={
                    s.label +
                    " [" +
                    s.tag +
                    "] RMS:" +
                    s.rms.toFixed(1)
                  }
                />
              ))}
            </div>
            <div
              style={{
                marginTop: "10px",
                display: "flex",
                flexWrap: "wrap",
              }}
            >
              {segmentBadges.map((b) => (
                <span
                  key={b.label}
                  className="badge"
                  style={{
                    background: b.color + "20",
                    color: b.color,
                  }}
                >
                  {b.cnt} {b.label}
                </span>
              ))}
            </div>
            <div ref={segListRef} className="seg-list">
              {segments.map((s, i) => (
                <div key={i} className="seg-item">
                  <div
                    className="seg-dot"
                    style={{ background: s.color }}
                  />
                  <span className="seg-label">{s.label}</span>
                  <span className="seg-meta">
                    RMS:{s.rms.toFixed(2)}
                  </span>
                  <span
                    className="seg-meta"
                    style={{ color: TAG_COLORS[s.tag] }}
                  >
                    {s.tag}
                  </span>
                  <span className="seg-meta">
                    {Math.round(s.distance)}m
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Export */}
        {showExportSection && (
          <div style={{ marginTop: "16px" }}>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                className="btn btn-export"
                style={{ flex: 1 }}
                onClick={() => exportCSV("segments")}
              >
                Segments CSV
              </button>
              <button
                className="btn btn-export"
                style={{ flex: 1 }}
                onClick={() => exportCSV("raw")}
              >
                Raw data CSV
              </button>
            </div>
            <button
              className="btn btn-export"
              style={{ marginTop: "8px", opacity: 0.7 }}
              onClick={exportJSON}
            >
              Export all (JSON)
            </button>
            <p className="export-info">{exportInfo}</p>
          </div>
        )}

        {/* Thresholds reference */}
        <div className="thresholds">
          <p className="label" style={{ marginBottom: "8px" }}>
            CLASSIFICATION THRESHOLDS (RMS m/s{"\u00B2"})
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            <div className="threshold-row">
              <div
                className="threshold-dot"
                style={{ background: "#22c55e" }}
              />
              <span className="threshold-text">Excellent: &lt; 1.5</span>
            </div>
            <div className="threshold-row">
              <div
                className="threshold-dot"
                style={{ background: "#84cc16" }}
              />
              <span className="threshold-text">Good: 1.5 – 3.0</span>
            </div>
            <div className="threshold-row">
              <div
                className="threshold-dot"
                style={{ background: "#eab308" }}
              />
              <span className="threshold-text">Fair: 3.0 – 5.5</span>
            </div>
            <div className="threshold-row">
              <div
                className="threshold-dot"
                style={{ background: "#f97316" }}
              />
              <span className="threshold-text">Poor: 5.5 – 9.0</span>
            </div>
            <div className="threshold-row">
              <div
                className="threshold-dot"
                style={{ background: "#ef4444" }}
              />
              <span className="threshold-text">Very poor: &gt; 9.0</span>
            </div>
          </div>
          <p className="note">
            These thresholds are initial estimates. The exported data will help
            calibrate the ML model.
          </p>
        </div>
      </div>
    </>
  );
}
