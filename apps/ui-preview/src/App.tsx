import { Hero } from "./Hero";
import { Sidebar } from "./Sidebar";
import {
  ColorRulesSection,
  ColorsSection,
  QualitySection,
  ShadowSection,
  SpaceSection,
  TypeSection,
} from "./sections/Foundations";
import {
  AtomsSection,
  PillSection,
  QualityBarsSection,
} from "./sections/Atoms";
import { ControlsSection } from "./sections/Controls";
import {
  CardSection,
  MetricSection,
  NavRailSection,
  RoadPreviewSection,
  TableSection,
  TweaksSection,
} from "./sections/Components";
import {
  AlertsSection,
  ButtonsSection,
  ToastsSection,
  TooltipsSection,
} from "./sections/Feedback";
import {
  MapModesSection,
  MapOverlaysSection,
  MapVocabSection,
} from "./sections/Maps";
import {
  DensitySection,
  DoDontSection,
  LayoutsSection,
} from "./sections/Patterns";

export function App() {
  return (
    <div className="grid min-h-screen grid-cols-[240px_1fr]">
      <Sidebar />
      <main className="min-w-0">
        <Hero />

        {/* Foundations · 01–06 */}
        <ColorsSection />
        <QualitySection />
        <ColorRulesSection />
        <TypeSection />
        <SpaceSection />
        <ShadowSection />

        {/* Atoms · 07–10 */}
        <AtomsSection />
        <PillSection />
        <ControlsSection />
        <QualityBarsSection />

        {/* Components · 11–16 */}
        <CardSection />
        <MetricSection />
        <RoadPreviewSection />
        <NavRailSection />
        <TableSection />
        <TweaksSection />

        {/* Feedback · 17–20 */}
        <ButtonsSection />
        <AlertsSection />
        <TooltipsSection />
        <ToastsSection />

        {/* Maps · 21–23 */}
        <MapVocabSection />
        <MapModesSection />
        <MapOverlaysSection />

        {/* Patterns · 24–26 */}
        <LayoutsSection />
        <DensitySection />
        <DoDontSection />

        <DesignMapFooter />
      </main>
    </div>
  );
}

/**
 * Footer · mirrors the dark `.foot` block at the bottom of the source
 * HTML: orange-eyebrow "Source of truth" + serif heading + lede on the
 * left; orange-eyebrow "Hand-off checklist" + list on the right.
 */
function DesignMapFooter() {
  return (
    <footer className="grid grid-cols-2 gap-[60px] bg-ink px-[60px] pb-20 pt-12 text-cream">
      <div>
        <div className="mb-3 font-mono text-[11px] font-bold uppercase tracking-[1.6px] text-accent">
          Source of truth
        </div>
        <h3 className="font-serif text-[26px] font-bold leading-[1.15] tracking-[-0.6px]">
          Built against Web App v2.html · revision 2.
        </h3>
        <p className="mt-3.5 max-w-[60ch] text-[13px] leading-[1.6] text-cream/65">
          Tokens are defined in{" "}
          <span className="font-mono text-cream">colors_and_type.css</span>;
          components live as React functions in{" "}
          <span className="font-mono text-cream">@tarmoto/ui</span> and the
          shared <span className="font-mono text-cream">atoms.jsx</span>. If you
          change a token or component, update this map in the same PR.
        </p>
      </div>
      <div>
        <div className="mb-3 font-mono text-[11px] font-bold uppercase tracking-[1.6px] text-accent">
          Hand-off checklist
        </div>
        <ul className="m-0 list-disc pl-[18px] text-[13px] leading-[1.8] text-cream/75">
          <li>
            Pull tokens from{" "}
            <span className="font-mono text-cream">colors_and_type.css</span>
          </li>
          <li>Compose with the six atoms before custom DOM</li>
          <li>Match one of the four layout shells</li>
          <li>Respect the accent budget — one per screen</li>
          <li>Q-bars on every quality surface, never stars</li>
          <li>Ink card once per view, never twice</li>
          <li>Floating UI gets shadow-card; everything else flat</li>
        </ul>
      </div>
    </footer>
  );
}
