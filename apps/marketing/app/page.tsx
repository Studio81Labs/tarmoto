import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { ScrollReveal } from "@/components/ScrollReveal";
import { Hero } from "@/components/Hero";
import { TrustStrip } from "@/components/TrustStrip";
import { Pillars } from "@/components/Pillars";
import { PlannerDeep } from "@/components/PlannerDeep";
import { RoadQuality } from "@/components/RoadQuality";
import { Workflow } from "@/components/Workflow";
import { Features } from "@/components/Features";
import { Founder } from "@/components/Founder";
import { Roadmap } from "@/components/Roadmap";
import { Pricing } from "@/components/Pricing";
import { Faq } from "@/components/Faq";
import { FinalCta } from "@/components/FinalCta";

export default function HomePage() {
  return (
    <>
      <ScrollReveal />
      <Nav />
      <Hero />
      <TrustStrip />
      <Pillars />
      <PlannerDeep />
      <RoadQuality />
      <Workflow />
      <Features />
      <Founder />
      <Roadmap />
      <Pricing />
      <Faq />
      <FinalCta />
      <Footer />
    </>
  );
}
