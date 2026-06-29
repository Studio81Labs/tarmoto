# Brand fonts (static faces generated — native link + device check pending)

The Tarmoto brand typefaces, vendored for the mobile app (Phase 2 of the
mobile brand migration — see `docs/design/mobile-spec/README.md`).

## What's here

| Face                       | File                     | Weight | Resolves as                       |
| -------------------------- | ------------------------ | ------ | --------------------------------- |
| **Space Grotesk** Regular  | `SpaceGrotesk.ttf`       | 400    | `fontFamily: "SpaceGrotesk"`      |
| **Space Grotesk** Bold     | `SpaceGrotesk_bold.ttf`  | 700    | `"SpaceGrotesk"` + `weight: 700`  |
| **JetBrains Mono** Regular | `JetBrainsMono.ttf`      | 400    | `fontFamily: "JetBrainsMono"`     |
| **JetBrains Mono** Bold    | `JetBrainsMono_bold.ttf` | 700    | `"JetBrainsMono"` + `weight: 700` |

The variable-font **sources** live in `../font-sources/` (outside this linked
asset root) for re-instancing; they are not bundled — `react-native-asset`
walks `./assets/fonts` recursively, so anything left here would be linked, and
the variable JetBrains Mono would collide with the static Regular's PostScript
name on iOS.

> **Status: static faces generated, not yet linked.** The four static faces
> above were instanced from the variable sources (step 1 of the procedure
> below) with the Android filename convention and matching internal family
> names, and `react-native.config.js` already lists `./assets/fonts`. `brand.ts`
> already references `"SpaceGrotesk"` / `"JetBrainsMono"`. **Still pending — a
> dev-machine step that can't be done/validated headless:** running
> `npx react-native-asset` to generate + commit the native artifacts
> (Android `assets/fonts` copies, iOS Xcode refs + `Info.plist` `UIAppFonts`),
> `pod install`, and an **on-device check** that brand text renders the bundled
> faces (not a system fallback) on both platforms. Until that lands, brand text
> still falls back to the platform sans/mono (graceful — `fontWeight` carries
> emphasis).

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

Steps 1, 2, 3a, and 5 are **done** (committed). The residual is the
native-build half that can't be run/validated headless — steps 3b, 4, 6.

1. ✅ Instance static weights from each variable font (Regular 400 + Bold 700
   per family) — `../font-sources/*.ttf` → `*.ttf` here. The repeatable
   generator script is described below.
2. ✅ Named for Android's convention with matching internal family names:
   `SpaceGrotesk.ttf` / `SpaceGrotesk_bold.ttf`, `JetBrainsMono.ttf` /
   `JetBrainsMono_bold.ttf` (verify with
   `python3 -c "from fontTools import ttLib; t=ttLib.TTFont('SpaceGrotesk_bold.ttf'); print(t['name'].getDebugName(1), t['OS/2'].usWeightClass)"`).
3. **a)** ✅ `./assets/fonts` is listed in `react-native.config.js`.
   **b)** ⬜ Run `npx react-native-asset`, then `cd ios && pod install`.
4. ⬜ Commit everything the linker generated (Android `assets/fonts`, iOS
   project refs + `UIAppFonts`).
5. ✅ `brandFonts.sans` / `.mono` are already `"SpaceGrotesk"` /
   `"JetBrainsMono"` (matching the basenames — these resolve on Android and
   register under the same name on iOS).
6. ⬜ **Validate on a device/simulator** that `<Text style={{ fontFamily:
"SpaceGrotesk", fontWeight: "700" }}>` renders the bundled bold face, not a
   system fallback, on **both** platforms.

### Regenerating the static faces

The faces were instanced with `fontTools` — pin the `wght` axis to 400/700,
set `OS/2.usWeightClass` + the bold `fsSelection`/`macStyle` bits, and rewrite
the `name` table family/subfamily/full/PostScript IDs to the no-space family
name so iOS resolves `fontFamily: "SpaceGrotesk"` / `"JetBrainsMono"`. Re-run
against the sources in `../font-sources/` if the upstream fonts are updated.
