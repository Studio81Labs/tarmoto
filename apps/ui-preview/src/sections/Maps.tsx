import { Section, SubStamp } from "../Section";
import {
  Card,
  ClusterGlyph,
  CollaboratorCursor,
  CompassScale,
  Dot,
  FunZoneGlyph,
  HazardGlyph,
  MapMini,
  Mono,
  PeakGlyph,
  Pill,
  QualityRibbonGlyph,
  Stamp,
  TownGlyph,
  WaypointGlyph,
  palette,
} from "@tarmoto/ui";
import { CodeBlock, ColorDot, TokenTable } from "./_shared";

/* ============================================================
 * 21 · MAP VOCABULARY (source §17)
 * ============================================================ */

export function MapVocabSection() {
  return (
    <Section
      id="map-vocab"
      num="21 · Map vocabulary"
      title="Six glyphs, one route."
      intro={
        <>
          Every map in Tarmoto draws from the same vocabulary. The road base is
          the bedrock, the quality ribbon overlays it segment by segment, and
          pins, peaks, fun zones, towns, and waypoints add reading order on top.
        </>
      }
    >
      {/* Six glyph cards */}
      <div className="mb-6 grid grid-cols-3 gap-3.5">
        <GlyphCard
          stamp="Waypoint"
          glyph={<WaypointGlyph letter="B" size={60} />}
          body="Ink fill, cream ring 2.5 px, single mono letter (A–Z). Marks user-placed stops on a route."
        />
        <GlyphCard
          stamp="Hazard pin"
          glyph={<HazardGlyph size={60} />}
          body={
            <>
              Accent fill, cream ring 1.8 px, "!" mono. Always above the road
              and quality layers in z-order.
            </>
          }
        />
        <GlyphCard
          stamp="Peak / pass"
          glyph={<PeakGlyph size={60} />}
          body="Open triangle, summit dot, mono name + elevation in dim ink."
        />
        <GlyphCard
          stamp="Town"
          glyph={<TownGlyph size={60} />}
          body="Solid ink dot 4.5 r + halo ring at 30 % opacity, sans-serif name in ink."
        />
        <GlyphCard
          stamp="Fun Zone"
          glyph={<FunZoneGlyph size={60} />}
          body="Radial gradient using a Q-stop color (Q5 or Q4). Sits behind the road layer."
        />
        <GlyphCard
          stamp="Quality ribbon"
          glyph={<QualityRibbonGlyph size={40} />}
          body="The planned route, chunked into sub-segments by quality. Stroke 5.5 px, round caps."
        />
      </div>

      {/* Z-order strip */}
      <Card padded={false} className="overflow-hidden">
        <div className="border-b border-line px-5 py-4">
          <Stamp>Z-order (bottom → top)</Stamp>
        </div>
        <div className="flex flex-wrap items-center gap-4 px-5 py-4 font-mono text-[11px]">
          {[
            "1 · Paper noise",
            "2 · Topo contours",
            "3 · Rivers",
            "4 · Fun zones",
            "5 · Road base",
            "6 · Quality ribbon",
            "7 · Peaks · towns",
            "8 · Waypoints",
            "9 · Hazards",
            "10 · Collab cursors",
          ].map((label, i, arr) => (
            <span key={label} className="flex items-center gap-4">
              <span className="rounded bg-paper px-2.5 py-1.5">{label}</span>
              {i < arr.length - 1 && <span className="text-fg-mute">→</span>}
            </span>
          ))}
        </div>
      </Card>

      {/* Point catalogue */}
      <div className="mt-9">
        <SubStamp>Point catalogue</SubStamp>
        <p className="mb-4 max-w-[70ch] text-[13px] leading-[1.55] text-fg-dim">
          Every map point is one of five primitives. Each has a fixed geometry,
          label rule, and z-band. The renderer never invents a new marker type —
          if the data doesn't fit one of these, it doesn't appear on the map.
        </p>
        <TokenTable
          columns={[
            { label: "Glyph", size: "60px" },
            { label: "Type", size: "120px" },
            { label: "Geometry", size: "1fr" },
            { label: "Label", size: "1fr" },
            { label: "Z-band", size: "70px" },
            { label: "Cluster", size: "70px" },
          ]}
          rows={[
            [
              <TownGlyph size={28} />,
              <Mono className="font-semibold">town</Mono>,
              <span className="text-fg-dim">
                dot 4.5 r ink · halo ring 9 r ink @ 30 %
              </span>,
              <span className="text-fg-dim">
                name +14 / +4 · sans 13 / 700 / ink
              </span>,
              <Mono className="text-fg-mute">7</Mono>,
              <Mono className="text-fg-mute">no</Mono>,
            ],
            [
              <PeakGlyph size={28} />,
              <Mono className="font-semibold">peak / pass</Mono>,
              <span className="text-fg-dim">
                open triangle 18 px base · summit dot 1.8 r · stroke ink @ 62 %
              </span>,
              <span className="text-fg-dim">
                name +15 / -2 · elev +15 / +10 · mono 10 / 600 · 9 / 700
              </span>,
              <Mono className="text-fg-mute">7</Mono>,
              <Mono className="text-fg-mute">no</Mono>,
            ],
            [
              <WaypointGlyph letter="B" size={28} />,
              <Mono className="font-semibold">waypoint</Mono>,
              <span className="text-fg-dim">
                circle 15 r ink · cream ring 2.5 px
              </span>,
              <span className="text-fg-dim">
                letter inside · mono 12 / 700 cream · A–Z sequential
              </span>,
              <Mono className="text-fg-mute">8</Mono>,
              <Mono className="text-fg-mute">no</Mono>,
            ],
            [
              <HazardGlyph size={28} />,
              <Mono className="font-semibold">hazard</Mono>,
              <span className="text-fg-dim">
                circle 10 r accent · cream ring 1.8 px
              </span>,
              <span className="text-fg-dim">
                "!" inside · mono 10 / 800 cream · category in tooltip
              </span>,
              <Mono className="text-fg-mute">9</Mono>,
              <Mono className="text-fg-mute">yes</Mono>,
            ],
            [
              <CollaboratorCursor name="J" color="#6FD38A" size={28} />,
              <Mono className="font-semibold">collab cursor</Mono>,
              <span className="text-fg-dim">
                pointer path · fill in user hue · 1 px ink hairline
              </span>,
              <span className="text-fg-dim">
                name tag +18 / +2 · 18 px tall · sans 11 / 700 ink
              </span>,
              <Mono className="text-fg-mute">10</Mono>,
              <Mono className="text-fg-mute">no</Mono>,
            ],
          ]}
        />
      </div>

      {/* Point states */}
      <div className="mt-9">
        <SubStamp>Point states</SubStamp>
        <div className="grid grid-cols-2 gap-5">
          <Card padded={false}>
            <div className="border-b border-line p-4">
              <div className="text-[14px] font-bold">Waypoint</div>
              <Mono className="mt-0.5 block text-[10px] text-fg-dim">
                A · B · C · sequential
              </Mono>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-7 p-4">
              {[
                { letter: "B", label: "DEFAULT · 15r" },
                { letter: "B", hover: true, label: "HOVER · +ring" },
                {
                  letter: "B",
                  selected: true,
                  label: "SELECTED · accent",
                },
                { letter: "B", dragging: true, label: "DRAGGING · dashed" },
              ].map((s, i) => (
                <div key={i} className="text-center">
                  <WaypointGlyph
                    size={50}
                    letter={s.letter}
                    hover={s.hover}
                    selected={s.selected}
                    dragging={s.dragging}
                  />
                  <Mono className="mt-1.5 block text-[10px] tracking-[1px] text-fg-dim">
                    {s.label}
                  </Mono>
                </div>
              ))}
            </div>
          </Card>
          <Card padded={false}>
            <div className="border-b border-line p-4">
              <div className="text-[14px] font-bold">Hazard</div>
              <Mono className="mt-0.5 block text-[10px] text-fg-dim">
                pothole · gravel · ice · construction
              </Mono>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-7 p-4">
              {(
                [
                  { state: "unconfirmed", label: "UNCONFIRMED" },
                  { state: "confirmed", label: "CONFIRMED · +halo" },
                  { state: "resolved", label: "RESOLVED · ink" },
                  { state: "stale", label: "STALE · 45%" },
                ] as const
              ).map((s) => (
                <div key={s.state} className="text-center">
                  <HazardGlyph size={50} state={s.state} />
                  <Mono className="mt-1.5 block text-[10px] tracking-[1px] text-fg-dim">
                    {s.label}
                  </Mono>
                </div>
              ))}
            </div>
          </Card>
          <Card padded={false}>
            <div className="border-b border-line p-4">
              <div className="text-[14px] font-bold">Cluster glyphs</div>
              <Mono className="mt-0.5 block text-[10px] text-fg-dim">
                when &gt; threshold within radius
              </Mono>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-7 p-4">
              <div className="text-center">
                <ClusterGlyph count={7} variant="hazard" />
                <Mono className="mt-1.5 block text-[10px] tracking-[1px] text-fg-dim">
                  HAZARDS · 7
                </Mono>
              </div>
              <div className="text-center">
                <ClusterGlyph count={12} variant="waypoint" />
                <Mono className="mt-1.5 block text-[10px] tracking-[1px] text-fg-dim">
                  WAYPOINTS · 12
                </Mono>
              </div>
              <div className="text-center">
                <ClusterGlyph count={3} variant="waypoint" selected />
                <Mono className="mt-1.5 block text-[10px] tracking-[1px] text-fg-dim">
                  SELECTED
                </Mono>
              </div>
            </div>
          </Card>
          <Card padded={false}>
            <div className="border-b border-line p-4">
              <div className="text-[14px] font-bold">Hover card · tooltip</div>
              <Mono className="mt-0.5 block text-[10px] text-fg-dim">
                200 ms delay · anchored above point
              </Mono>
            </div>
            <div className="flex justify-center p-4">
              <div className="relative max-w-[240px] rounded-lg bg-ink p-3 px-3.5 text-cream shadow-[0_8px_24px_rgba(14,14,16,0.2)]">
                <Stamp tone="accent">Hazard · pothole</Stamp>
                <div className="mt-1 text-[13px] font-bold">
                  Confirmed 3× in 48 h
                </div>
                <div className="mt-1 text-[11px] text-cream/60">
                  SS38 · KM 14.2 · Stelvio east ramp
                </div>
                <div
                  className="absolute bottom-[-6px] left-6 size-3 rotate-45 bg-ink"
                  aria-hidden="true"
                />
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* Lines & areas */}
      <div className="mt-9">
        <SubStamp>Lines &amp; areas</SubStamp>
        <TokenTable
          columns={[
            { label: "Sample", size: "80px" },
            { label: "Primitive", size: "130px" },
            { label: "Stroke / fill", size: "1fr" },
            { label: "Use", size: "1fr" },
            { label: "Z-band", size: "70px" },
          ]}
          rows={[
            [
              <LineSample stroke="rgba(14,14,16,0.08)" width={1} />,
              <Mono className="font-semibold">topo contour</Mono>,
              <span className="text-fg-dim">
                1 px · ink @ 8 % (paper) · ink @ 14 % (strong)
              </span>,
              <span className="text-fg-dim">Texture, elevation hint</span>,
              <Mono className="text-fg-mute">2</Mono>,
            ],
            [
              <LineSample stroke="rgba(80,120,160,0.55)" width={2} />,
              <Mono className="font-semibold">river</Mono>,
              <span className="text-fg-dim">
                2 px · river-blue · 55 % opacity (paper)
              </span>,
              <span className="text-fg-dim">Hydrology · context only</span>,
              <Mono className="text-fg-mute">3</Mono>,
            ],
            [
              <FunZoneSample />,
              <Mono className="font-semibold">fun zone</Mono>,
              <span className="text-fg-dim">
                radial gradient · Q4 or Q5 stop · 55 % → 0 %
              </span>,
              <span className="text-fg-dim">Discovered curve cluster</span>,
              <Mono className="text-fg-mute">4</Mono>,
            ],
            [
              <LineSample stroke="#C4BBA8" width={4.5} />,
              <Mono className="font-semibold">road base</Mono>,
              <span className="text-fg-dim">
                4.5 px · paper-deep · 85 % opacity
              </span>,
              <span className="text-fg-dim">
                Underlay for every road, traversed or not
              </span>,
              <Mono className="text-fg-mute">5</Mono>,
            ],
            [
              <LineSample stroke="#6FD38A" width={5.5} />,
              <Mono className="font-semibold">quality ribbon</Mono>,
              <span className="text-fg-dim">
                5.5 px · Q-stop color · round caps · chunked
              </span>,
              <span className="text-fg-dim">
                Planned route, with quality encoded
              </span>,
              <Mono className="text-fg-mute">6</Mono>,
            ],
            [
              <LineSample stroke="#0E0E10" width={2} dash="2 4" />,
              <Mono className="font-semibold">drawn region</Mono>,
              <span className="text-fg-dim">
                2 px ink · 2 / 4 dash · enclosed area ink @ 6 %
              </span>,
              <span className="text-fg-dim">
                Lasso for "show me roads inside here"
              </span>,
              <Mono className="text-fg-mute">6</Mono>,
            ],
            [
              <LineSample stroke="#6EB4E8" width={3} dash="6 3" />,
              <Mono className="font-semibold">other rider trace</Mono>,
              <span className="text-fg-dim">
                3 px · collab-blue · 6 / 3 dash
              </span>,
              <span className="text-fg-dim">
                A friend's recent ride overlaid for comparison
              </span>,
              <Mono className="text-fg-mute">6</Mono>,
            ],
          ]}
        />
      </div>

      {/* Canvas & coordinates */}
      <div className="mt-9 grid grid-cols-2 gap-5">
        <Card padded>
          <div className="text-[14px] font-bold">SVG viewBox</div>
          <p className="mt-2 text-[13px] leading-[1.6] text-fg-dim">
            All maps render into a <Mono className="text-ink">1200 × 820</Mono>{" "}
            viewBox with{" "}
            <Mono className="text-ink">
              preserveAspectRatio="xMidYMid slice"
            </Mono>
            . Lat/long projects to canvas via the active bounds tuple{" "}
            <Mono className="text-ink">&#123; n, s, e, w &#125;</Mono>; nothing
            else cares about geographic units. Point geometries (radii, strokes)
            are expressed in canvas pixels — they stay the same as the user
            zooms.
          </p>
          <div className="mt-3.5">
            <CodeBlock>
              {`// projection (pseudocode)\n`}
              {`const [x, y] = project([lat, lng], bounds, [1200, 820]);\n`}
              {`const r = 15;  // always 15px, regardless of zoom`}
            </CodeBlock>
          </div>
        </Card>
        <Card padded>
          <div className="text-[14px] font-bold">Density limits</div>
          <p className="mt-2 text-[13px] leading-[1.6] text-fg-dim">
            Points beyond these thresholds cluster. Below the threshold, render
            individually with anti-collision on labels.
          </p>
          <div className="mt-3.5">
            <TokenTable
              columns={[
                { label: "Type", size: "1fr" },
                { label: "Max per 100²", size: "1fr" },
                { label: "Cluster radius", size: "1fr" },
              ]}
              rows={[
                [
                  <Mono className="font-semibold">hazard</Mono>,
                  <span className="text-fg-dim">4</span>,
                  <Mono className="text-fg-mute">60 px</Mono>,
                ],
                [
                  <Mono className="font-semibold">waypoint</Mono>,
                  <span className="text-fg-dim">8</span>,
                  <Mono className="text-fg-mute">40 px</Mono>,
                ],
                [
                  <Mono className="font-semibold">town</Mono>,
                  <span className="text-fg-dim">3</span>,
                  <Mono className="text-fg-mute">never cluster</Mono>,
                ],
                [
                  <Mono className="font-semibold">peak</Mono>,
                  <span className="text-fg-dim">2</span>,
                  <Mono className="text-fg-mute">never cluster</Mono>,
                ],
              ]}
            />
          </div>
        </Card>
      </div>

      {/* Rules */}
      <div className="mt-9">
        <SubStamp>Rules</SubStamp>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <SimpleRule
              kind="do"
              title="Use scale, not point size, to show importance."
              body="A peak is always 18 px wide. A capital city's town dot is the same size as a hamlet's. Importance is encoded by label weight and presence, not glyph scale."
            />
            <SimpleRule
              kind="do"
              title="Always ring on-road points in cream."
              body="Waypoints and hazards live on top of the quality ribbon — the 1.8–2.5 px cream ring is what keeps them legible against any Q-color."
            />
            <SimpleRule
              kind="do"
              title="Cluster early."
              body="Show a cluster glyph at the first hint of overlap. Two hazards visually touching is already too dense."
            />
          </div>
          <div>
            <SimpleRule
              kind="dont"
              title="Don't introduce a sixth point type."
              body="Photo pins, weather, gas stations, viewpoints — these all compose into the existing primitives (waypoint with a letter, hazard with a different glyph, town for amenities). Propose new primitives in design review, not on the map."
            />
            <SimpleRule
              kind="dont"
              title="Don't scale points with zoom."
              body="Hazards stay 10 r at z=8 and at z=14. Roads grow with zoom; markers don't. This is what keeps the page calm at every level."
            />
            <SimpleRule
              kind="dont"
              title="Don't use emoji for hazard categories."
              body='Tooltip shows category as words ("Pothole · confirmed 3×"). The hazard glyph is always "!"; subtype is text-only.'
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

function GlyphCard({
  stamp,
  glyph,
  body,
}: {
  stamp: string;
  glyph: React.ReactNode;
  body: React.ReactNode;
}) {
  return (
    <Card>
      <Stamp>{stamp}</Stamp>
      <div className="my-4 flex min-h-[80px] items-center justify-center">
        {glyph}
      </div>
      <p className="text-[12px] leading-[1.5] text-fg-dim">{body}</p>
    </Card>
  );
}

function LineSample({
  stroke,
  width,
  dash,
}: {
  stroke: string;
  width: number;
  dash?: string;
}) {
  return (
    <svg width="60" height="20" viewBox="0 0 60 20" aria-hidden="true">
      <path
        d="M 4 10 C 18 4, 32 16, 56 8"
        stroke={stroke}
        strokeWidth={width}
        strokeDasharray={dash}
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FunZoneSample() {
  return (
    <svg width="60" height="20" viewBox="0 0 60 20" aria-hidden="true">
      <ellipse
        cx="30"
        cy="10"
        rx="22"
        ry="7"
        fill="#6FD38A"
        fillOpacity="0.45"
      />
    </svg>
  );
}

function SimpleRule({
  kind,
  title,
  body,
}: {
  kind: "do" | "dont";
  title: React.ReactNode;
  body: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[64px_1fr] items-start gap-4 border-b border-line py-4 last:border-b-0">
      <div
        className={`rounded p-1.5 text-center font-mono text-[10px] font-bold uppercase tracking-[1.4px] ${
          kind === "do" ? "bg-quality-q5 text-ink" : "bg-quality-q1 text-cream"
        }`}
      >
        {kind === "do" ? "Do" : "Don't"}
      </div>
      <div>
        <div className="mb-1 text-[14px] font-bold">{title}</div>
        <div className="text-[13px] leading-[1.55] text-fg-dim">{body}</div>
      </div>
    </div>
  );
}

/* ============================================================
 * 22 · MAP MODES (source §18) — paper / light / dark
 * ============================================================ */

export function MapModesSection() {
  return (
    <Section
      id="map-modes"
      num="22 · Map modes"
      title="Paper · Light · Dark."
      tone="tinted"
      intro={
        <>
          Three rendering modes for the underlying map canvas, all consuming the
          same vocabulary. Paper is default and Tarmoto-native. Light is for
          embeds and screenshots. Dark is the ride/night skin.
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3.5">
        <div>
          <MapMini mode="paper" />
          <div className="pt-3">
            <Stamp tone="accent">Paper · default</Stamp>
            <p className="mt-1.5 text-[13px] leading-[1.55] text-fg-dim">
              Cream-tinted canvas, paper noise filter, ink contours. Tarmoto's
              identity.
            </p>
          </div>
        </div>
        <div>
          <MapMini mode="light" showHazard={false} />
          <div className="pt-3">
            <Stamp>Light</Stamp>
            <p className="mt-1.5 text-[13px] leading-[1.55] text-fg-dim">
              Same vocabulary, fewer contours, no noise. Use for embeds, print,
              marketing screenshots.
            </p>
          </div>
        </div>
        <div>
          <MapMini mode="dark" />
          <div className="pt-3">
            <Stamp>Dark</Stamp>
            <p className="mt-1.5 text-[13px] leading-[1.55] text-fg-dim">
              <span className="font-mono">#17181C</span> ground, contours at
              cream @ 6 %. Roads desaturate to{" "}
              <span className="font-mono">#1E1F23</span> base.
            </p>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ============================================================
 * 23 · MAP OVERLAYS (source §19)
 * ============================================================ */

export function MapOverlaysSection() {
  return (
    <Section
      id="map-overlays"
      num="23 · Map overlays"
      title={
        <>
          Things that float
          <br />
          above the map.
        </>
      }
      intro={
        <>
          Every overlay sits 16 px from the nearest map edge, on a cream card
          with a <span className="font-mono">--line-strong</span> 1 px border,
          10 px radius, and <span className="font-mono">--shadow-card</span>.
          The map is the noisy bed — overlays are the calm. They never tint,
          never glow.
        </>
      }
    >
      {/* Anchor diagram */}
      <div className="mb-7">
        <SubStamp>Anchor diagram · four corners + one centre slot</SubStamp>
        <div className="relative aspect-[16/8] overflow-hidden rounded-[14px] border border-line bg-paper">
          <svg
            viewBox="0 0 640 320"
            preserveAspectRatio="xMidYMid slice"
            className="absolute inset-0 size-full"
            aria-hidden="true"
          >
            <g stroke="rgba(14,14,16,0.08)" strokeWidth="1" fill="none">
              <path d="M -10 60 C 180 50, 360 80, 660 50" />
              <path d="M -10 110 C 200 100, 400 130, 660 100" />
              <path d="M -10 160 C 220 150, 420 180, 660 150" />
              <path d="M -10 210 C 240 200, 440 230, 660 200" />
              <path d="M -10 260 C 260 250, 460 280, 660 250" />
            </g>
            <path
              d="M 40 240 C 140 200, 240 140, 380 110 S 580 100, 620 140"
              stroke="#C4BBA8"
              strokeWidth="5"
              fill="none"
              strokeLinecap="round"
            />
            <path
              d="M 40 240 C 140 200, 240 140, 380 110"
              stroke="#6FD38A"
              strokeWidth="6"
              fill="none"
              strokeLinecap="round"
            />
          </svg>

          <OverlayCard className="absolute left-4 top-4">
            <ToolbarStrip />
          </OverlayCard>

          <OverlayCard className="absolute right-4 top-4 flex items-center gap-2.5">
            <CollabStack visibleCount={3} />
            <span className="text-[12px] text-fg-dim">3 editing</span>
          </OverlayCard>

          <OverlayCard className="absolute bottom-4 left-4 text-[12px]">
            <span className="font-mono text-fg-mute">EXPLORER / </span>
            <span className="font-mono font-bold">LOMBARDY / STELVIO NP</span>
            <span className="ml-2.5 text-fg-mute">· 2,847 segments</span>
          </OverlayCard>

          <div className="absolute bottom-4 right-4">
            <div className="relative grid size-11 place-items-center rounded-full border border-fg-dim">
              <svg width="14" height="22" viewBox="0 0 14 22">
                <path
                  d="M 7 2 L 2 18 L 7 14 L 12 18 Z"
                  fill="rgba(14,14,16,0.62)"
                />
              </svg>
              <span className="absolute -top-4 font-mono text-[9px] font-bold text-fg-dim">
                N
              </span>
            </div>
          </div>
        </div>
        <p className="mt-2.5 text-[12px] text-fg-dim">
          Four corners, fixed 16 px inset. <strong>TL</strong>: tools &amp;
          filters. <strong>TR</strong>: collaborators &amp; status.{" "}
          <strong>BL</strong>: context breadcrumb. <strong>BR</strong>: compass
          / scale / zoom controls. The bottom-centre slot is reserved for the
          day timeline (planner only). No mid-edge placements ever.
        </p>
      </div>

      {/* Specimen grid · 10 examples */}
      <div className="grid grid-cols-2 gap-5">
        <OverlaySpec
          name="Tool toolbar · top-left"
          props="cream · 1 px line-strong · radius 10 · pad 4 · item 8/12 · 12 px / 600 · shadow-card"
        >
          <ToolbarStrip />
        </OverlaySpec>

        <OverlaySpec
          name="Quality threshold · top-left"
          props="stamp + 5 Q-chips · selected chip has 2 px ink ring · stops below selection greyed"
        >
          <OverlayCard className="flex items-center gap-2.5">
            <Stamp>Quality ≥</Stamp>
            {[1, 2, 3].map((q) => (
              <QChip
                key={q}
                num={q}
                color={["#E05A3C", "#F0A03C", "#E8D66A"][q - 1]}
                selected={q === 3}
              />
            ))}
            {[4, 5].map((q) => (
              <QChip key={q} num={q} muted />
            ))}
          </OverlayCard>
        </OverlaySpec>

        <OverlaySpec
          name="Multi-select chips · top-left"
          props="cream tray · ink fill on selected · 11 px upper / 700 · 0.8 letter · pad 6/12"
        >
          <OverlayCard className="flex gap-1 !p-1.5">
            {["asphalt", "concrete", "cobblestone", "gravel", "dirt"].map(
              (label, i) => (
                <span
                  key={label}
                  className={`rounded-md px-3 py-1.5 font-sans text-[11px] font-bold uppercase tracking-[0.8px] ${
                    i === 0 ? "bg-ink text-cream" : "text-fg-dim"
                  }`}
                >
                  {label}
                </span>
              ),
            )}
          </OverlayCard>
        </OverlaySpec>

        <OverlaySpec
          name="Status pill · top-left"
          props="dot + sentence · accent dot for hazard · Q5 dot for healthy · ink dot for neutral"
        >
          <OverlayCard className="flex items-center gap-2 text-[12px] text-fg-dim">
            <Dot color={palette.accent} />
            <span>12 active hazards in view</span>
          </OverlayCard>
        </OverlaySpec>

        <OverlaySpec
          name="Collaborator stack · top-right"
          props="22 px circles · 2 px cream ring · -8 px overlap · ink +N chip after 3 visible"
        >
          <OverlayCard className="flex items-center gap-2.5">
            <CollabStack visibleCount={3} overflowCount={2} />
            <span className="text-[12px] text-fg-dim">5 editing</span>
          </OverlayCard>
        </OverlaySpec>

        <OverlaySpec
          name="Context breadcrumb · bottom-left"
          props="mono trail (mute → ink at leaf) · sans counts in mute · pad 10/14"
        >
          <OverlayCard className="text-[12px]">
            <span className="font-mono text-fg-mute">EXPLORER / </span>
            <span className="font-mono font-bold">LOMBARDY / STELVIO NP</span>
            <span className="ml-2.5 text-fg-mute">
              · 2,847 segments · 186k passes
            </span>
          </OverlayCard>
        </OverlaySpec>

        <OverlaySpec
          name="Compass + scale · in-svg"
          props="drawn into the map SVG · ink @ 62% · no card · respects map mode (cream @ 60% on dark)"
        >
          <CompassScale />
        </OverlaySpec>

        <OverlaySpec
          name="Zoom + fit-to-bounds · bottom-right"
          props="stacked vertical · 32 sq buttons · 7 radius · hairline divider · fit-to-bounds icon at the bottom"
        >
          <div className="flex flex-col gap-px rounded-[10px] border border-line-strong bg-cream p-1 shadow-[0_6px_16px_rgba(14,14,16,0.08)]">
            <button
              type="button"
              className="grid size-8 cursor-pointer place-items-center rounded-md font-mono text-[16px] font-bold hover:bg-paper"
              aria-label="Zoom in"
            >
              +
            </button>
            <div className="h-px bg-line" />
            <button
              type="button"
              className="grid size-8 cursor-pointer place-items-center rounded-md font-mono text-[16px] font-bold hover:bg-paper"
              aria-label="Zoom out"
            >
              −
            </button>
            <div className="h-px bg-line" />
            <button
              type="button"
              className="grid size-8 cursor-pointer place-items-center rounded-md hover:bg-paper"
              aria-label="Fit to bounds"
            >
              <svg width="14" height="14" viewBox="0 0 14 14">
                <path
                  d="M 2 2 L 6 2 M 2 2 L 2 6 M 12 2 L 8 2 M 12 2 L 12 6 M 2 12 L 6 12 M 2 12 L 2 8 M 12 12 L 8 12 M 12 12 L 12 8"
                  stroke="#0E0E10"
                  strokeWidth="1.5"
                  fill="none"
                />
              </svg>
            </button>
          </div>
        </OverlaySpec>

        <OverlaySpec
          name="Collaborator cursor · in-svg"
          props={
            <>
              pointer + name tag ·{" "}
              <span style={{ color: "#6FD38A" }} className="font-mono">
                #6FD38A
              </span>{" "}
              ·{" "}
              <span style={{ color: "#6EB4E8" }} className="font-mono">
                #6EB4E8
              </span>{" "}
              ·{" "}
              <span style={{ color: "#C28AE8" }} className="font-mono">
                #C28AE8
              </span>{" "}
              · 1 px ink hairline · sans-serif 700 name in ink
            </>
          }
        >
          <div className="flex items-center gap-4">
            <CollaboratorCursor name="Mira" color="#6FD38A" />
            <CollaboratorCursor name="Jakub" color="#6EB4E8" />
          </div>
        </OverlaySpec>

        <OverlaySpec
          name="Map mode switcher · top-right (optional)"
          props="same shape as tool toolbar · only shown when overrides are allowed"
        >
          <OverlayCard className="flex gap-0.5 !p-1">
            {["Paper", "Light", "Dark"].map((m, i) => (
              <span
                key={m}
                className={`rounded-md px-3 py-2 text-[12px] font-semibold ${
                  i === 0 ? "bg-ink text-cream" : "text-fg-dim"
                }`}
              >
                {m}
              </span>
            ))}
          </OverlayCard>
        </OverlaySpec>
      </div>

      {/* Bottom-centre day timeline */}
      <div className="mt-7">
        <SubStamp>Bottom-centre · Day timeline (planner only)</SubStamp>
        <div className="rounded-[14px] border border-line-strong bg-cream p-3.5 shadow-[0_12px_32px_rgba(14,14,16,0.14)]">
          <div className="mb-2.5 flex items-center justify-between">
            <Stamp>Multi-day itinerary</Stamp>
            <div className="flex gap-1.5">
              <Pill variant="ghost">
                <Mono>Export GPX</Mono>
              </Pill>
              <Pill>
                <Mono>Push to phone →</Mono>
              </Pill>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2.5">
            {(
              [
                {
                  day: 1,
                  accent: true,
                  quality: 4,
                  title: "Stelvio + Umbrail",
                  meta: "112 KM · 2 STOPS",
                  overnight: "Overnight · Santa Maria",
                },
                {
                  day: 2,
                  quality: 5,
                  title: "Livigno valley",
                  meta: "186 KM · 3 STOPS",
                  overnight: "Overnight · Livigno",
                },
                {
                  day: 3,
                  quality: 4,
                  title: "Forcola descent",
                  meta: "164 KM · 2 STOPS",
                  overnight: "Overnight · Tirano",
                },
                {
                  day: 4,
                  quality: 3,
                  title: "Aprica return",
                  meta: "148 KM · 4 STOPS",
                  overnight: "Overnight · Sondrio",
                },
              ] as const
            ).map((d) => (
              <DayCard key={d.day} {...d} />
            ))}
          </div>
        </div>
        <p className="mt-2.5 text-[12px] text-fg-dim">
          Full-width, 16 px from bottom and sides. Deeper{" "}
          <Mono>0 12 32 ink @ 14%</Mono> shadow because it sits over fluid map
          content. Active day inverts to ink; siblings stay paper-tinted with
          hairline border. Q-bars use size 3.
        </p>
      </div>

      {/* Placement table */}
      <div className="mt-7">
        <SubStamp>Slot contract</SubStamp>
        <TokenTable
          columns={[
            { label: "Slot", size: "140px" },
            { label: "Reserved for", size: "1fr" },
            { label: "Inset", size: "1fr" },
            { label: "Shadow", size: "1fr" },
          ]}
          rows={[
            [
              <Mono className="font-semibold">top-left</Mono>,
              <span className="text-fg-dim">
                Tool toolbar · filters (stack vertically)
              </span>,
              <Mono className="text-fg-mute">16 / 16</Mono>,
              <Mono className="text-fg-mute">--shadow-card</Mono>,
            ],
            [
              <Mono className="font-semibold">top-right</Mono>,
              <span className="text-fg-dim">
                Collaborators · live status · map-mode override
              </span>,
              <Mono className="text-fg-mute">16 / 16</Mono>,
              <Mono className="text-fg-mute">--shadow-card</Mono>,
            ],
            [
              <Mono className="font-semibold">bottom-left</Mono>,
              <span className="text-fg-dim">Context breadcrumb</span>,
              <Mono className="text-fg-mute">16 / 16</Mono>,
              <Mono className="text-fg-mute">--shadow-card</Mono>,
            ],
            [
              <Mono className="font-semibold">bottom-right</Mono>,
              <span className="text-fg-dim">
                Compass · scale · zoom · fit-to-bounds
              </span>,
              <Mono className="text-fg-mute">16 / 16</Mono>,
              <Mono className="text-fg-mute">
                --shadow-card (zoom) · none (compass in-svg)
              </Mono>,
            ],
            [
              <Mono className="font-semibold">bottom-centre</Mono>,
              <span className="text-fg-dim">
                Day timeline · planner only · full-width
              </span>,
              <Mono className="text-fg-mute">16 / 16</Mono>,
              <Mono className="text-fg-mute">0 12 32 ink @ 14%</Mono>,
            ],
            [
              <Mono className="font-semibold">in-svg</Mono>,
              <span className="text-fg-dim">
                Scale bar · north arrow · collab cursors
              </span>,
              <Mono className="text-fg-mute">drawn into &lt;svg&gt;</Mono>,
              <Mono className="text-fg-mute">—</Mono>,
            ],
          ]}
        />
      </div>

      {/* Rules */}
      <div className="mt-7 grid grid-cols-2 gap-6">
        <div>
          <SimpleRule
            kind="do"
            title="Keep overlays cream-on-line-strong, always."
            body="Even on dark map mode. The card breaks visually from the dark canvas — that contrast is the point."
          />
          <SimpleRule
            kind="do"
            title="Stack multiple filters in top-left with 10 px gap."
            body="Tool toolbar above quality filter above surface filter. Wraps vertically, never into the centre of the map."
          />
          <SimpleRule
            kind="do"
            title="Fade to 30 % on active drag / pan."
            body="Overlays must never block the map's hit area while the user is drawing a region or panning. Return to 100 % on idle."
          />
        </div>
        <div>
          <SimpleRule
            kind="dont"
            title="Don't introduce a 5th corner."
            body="Mid-edge placements (top-centre, left-middle) read as toast or drawer — not overlays. Use a side panel instead."
          />
          <SimpleRule
            kind="dont"
            title="Don't put primary CTAs in an overlay."
            body="Overlays are for filters, context, and status. Primary actions (Push to phone, Export GPX, Re-generate) live in the side panel or day timeline."
          />
          <SimpleRule
            kind="dont"
            title="Don't darken / tint overlays per map mode."
            body="Same cream card on paper, light, and dark map modes. Consistency over theming."
          />
          <SimpleRule
            kind="dont"
            title="Don't animate overlays in or out."
            body="They're either present or absent for the duration of the view. No fade, no slide — they're tools, not notifications."
          />
        </div>
      </div>
    </Section>
  );
}

function OverlayCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-[10px] border border-line-strong bg-cream p-2.5 px-3.5 shadow-[0_6px_16px_rgba(14,14,16,0.08)] ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

function OverlaySpec({
  name,
  props,
  children,
}: {
  name: string;
  props: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card padded={false}>
      <div className="flex min-h-[120px] items-center justify-center bg-paper px-6 py-7">
        {children}
      </div>
      <div className="border-t border-line px-3.5 py-3">
        <div className="text-[12.5px] font-bold">{name}</div>
        <div className="mt-0.5 font-mono text-[10px] leading-[1.5] text-fg-dim">
          {props}
        </div>
      </div>
    </Card>
  );
}

function ToolbarStrip() {
  return (
    <div className="flex gap-1 rounded-[10px] border border-line-strong bg-cream p-1 shadow-[0_6px_16px_rgba(14,14,16,0.08)]">
      {["Draw region", "Waypoints", "Fun Zones", "Heatmap"].map((label, i) => (
        <span
          key={label}
          className={`rounded-md px-3 py-2 text-[12px] font-semibold ${
            i === 2 ? "bg-ink text-cream" : "text-fg-dim"
          }`}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

function CollabStack({
  visibleCount = 3,
  overflowCount = 0,
}: {
  visibleCount?: number;
  overflowCount?: number;
}) {
  const peopleColors = ["#6FD38A", "#6EB4E8", palette.accent];
  const peopleLetters = ["M", "J", "L"];
  return (
    <div className="flex items-center">
      {peopleColors.slice(0, visibleCount).map((color, i) => (
        <div
          key={i}
          className={`grid size-[22px] place-items-center rounded-full border-2 border-cream text-[10px] font-bold text-ink ${
            i > 0 ? "-ml-2" : ""
          }`}
          style={{ background: color }}
        >
          {peopleLetters[i]}
        </div>
      ))}
      {overflowCount > 0 && (
        <div className="-ml-2 grid size-[22px] place-items-center rounded-full border-2 border-cream bg-ink text-[10px] font-bold text-cream">
          +{overflowCount}
        </div>
      )}
    </div>
  );
}

function QChip({
  num,
  color,
  selected,
  muted,
}: {
  num: number;
  color?: string;
  selected?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`grid size-6 place-items-center rounded-md font-mono text-[11px] font-bold ${
        muted ? "bg-paper text-fg-mute" : ""
      } ${selected ? "border-2 border-ink" : ""}`}
      style={!muted ? { background: color } : undefined}
    >
      {num}
    </div>
  );
}

function DayCard({
  day,
  accent,
  quality,
  title,
  meta,
  overnight,
}: {
  day: number;
  accent?: boolean;
  quality: 1 | 2 | 3 | 4 | 5;
  title: string;
  meta: string;
  overnight: string;
}) {
  const filled = quality;
  return (
    <div
      className={`rounded-[10px] p-2.5 ${accent ? "bg-ink text-cream" : "border border-line bg-paper"}`}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span
          className={`font-mono text-[10px] font-bold uppercase tracking-[1.4px] ${accent ? "text-accent" : "text-fg-dim"}`}
        >
          Day {day}
        </span>
        <span className="inline-flex gap-[2px]">
          {[1, 2, 3, 4, 5].map((n) => (
            <span
              key={n}
              className="inline-block"
              style={{
                width: 3,
                height: 7,
                borderRadius: 1.5,
                background:
                  n <= filled
                    ? ["#E05A3C", "#F0A03C", "#E8D66A", "#C7D36A", "#6FD38A"][
                        filled - 1
                      ]
                    : accent
                      ? "rgba(245,239,230,0.12)"
                      : "rgba(14,14,16,0.08)",
              }}
            />
          ))}
        </span>
      </div>
      <div className="text-[13px] font-bold">{title}</div>
      <div
        className={`mt-1.5 font-mono text-[11px] ${accent ? "text-cream/70" : "text-fg-dim"}`}
      >
        {meta}
      </div>
      <div
        className={`mt-1.5 text-[11px] ${accent ? "text-cream/55" : "text-fg-mute"}`}
      >
        {overnight}
      </div>
    </div>
  );
}
