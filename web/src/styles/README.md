# Dashboard design system

All visual definitions live here. Pages and browser scripts compose semantic components and never define utility strings, inline styles, or raw design values

## Ownership

`tokens.css` defines the light theme, semantic color pairs, typography, spacing scale, borders, radii, motion, and named `tablet` and `desktop` breakpoints. `base.css` owns native element defaults and keyboard focus. `components.css` owns reusable component rules and states. `layouts.css` owns page composition and responsive layout

`charts.ts` reads resolved CSS tokens when creating each Vega specification. Changing the surface, foreground, accent, palette, or font tokens updates both HTML and newly rendered charts. Re-render charts after changing tokens at runtime; there is no theme switcher or automatic theme observer. Chart geometry and Vega-specific presentation options also belong in this module

## Composition

Use `Panel`, `SectionIntro`, `Summary`, `VersionRange`, and `Status` for shared patterns. Wrapper primitives accept native HTML attributes and slots. Dynamic chart panels, benchmark cards, run rows, and messages use the corresponding helpers in `components/presentation.ts`

Use semantic classes for styling, `data-slot` to identify parts, and typed `data-variant` or `data-state` values for variations. Preserve native labels, fieldsets, links, disabled states, heading levels, and live status messages. Keep data lookup and filtering in `lib` and orchestration in `scripts`

Add new styling to the appropriate central stylesheet. Reuse semantic tokens before adding new ones. Use the named Tailwind breakpoint variants instead of literal media-query widths. Keep component-specific geometry here rather than expanding the token API for every isolated number

## Validation

Run `pnpm --dir web run check`, `pnpm --dir web run build`, and `pnpm --dir web run test:browser`. Browser tests build a production site at `/` and cover desktop and mobile navigation, filtering, failure states, raw-record links, and shared chart tokens. Install Chromium first with `pnpm --dir web exec playwright install chromium`
