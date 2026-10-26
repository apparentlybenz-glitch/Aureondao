# AureonX brand

AureonX is a multi-asset trading platform on virtual funds. This file sets the rules for the mark, the wordmark and the palette. The masters live in `brand/`. Every app icon is rendered from them.

## The mark

A black disc holds a bold green A whose apex is an upward arrowhead. An orbit wraps diagonally around the A: it passes behind the left leg and in front of the right leg. A four-point sparkle sits to the left, with a few small star dots and a thin ring inset from the disc edge.

The wordmark reads "AureonX" in a geometric sans drawn as outlines, so no font is loaded. The X is brand green and the other letters are text primary.

## Palette

The app is dark only. These values are mapped into the shadcn tokens in `src/app/globals.css` (`.dark` set).

| Role | Hex | OKLCH | Token | Use |
|---|---|---|---|---|
| Brand green | `#1BA04A` | `oklch(0.619 0.165 149.2)` | `--primary`, `--ring` | Mark, primary buttons, active tab, focus ring, links |
| Brand green dark | `#137A38` | `oklch(0.509 0.134 149.5)` | none | Print and marketing only, behind white text. Never in the app |
| Background black | `#050505` | `oklch(0.115 0 0)` | `--background`, `--primary-foreground` | Page background, text on brand green |
| Surface | `#121212` | `oklch(0.182 0 0)` | `--card`, `--popover` | Cards, sheets, popovers |
| Border | `#262626` | `oklch(0.269 0 0)` | `--border`, `--input` | Dividers and input outlines |
| Text primary | `#F5F5F5` | `oklch(0.970 0 0)` | `--foreground` | Body text, wordmark letters |
| Text muted | `#A3A3A3` | `oklch(0.715 0 0)` | `--muted-foreground` | Secondary text, inactive tabs |
| Up (Rise) | `#3DD68C` | `oklch(0.779 0.165 157.3)` | `--up` (`text-up`) | Price up, positive amounts, Rise |
| Down (Fall) | `#F0505A` | `oklch(0.654 0.196 20.9)` | `--down` (`text-down`) | Price down, negative amounts, Fall |

Usage rules:
- Brand green is the identity color. It is not a market signal: price moves and gains use up, losses use down.
- Up is lighter and more minty than brand green, so the two never read as one color.

### Contrast (WCAG AA needs 4.5:1)

| Pair | Ratio |
|---|---|
| Text primary on background / surface | 18.69 / 17.18 |
| Text muted on background / surface | 8.08 / 7.43 |
| Brand green on background / surface | 5.99 / 5.51 |
| Up on background / surface | 10.87 / 9.99 |
| Down on background / surface | 5.82 / 5.35 |
| Black text on brand green | 5.99 |
| White text on brand green | 3.40 (fails) |
| Black text on up / down | 10.87 / 5.82 |
| White text on down | 3.50 (fails) |
| White text on brand green dark | 5.43 |

### Black text on green

- Primary buttons use black text (`#050505`) on brand green. White text fails AA.
- Hover and pressed states lighten the green and never darken it, because black text fails on darker greens.
- The Rise and Fall buttons use black text or icons.

## Clear space

Keep clear space on every side equal to the crossbar height of the A in the wordmark. That is 14% of the wordmark's cap height. For the mark on its own, use the same measure taken from the horizontal lockup: 8% of the disc diameter. Nothing else may sit inside that space.

## Minimum sizes

- Full mark (`mark.svg`): 48 px and above.
- Small mark (`mark-small.svg`): below 48 px. It drops the ring, the dots and the sparkle. Its A and orbit are thicker so they hold at 16 px.

## Misuse

- No recolouring. The mark is brand green on background black, or one of the mono versions.
- No stretching or skewing. Scale proportionally.
- No outlines, strokes or borders added to the mark or the wordmark.
- No shadows, glows or other effects.
- No gradients.
- No rearranging the lockups or changing the gap between the mark and the wordmark.
- The wordmark and lockups have light letters. Use them on background black or surface only.

## Files

| File | Use |
|---|---|
| `brand/mark.svg` | Full mark, 48 px and above. Source for the apple, any and maskable icons |
| `brand/mark-small.svg` | Below 48 px. Source for `src/app/icon.svg` and `src/app/favicon.ico` |
| `brand/mark-mono-white.svg` | One-color mark on dark or photo backgrounds where green is not available |
| `brand/mark-mono-black.svg` | One-color mark on light backgrounds (print, documents) |
| `brand/wordmark.svg` | Name only, where the mark is already shown nearby |
| `brand/lockup-horizontal.svg` | Default lockup: headers, Open Graph image |
| `brand/lockup-stacked.svg` | Square or narrow spaces: splash, social avatars |
| `brand/reference/mark-source.png` | Original concept screenshot. Reference only, never shipped |

Generated files (rendered from the masters, never edited by hand):

| File | Size | Source |
|---|---|---|
| `src/app/icon.svg` | vector | copy of `mark-small.svg` |
| `src/app/favicon.ico` | 16, 32, 48 | `mark-small.svg` |
| `src/app/apple-icon.png` | 180 | `mark.svg` on an opaque `#050505` square |
| `public/icons/icon-192.png`, `icon-512.png` | 192, 512 | `mark.svg`, manifest purpose `any` |
| `public/icons/maskable-192.png`, `maskable-512.png` | 192, 512 | `mark.svg` at 80% on a full `#050505` square, purpose `maskable` |
| `src/app/opengraph-image.png` | 1200 x 630 | `lockup-horizontal.svg` on `#050505` with "Trade on virtual balance" in `#A3A3A3` |

The web app manifest is `src/app/manifest.ts`, served at `/manifest.webmanifest`.
