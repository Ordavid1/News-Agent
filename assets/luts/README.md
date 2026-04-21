# V4 LUT Library

Drop `.cube` files into this directory and `corrections/` to activate V4 color grading.

## Creative LUTs (applied once per episode)

Expected files — filenames declared in `library.json`:

- `bs_warm_cinematic.cube`
- `bs_cool_noir.cube`
- `bs_golden_hour.cube`
- `bs_urban_grit.cube`
- `bs_dreamy_ethereal.cube`
- `bs_retro_film.cube`
- `bs_high_contrast_moody.cube`
- `bs_naturalistic.cube` (also used as the safe fallback)

## Per-model correction LUTs (applied per-beat before the creative pass)

`corrections/`:

- `correct_omnihuman.cube` — neutralizes OmniHuman 1.5's warm-green portrait bias
- `correct_veo.cube` — neutralizes Veo 3.1's photoreal-clinical bias
- `correct_kling.cube` — neutralizes Kling's warm-saturated bias

## Sources (free)

- **FreshLUTs** — https://freshluts.com/ (community-submitted, free, browsable by style)
- **RocketStock** — https://www.rocketstock.com/free-after-effects-templates/35-free-luts-for-color-grading-videos/ (35 free cinematic LUTs, `.cube` format)
- **Lutify.me** — https://lutify.me/free-luts/ (free starter packs)
- **DaVinci Resolve built-ins** — exported from Resolve's LUT browser (LUT > Export)

## Graceful fallback

The V4 post-production helper at `services/v4/PostProduction.js` gracefully
skips the LUT pass if a file is missing — it logs a warning and outputs the
video ungraded instead of failing the episode. Until real `.cube` files are
dropped in here, V4 episodes will render without color grading.
