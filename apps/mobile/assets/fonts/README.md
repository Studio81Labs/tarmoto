# Brand fonts (linked — `pod install` + Android multi-weight + device check pending)

The Tarmoto brand typefaces, vendored for the mobile app (Phase 2 of the
mobile brand migration — see `docs/design/mobile-spec/README.md`).

## What's here

The static weights the app uses (`fontWeight` 400/500/600/700/800 across the
brand styles), instanced from each family's variable `wght` axis:

| File                          | usWeightClass | `fontWeight` it serves |
| ----------------------------- | ------------- | ---------------------- |
| `SpaceGrotesk.ttf`            | 400           | 400 (Regular)          |
| `SpaceGrotesk_medium.ttf`     | 500           | 500 (Medium)           |
| `SpaceGrotesk_semibold.ttf`   | 600           | 600 (SemiBold)         |
| `SpaceGrotesk_bold.ttf`       | 700           | 700 (Bold) + 800       |
| `JetBrainsMono.ttf`           | 400           | 400 (Regular)          |
| `JetBrainsMono_medium.ttf`    | 500           | 500 (Medium)           |
| `JetBrainsMono_semibold.ttf`  | 600           | 600 (SemiBold)         |
| `JetBrainsMono_bold.ttf`      | 700           | 700 (Bold)             |
| `JetBrainsMono_extrabold.ttf` | 800           | 800 (ExtraBold)        |

All faces in a family share the internal family name (`"SpaceGrotesk"` /
`"JetBrainsMono"`) and differ by `usWeightClass`, so `fontFamily` +
`fontWeight` resolves the right face.

> **Space Grotesk has no `800`.** Its variable `wght` axis caps at **700**, so
> there's no distinct extra-bold — instancing at 800 would just relabel the 700
> outlines. The brand sans styles that use `fontWeight: "800"` (e.g. screen
> titles) therefore render at the **700 Bold** (the heaviest real weight). If
> the design wants a genuinely heavier sans title, that needs a real 800-capable
> Space Grotesk source (a design/sourcing decision) — otherwise the sans `800`
> tokens could be dropped to `700`. JetBrains Mono's axis does reach 800, so its
> ExtraBold is a real face.

> **Upright only — no italics.** Both families are vendored as upright `wght`
> sources, so no italic faces are instanced. RN 0.85 can't honour
> `fontStyle: "italic"` on these without a registered italic face: Android
> probes `<family>_italic.ttf` (absent → system-italic fallback in the wrong
> family) and iOS filters the registered family to italics before matching
> (none → collapses to upright). The brand sans therefore carries emphasis with
> **weight + colour**, not slant — the few decorative italic labels that existed
> were dropped to upright. Don't add `fontStyle: "italic"` to a brand-font style
> unless a real italic face is sourced and linked first.

The variable-font **sources** live in `../font-sources/` (outside this linked
asset root) for re-instancing; they are not bundled — `react-native-asset`
walks `./assets/fonts` recursively, so anything left here would be linked, and
the variable JetBrains Mono would collide with the static Regular's PostScript
name on iOS.

> **Status: linked — native artifacts committed.** `npx react-native-asset`
> was run (scoped to `./assets/fonts`) and its output is committed:
>
> - **iOS** — `TarmotoApp/Info.plist` `UIAppFonts` lists all nine faces and
>   `TarmotoApp.xcodeproj` adds them to the target's Copy Bundle Resources. Once
>   built, CoreText registers all nine and matches `fontWeight` to the nearest
>   `usWeightClass`, so every weight renders.
> - **Android** — the nine faces are copied to `app/src/main/assets/fonts/`.
>   `ReactFontManager`'s filename convention resolves Regular (`<family>.ttf`)
>   and Bold (`<family>_bold.ttf`) from these immediately.
>
> **Still pending — dev-machine steps that can't be run/validated headless:**
>
> - `cd ios && pod install` (regenerate the Pods workspace; not required for the
>   font assets themselves but part of a normal native bootstrap).
> - **Android multi-weight wiring.** The filename convention only covers
>   Regular/Bold, so `fontWeight` 500/600/800 still collapse to Regular/Bold on
>   Android. Wiring the dedicated faces needs an `@font` XML family in
>   `res/font/` (or `ReactFontManager.addCustomFont`) **and** a family-name that
>   resolves on both platforms — Android resource names are lowercased, so this
>   interacts with the `"SpaceGrotesk"` / `"JetBrainsMono"` strings in `brand.ts`
>   and must be verified on a build, not done blind. Left as a scoped follow-up.
> - An **on-device check** on both platforms that 500/600/700/800 brand text
>   render distinctly (not collapsed to Regular/Bold, not a system fallback).
>
> Until a build runs, brand text falls back to the platform sans/mono (graceful
> — the system font honours `fontWeight`, so weights look correct today).

## Licensing

Both are SIL Open Font License 1.1; the license text ships alongside as the
license requires:

- `OFL-SpaceGrotesk.txt` — © 2020 The Space Grotesk Project Authors
- `OFL-JetBrainsMono.txt` — © 2020 The JetBrains Mono Project Authors

## Why linking is a separate, dev-machine step

Two platform realities make "drop in a variable `.ttf` + reference its
internal name" insufficient — both must be handled and then verified on a
real build:

1. **Android resolves fonts by _filename_, not the internal name table.**
   RN's `ReactFontManager` builds paths like `fonts/<fontFamily>.ttf` and
   `fonts/<fontFamily>_bold.ttf`. So the family string in `brand.ts` must
   match the **file basename**, and the brand atoms' 700/800 weights need a
   real `_bold` file — a single variable `.ttf` named
   `SpaceGrotesk-VariableFont_wght.ttf` won't resolve and would fall back to
   system (and faux-bold the wrong default weight).

2. **Clean builds must package the generated artifacts.** Adding the folder
   to `react-native.config.js` only tells the external `react-native-asset`
   command what to copy; nothing runs it in CI/Gradle. The Android
   `assets/fonts/` copies and the iOS Xcode references + `Info.plist`
   `UIAppFonts` entries have to be generated and committed, or a fresh
   checkout builds without the fonts.

## Procedure to enable them (on a dev machine)

Steps 1–5 are **done** (committed). The residual is the on-device half (step 6)
plus the Android multi-weight wiring (step 4b), which can't be validated
headless.

1. ✅ Instance the static weights the app uses from `../font-sources/*.ttf`
   with matching internal family names — JetBrains Mono 400/500/600/700/800,
   Space Grotesk 400/500/600/700 (its `wght` axis caps at 700, so no 800).
   The repeatable generator script is described below; verify with
   `python3 -c "from fontTools import ttLib; t=ttLib.TTFont('SpaceGrotesk_semibold.ttf'); print(t['name'].getDebugName(1), t['OS/2'].usWeightClass)"`.
2. ✅ Named so Android auto-resolves the Regular (`<family>.ttf`) + Bold
   (`<family>_bold.ttf`) pair; the 500/600/800 faces carry their `usWeightClass`
   for iOS nearest-weight matching.
3. **a)** ✅ `./assets/fonts` is listed in `react-native.config.js`.
   **b)** ✅ Ran `npx react-native-asset` (scoped to fonts) and committed the
   native artifacts — Android `app/src/main/assets/fonts/` copies, iOS
   `Info.plist` `UIAppFonts` + `TarmotoApp.xcodeproj` Copy Bundle Resources
   refs, and the `link-assets-manifest.json` tracking files. ⬜ `cd ios && pod
install` still needs running on a Mac as part of a normal native bootstrap.
4. ✅ Committed everything the linker generated (Android `assets/fonts`, iOS
   project refs + `UIAppFonts`).
   ⬜ **Android multi-weight:** wire weight-aware resolution for 500/600/800
   (an `@font` XML family in `res/font/` or `ReactFontManager.addCustomFont`) —
   the filename convention alone only covers Regular/Bold on Android, and the
   resource-name/`brand.ts`-family interaction must be verified on a build.
5. ✅ `brandFonts.sans` / `.mono` are already `"SpaceGrotesk"` /
   `"JetBrainsMono"` (matching the basenames — these resolve on Android and
   register under the same name on iOS).
6. ⬜ **Validate on a device/simulator** that brand text at `fontWeight`
   500/600/700/800 renders **distinct** faces (not collapsed to Regular/Bold,
   not a system fallback) on **both** platforms.

### Regenerating the static faces

The faces were instanced with `fontTools` — pin the `wght` axis to each weight
the family supports (JetBrains Mono 400/500/600/700/800, Space Grotesk
400/500/600/700 — its axis caps at 700), set `OS/2.usWeightClass` (+ the bold
`fsSelection`/`macStyle` bits on the 700 face only), and rewrite
the `name` table family/subfamily/full/PostScript IDs to the no-space family
name so iOS resolves `fontFamily: "SpaceGrotesk"` / `"JetBrainsMono"`. Re-run
against the sources in `../font-sources/` if the upstream fonts are updated.
