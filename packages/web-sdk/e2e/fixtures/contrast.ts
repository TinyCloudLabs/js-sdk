import type { Locator } from "@playwright/test";

export interface ContrastRow {
  label: string;
  ratio: number;
  opaque: boolean;
}

export async function textRow(label: string, locator: Locator, background: string): Promise<ContrastRow> {
  const color = await locator.evaluate((el) => getComputedStyle(el).color);
  return row(label, color, background);
}

export function row(label: string, foreground: string, background: string): ContrastRow {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  return {
    label,
    ratio: Math.round(contrast(fg.rgb, bg.rgb) * 100) / 100,
    opaque: fg.alpha === 1 && bg.alpha === 1,
  };
}

// Parses `rgb(r, g, b)` and `rgba(r, g, b, a)` as computed by the browser.
function parseColor(css: string): { rgb: Rgb; alpha: number } {
  const [r = NaN, g = NaN, b = NaN, a = 1] = (css.match(/[\d.]+/g) ?? []).map(Number);
  return { rgb: [r, g, b], alpha: a };
}

// WCAG 2.x relative luminance and contrast ratio.
type Rgb = [number, number, number];

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
