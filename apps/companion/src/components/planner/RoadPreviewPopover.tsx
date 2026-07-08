"use client";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { Camera, ExternalLink, Loader2, X } from "lucide-react";
import { Button, Heading, Mono, Pill } from "@tarmoto/ui";
import { plannerApi } from "@/lib/planner/api";
import {
  isLowConfidence,
  QUALITY_BAND_COLORS,
  QUALITY_BAND_LABELS_SHORT,
  scoreToBand,
} from "@/lib/planner/quality-bands";
import type { RoadPreview, RouteSegment } from "@/lib/planner/types";
import { plannerSegmentMidpoint } from "@/lib/trip-planner-map";

/**
 * Road Preview Card — opens when the rider taps ANY section of the
 * quality-colored route line (map) or a flagged-section card (panel).
 * Two states per the Web App v2 (Full) design:
 *  - measured: score + confidence + per-sub-segment quality strip, with a
 *    quieter street-level confirmation thumbnail below;
 *  - no data: street-level imagery placeholder + unverified OSM tag.
 * Renders as a centered card over the map with a scrim backdrop.
 */
interface RoadPreviewPopoverProps {
  segment: RouteSegment;
  onClose: () => void;
  /** Insert an avoidance via near this segment and re-route. */
  onReroute?: (segment: RouteSegment) => void;
}

/** Bar height for one road-segment's score (1–5 → 32%–100%, kept visible). */
function scoreToStripHeight(score: number): string {
  const clamped = Math.max(1, Math.min(5, score));
  return `${Math.round(32 + ((clamped - 1) / 4) * 68)}%`;
}

function formatCapturedMonth(isoMonth: string | undefined): string | null {
  if (!isoMonth) return null;
  const [year, month] = isoMonth.split("-");
  const monthIndex = Number(month) - 1;
  if (!year || !Number.isInteger(monthIndex)) return null;
  const label = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][monthIndex];
  return label ? `${label} ${year}` : null;
}

function segmentTitle(segment: RouteSegment): string {
  const lengthKm = Math.round(segment.lengthKm * 10) / 10;
  if (segment.band === "no_data") {
    return `${lengthKm} km · no rider passes yet`;
  }
  return `Day ${segment.dayNumber} section · ${lengthKm} km`;
}

function StreetViewLink({ segment }: { segment: RouteSegment }) {
  const midpoint = plannerSegmentMidpoint(segment);
  if (!midpoint) return null;
  const href = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${midpoint.lat},${midpoint.lng}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-fg-dim transition hover:text-ink"
    >
      <ExternalLink size={12} />
      {t("Open in Google Street View ")}
    </a>
  );
}

/**
 * Street-level imagery slot. Renders the real Mapillary photo (`imageUrl`) with
 * its required CC-BY-SA credit when there's coverage (#863); otherwise a
 * stylised road perspective stands in and the badge reads "no street imagery".
 */
function StreetLevelThumb({
  preview,
  tall,
}: {
  preview: RoadPreview;
  tall?: boolean;
}) {
  return (
    <div
      data-testid="street-level-thumb"
      className={`relative overflow-hidden rounded-[10px] border border-line ${tall ? "h-40" : "h-[92px]"}`}
      style={{
        background:
          "linear-gradient(180deg, #b9c4cc 0%, #aeb6b8 44%, #8a8276 45%, #6b635b 100%)",
      }}
    >
      {preview.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview.imageUrl}
          alt="Street-level preview of this road section"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <>
          <div
            className="absolute bottom-0 left-1/2 h-[57%] -translate-x-1/2 bg-[#4f4a44]"
            style={{
              width: tall ? 64 : 50,
              clipPath: "polygon(34% 0, 66% 0, 100% 100%, 0 100%)",
            }}
          />
          <div
            className="absolute bottom-0 left-1/2 h-1/2 -translate-x-1/2"
            style={{
              width: tall ? 3 : 2.5,
              background:
                "repeating-linear-gradient(180deg, #d8cdbc 0 10px, transparent 10px 22px)",
            }}
          />
        </>
      )}
      <div className="absolute left-2.5 top-2 flex items-center gap-1.5 rounded-[5px] bg-ink/60 px-2 py-1">
        <Camera size={10} className="text-cream" />
        <Mono className="text-[8px] tracking-[0.4px] text-cream">
          {preview.imageUrl ? t("MAPILLARY ") : t("NO STREET IMAGERY ")}
        </Mono>
      </div>
      {/* CC-BY-SA credit, required for Mapillary imagery (ADR-0009). */}
      {preview.imageUrl && preview.imageAttribution ? (
        <div className="absolute bottom-1.5 right-2 rounded-[4px] bg-ink/60 px-1.5 py-0.5">
          <Mono className="text-[7.5px] tracking-[0.3px] text-cream/90">
            {preview.imageAttribution}
          </Mono>
        </div>
      ) : null}
    </div>
  );
}

export function RoadPreviewPopover({
  segment,
  onClose,
  onReroute,
}: RoadPreviewPopoverProps) {
  const [preview, setPreview] = useState<RoadPreview | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    // Quality/surface/strip come straight off the segment, so this resolves
    // immediately — the actionable card never waits on imagery.
    plannerApi
      .getRoadPreview(segment)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        // Preview data is decorative — on failure just keep the card empty
        // besides its header; the close affordance still works.
        if (!cancelled) setPreview(null);
      });
    // Street-level imagery streams in separately and merges when it lands; a
    // slow/absent Mapillary lookup never delays the card above (#863).
    plannerApi
      .getSegmentImagery(segment)
      .then((imagery) => {
        if (cancelled || !imagery) return;
        setPreview((prev) => (prev ? { ...prev, ...imagery } : prev));
      })
      .catch(() => {
        // No imagery — the card already renders without a thumbnail.
      });
    return () => {
      cancelled = true;
    };
  }, [segment]);

  const tone = QUALITY_BAND_COLORS[segment.band];
  const captured = formatCapturedMonth(preview?.imageCapturedAt);
  const lowConf =
    preview?.hasData === true && isLowConfidence(preview.passes ?? 0);
  const scoreColor = lowConf ? "var(--color-fg-mute)" : tone;

  return (
    <div
      data-testid="road-preview-popover"
      onClick={onClose}
      className="absolute inset-0 z-40 flex items-center justify-center bg-ink/40 p-6"
    >
      <div
        role="dialog"
        aria-label="Road preview"
        onClick={(event) => event.stopPropagation()}
        className="max-h-full w-[380px] max-w-full overflow-y-auto rounded-2xl border border-line-strong bg-cream shadow-[0_24px_60px_rgba(20,17,14,0.32)]"
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-line px-[18px] py-[15px]">
          <div className="flex items-center gap-2.5">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: tone }}
            />
            <Mono className="text-[10px] font-bold tracking-[1px] text-fg-mute">
              {t("ROAD PREVIEW ")}
            </Mono>
          </div>
          <button
            type="button"
            aria-label="Close road preview"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-line-strong text-fg-dim transition hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>

        <div className="p-[18px]">
          <Heading size="sm">{segmentTitle(segment)}</Heading>

          {preview?.hasData ? (
            <>
              {/* measured score, dimmed when too few passes back it */}
              <div
                className="mt-2.5 flex items-baseline gap-2"
                style={{ opacity: lowConf ? 0.7 : 1 }}
              >
                <span
                  className="text-[28px] font-extrabold tracking-[-0.8px]"
                  style={{ color: scoreColor }}
                >
                  {QUALITY_BAND_LABELS_SHORT[segment.band]}
                </span>
                <span
                  className="text-xl font-extrabold tracking-[-0.5px]"
                  style={{ color: scoreColor }}
                >
                  {preview.score?.toFixed(1)}
                </span>
                <span className="text-xs font-semibold text-fg-mute">/ 5</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {preview.surface ? (
                  <Pill variant="ghost">{preview.surface}</Pill>
                ) : null}
                {lowConf ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-quality-q2/60 bg-quality-q2/15 px-2.5 py-1">
                    <span className="h-[7px] w-[7px] rounded-full bg-quality-q2" />
                    <Mono className="text-[9.5px] font-bold tracking-[0.4px] text-[#A9762A]">
                      {t("LOW CONFIDENCE ")}· {preview.passes}{" "}
                      {preview.passes === 1 ? t("PASS ") : t("PASSES ")}
                    </Mono>
                  </span>
                ) : (
                  <span className="text-[11.5px] text-fg-mute">
                    {t("based on ")}
                    {preview.passes} {t("rider passes ")}
                  </span>
                )}
              </div>
              {lowConf ? (
                <p className="mt-2 text-[11.5px] leading-normal text-fg-dim">
                  {t(
                    "Too few passes to be sure — treat this as provisional and check the section yourself. ",
                  )}
                </p>
              ) : null}

              {/* per-sub-segment quality strip */}
              {preview.microStrip && preview.microStrip.length > 0 ? (
                <>
                  <Mono
                    as="div"
                    className="mb-2 mt-[18px] text-[9.5px] tracking-[1px] text-fg-mute"
                  >
                    {t("QUALITY ACROSS SECTION ")}
                  </Mono>
                  <div
                    className="flex h-12 items-end gap-1 px-0.5"
                    style={{ opacity: lowConf ? 0.55 : 1 }}
                  >
                    {preview.microStrip.map((span, index) => (
                      <div
                        key={index}
                        className="rounded-sm"
                        title={`${span.score.toFixed(1)} · ${span.lengthKm.toFixed(1)} km`}
                        style={{
                          // Width ∝ length so the bars map to the 0→N km axis;
                          // a floor keeps a short sliver visible.
                          flexGrow: span.lengthKm,
                          flexBasis: 0,
                          minWidth: 2,
                          height: scoreToStripHeight(span.score),
                          background:
                            QUALITY_BAND_COLORS[scoreToBand(span.score)],
                        }}
                      />
                    ))}
                  </div>
                  <div className="mt-1.5 flex justify-between">
                    <Mono className="text-[9px] text-fg-mute">0 KM</Mono>
                    <Mono className="text-[9px] text-fg-mute">
                      {Math.round(segment.lengthKm * 10) / 10} KM
                    </Mono>
                  </div>
                </>
              ) : null}

              {/* secondary street-level confirmation — quieter than the score */}
              <div className="mt-[18px] border-t border-line pt-4">
                <Mono
                  as="div"
                  className="mb-2 text-[9.5px] tracking-[1px] text-fg-mute"
                >
                  {t("STREET-LEVEL CHECK ")}
                </Mono>
                <StreetLevelThumb preview={preview} />
                {captured ? (
                  <Mono
                    as="div"
                    className="mt-1.5 text-[9px] tracking-[0.3px] text-fg-mute"
                  >
                    {t("captured ")}
                    {captured} {t("· confirmation only ")}
                  </Mono>
                ) : null}
                <StreetViewLink segment={segment} />
              </div>

              {onReroute ? (
                <div className="mt-[18px] flex gap-2">
                  <Button variant="ghost" size="sm" block onClick={onClose}>
                    {t("Keep anyway ")}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    block
                    onClick={() => onReroute(segment)}
                  >
                    {t("Reroute around this ")}
                  </Button>
                </div>
              ) : null}
            </>
          ) : preview ? (
            <>
              {/* no measured data — street-level imagery leads */}
              <div className="mt-3.5">
                <StreetLevelThumb preview={preview} tall />
              </div>
              {captured ? (
                <div className="mt-2 flex items-center gap-1.5">
                  <Mono className="text-[9.5px] tracking-[0.4px] text-fg-mute">
                    {t("MAPILLARY · CAPTURED ")}
                    {captured.toUpperCase()}
                  </Mono>
                </div>
              ) : null}
              {preview.osmSurfaceTag ? (
                <div className="mt-3 flex items-center gap-2 rounded-[10px] border border-line bg-paper px-3 py-2.5">
                  <Mono className="text-[9px] tracking-[0.6px] text-fg-mute">
                    OSM
                  </Mono>
                  <Mono className="text-[11px] text-ink">
                    surface = {preview.osmSurfaceTag}
                  </Mono>
                  <Mono className="text-[10px] text-fg-mute">
                    {t("· unverified ")}
                  </Mono>
                </div>
              ) : null}
              <p className="mt-3 text-[12.5px] leading-normal text-fg-dim">
                {t("No one’s ridden this yet — ")}
                <b className="text-ink">{t("be the first to map it. ")}</b>
              </p>
              <StreetViewLink segment={segment} />
              {onReroute ? (
                <div className="mt-[18px] flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    block
                    onClick={() => onReroute(segment)}
                  >
                    {t("Reroute around this ")}
                  </Button>
                  <Button variant="primary" size="sm" block onClick={onClose}>
                    {t("Keep in route ")}
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <p className="mt-3 flex items-center gap-2 text-[12.5px] text-fg-dim">
              <Loader2
                size={13}
                aria-hidden
                className="shrink-0 animate-spin"
              />
              {t("Loading road preview… ")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
