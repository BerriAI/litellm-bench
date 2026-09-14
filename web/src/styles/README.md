# Dashboard design system

The shared route layout owns the site header, navigation, main landmark, and footer. Both the directory and benchmark routes use `$lib/components/PageHeader.svelte` for their title and description.

`tokens.css` defines semantic colors, typography, spacing, borders, radii, motion, and named breakpoints. `base.css` owns native defaults and focus styles. `components.css` owns component rules and states; `layouts.css` owns page composition and responsive layouts.

Components live in `$lib/components`. `DetailDashboard` owns filters and derived measurements; `DashboardControls` renders the filter widgets. Each `ChartPanel` owns one render's loading/error state and reads CSS tokens after mounting. `VegaChart` loads Vega in the browser and finalizes views on teardown, including renders that finish after navigation. `charts.ts` builds specifications with an explicit theme. Dynamic chart dimensions and comparison bar widths are set by their components.

Keep semantic classes, labels, heading levels, keyboard navigation, and status messages. Reuse existing tokens before introducing new values. Filesystem access and validation belong in `$lib/server/benchmarks.ts`; route loaders return only the relevant benchmark data. Published JSON remains available under `data/`.

Run `pnpm --dir web check` and `pnpm --dir web test`. Install Chromium with `pnpm --dir web exec playwright install chromium`, then run `pnpm --dir web test:browser`. Run again with `BASE_PATH=/litellm-bench` to check project-path hosting. Browser tests build fixture data into `web/dist/browser` and cover the shared shell, desktop/mobile navigation, filters, static summaries, annotations, empty data, and chart failures. Run `pnpm --dir web build` to build published data into `web/dist`.
