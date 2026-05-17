---
name: tarmoto-design
description: Use this skill to generate well-branded interfaces and assets for Tarmoto (a road-quality map for motorcyclists), either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

Tokens live in `colors_and_type.css` and atoms live in `atoms.jsx`. UI kits for the three products (mobile, web, marketing) live under `ui_kits/`.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts or production code, depending on the need.

## Core rules for any Tarmoto design

1. **Cream + ink first.** `#F5EFE6` bg, `#0E0E10` fg. One accent `#FF6A1A`, sparingly (<5% of pixels).
2. **Three type families.** Space Grotesk for UI, JetBrains Mono for stamps/numbers, Fraunces italic for emotional marketing beats only.
3. **No icon font.** Hand-rolled SVG, Unicode arrows and geometric marks. Lucide is the fallback if more needed.
4. **Quality is visual vocabulary.** Use `QualityBars` (1–5) and the Q1–Q5 color ramp for anything road-quality-related.
5. **Paper on paper.** No drop shadows except on devices and the occasional hover. Borders at `rgba(14,14,16,0.10)`.
6. **Never emoji in product UI.** Sparingly in marketing.
