# Brand fonts

The Tarmoto brand typefaces, bundled for the mobile app (Phase 2 of the
mobile brand migration — see `docs/design/mobile-spec/README.md`).

| Family             | File                                  | Axis           | Use                                  |
| ------------------ | ------------------------------------- | -------------- | ------------------------------------ |
| **Space Grotesk**  | `SpaceGrotesk-VariableFont_wght.ttf`  | `wght` 300–700 | UI sans — `brandFonts.sans`          |
| **JetBrains Mono** | `JetBrainsMono-VariableFont_wght.ttf` | `wght` 100–800 | Stamps / numbers — `brandFonts.mono` |

Both are **variable** fonts (single file covers every weight), so
`fontFamily` + `fontWeight` resolves without one file per weight. The
`fontFamily` strings in `apps/mobile/src/theme/brand.ts` are the fonts'
**internal family names** (`"Space Grotesk"`, `"JetBrains Mono"`), read from
the binaries' `name` tables — not the file basenames.

> Note: Space Grotesk's heaviest weight is **700** (Bold); the design's
> occasional 800 headings clamp to 700, which is the typeface's real max.

## Licensing

Both are SIL Open Font License 1.1. The license text ships alongside the
fonts as required:

- `OFL-SpaceGrotesk.txt` — © 2020 The Space Grotesk Project Authors
- `OFL-JetBrainsMono.txt` — © 2020 The JetBrains Mono Project Authors

## Linking + on-device validation

`react-native.config.js` lists `./assets/fonts` under `assets`. After
pulling this change:

```bash
npx react-native-asset      # copies + registers the .ttf into iOS & Android
cd ios && pod install        # iOS only
# then rebuild the native app (Metro reload is not enough for new fonts)
```

The `.ttf` linking can only be verified on a real build, which this
environment can't run. **Before relying on brand typography, validate on a
device/simulator** that `<Text style={{ fontFamily: "Space Grotesk" }}>` and
`"JetBrains Mono"` render the bundled faces (not a system fallback). If
Android falls back, confirm the registered family name with
`react-native-asset`'s output and adjust the `fontFamily` constant or add a
`Platform.select` mapping. Until then, brand text gracefully falls back to
the platform sans/mono and leans on `fontWeight`.
