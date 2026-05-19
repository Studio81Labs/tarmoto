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
  TooltipsSection,
  ToastsSection,
} from "./sections/Feedback";

export function App() {
  return (
    <div className="grid grid-cols-[240px_1fr] min-h-screen">
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

        {/* Atoms · 07, 08, 10 */}
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

        <footer className="grid grid-cols-2 gap-[60px] bg-ink px-[60px] pb-20 pt-10 text-cream">
          <div>
            <h3 className="font-serif text-[22px] font-bold tracking-[-0.4px]">
              That's the library, rendered with itself.
            </h3>
            <p className="mt-3 text-[14px] text-cream/65 leading-[1.6]">
              If any section above doesn't match the Web App v2 design map, the
              library has drifted — file the diff against{" "}
              <span className="font-mono text-cream">@tarmoto/ui</span>, not
              this preview.
            </p>
          </div>
          <div className="self-end text-right font-mono text-[10px] tracking-[1px] text-cream/40 uppercase">
            Tarmoto · @tarmoto/ui · Preview
          </div>
        </footer>
      </main>
    </div>
  );
}
