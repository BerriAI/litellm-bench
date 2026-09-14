import type { Config } from "vega-lite";

export const chartPresentation = {
  overviewHeight: 130,
  detailHeight: 300,
  spacing: 28,
  titleOffset: 14,
  lineWidth: 2.5,
  pointSize: 70,
  annotationTop: 12,
  annotationOffset: 16,
  annotationDash: [4, 3],
} as const;

export function readChartTheme() {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string): string => styles.getPropertyValue(name).trim();
  const pixels = (name: string): number => Number.parseFloat(token(name));
  const colors = {
    foreground: token("--color-foreground"),
    muted: token("--color-muted"),
    border: token("--color-border"),
    accent: token("--color-accent"),
    surface: token("--color-surface"),
  };
  const series = [colors.accent, ...[2, 3, 4, 5].map((index) => token(`--color-series-${index}`))];
  const config: Config = {
    background: colors.surface,
    font: token("--font-sans"),
    view: { stroke: null },
    axis: {
      domain: false,
      grid: true,
      gridColor: colors.border,
      gridDash: [2, 4],
      labelColor: colors.muted,
      labelFontSize: pixels("--chart-label-size"),
      labelPadding: 10,
      tickSize: 0,
      titleColor: colors.foreground,
      titleFontSize: pixels("--chart-label-size"),
      titleFontWeight: 600,
      titlePadding: 18,
    },
    axisX: { grid: false, labelAngle: 0, labelColor: colors.foreground },
    legend: {
      labelColor: colors.muted,
      labelFontSize: pixels("--chart-caption-size"),
      labelLimit: 280,
      symbolStrokeWidth: 3,
      titleColor: colors.foreground,
      titleFontSize: pixels("--chart-caption-size"),
      titleFontWeight: 600,
    },
    point: {
      color: colors.accent,
      filled: true,
      opacity: 0.85,
      stroke: colors.surface,
      strokeWidth: 2,
    },
    title: {
      anchor: "start",
      color: colors.foreground,
      fontSize: pixels("--chart-title-size"),
      fontWeight: 600,
      subtitleColor: colors.muted,
      subtitleFontSize: pixels("--chart-caption-size"),
      offset: chartPresentation.titleOffset,
    },
  };
  return { colors, series, config };
}
