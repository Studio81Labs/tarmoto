# Brand fonts (source — not yet linked)

The Tarmoto brand typefaces, vendored for the mobile app (Phase 2 of the
mobile brand migration — see `docs/design/mobile-spec/README.md`).

| Family             | File                                  | Variable axis  |
| ------------------ | ------------------------------------- | -------------- |
| **Space Grotesk**  | `SpaceGrotesk-VariableFont_wght.ttf`  | `wght` 300–700 |
| **JetBrains Mono** | `JetBrainsMono-VariableFont_wght.ttf` | `wght` 100–800 |

> **Status: source only.** These `.ttf` files are checked in so the linking
> work has its inputs, but the app does **not** load them yet. `brand.ts`
> still uses placeholder family names and brand text falls back to the
> platform sans/mono (leaning on `fontWeight`). Wiring them up correctly
> needs a native build + device validation, which can't be done in the
> headless environment these were added from — so it's deliberately split
> into a follow-up done on a dev machine.

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

1. Instance static weights from each variable font (e.g. with
   `fonttools varLib.instancer`): a Regular (400) and Bold (700) per family.
2. Name them for Android's convention and set matching internal family
   names, e.g. `SpaceGrotesk.ttf` / `SpaceGrotesk_bold.ttf`,
   `JetBrainsMono.ttf` / `JetBrainsMono_bold.ttf`.
3. Add `./assets/fonts` to `assets` in `react-native.config.js`, run
   `npx react-native-asset`, then `cd ios && pod install`.
4. Commit everything the linker generated (Android `assets/fonts`, iOS
   project refs + `UIAppFonts`).
5. Set `brandFonts.sans` / `.mono` to the resolvable family names
   (`"SpaceGrotesk"` / `"JetBrainsMono"`, matching the basenames — these
   resolve on Android and register under the same name on iOS).
6. **Validate on a device/simulator** that `<Text style={{ fontFamily:
"SpaceGrotesk", fontWeight: "700" }}>` renders the bundled bold face, not
   a system fallback, on **both** platforms.
