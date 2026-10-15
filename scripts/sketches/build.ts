// Draws every sketch into public/sketches/<post>/<name>.svg.
//
//   pnpm sketches            all sketches
//   pnpm sketches outbox     only names starting with "outbox"
//
// Labels are technical terms and numbers on purpose: one image serves the Uzbek, English and
// Russian versions of a post, and each post gives it a translated alt text.

import { mkdirSync, writeFileSync } from "node:fs";
import { FILL, INK, MUTED, STROKE, Sketch } from "./lib.ts";

const OUT = new URL("../../public/sketches/", import.meta.url);
const sketches: Record<string, () => string> = {};

const pct = (t: number, cycle: number) => +((t / cycle) * 100).toFixed(2);

/** Bars that fill left to right in real time, then hold until the cycle restarts. */
function race(cycle: number, lanes: { name: string; seconds: number }[]): string {
  return lanes
    .map(({ name, seconds }) => {
      const end = pct(seconds, cycle);
      return `
        .${name}-bar { animation: ${name}-fill ${cycle}s linear infinite; }
        .${name}-label { animation: ${name}-show ${cycle}s step-end infinite; }
        @keyframes ${name}-fill { 0% { clip-path: inset(0 100% 0 0); } ${end}%, 100% { clip-path: inset(0 0 0 0); } }
        @keyframes ${name}-show { 0% { opacity: 0; } ${end}%, 100% { opacity: 1; } }`;
    })
    .join("");
}

interface Lane {
  label: string;
  /** Animation length in seconds; scale real timings yourself and say so in the subtitle. */
  seconds: number;
  /** Text shown at the end of the bar once it is full. */
  value: string;
  fill: string;
  stroke: string;
  valueColor?: string;
}

/** The standard animated benchmark: one bar per lane filling in (scaled) real time. */
function raceChart(title: string, subtitle: string, lanes: Lane[], cycle = 4.5, width = 760): string {
  const labelWidth = 225;
  const max = Math.max(...lanes.map((l) => l.seconds));
  const scale = (width - labelWidth - 130) / max;
  const s = new Sketch(width, 70 + lanes.length * 64, title);
  s.text(subtitle, 30, 36, { size: 17, color: MUTED });
  const named = lanes.map((lane, i) => ({ ...lane, name: `l${i}` }));
  named.forEach((lane, i) => {
    const y = 66 + i * 64;
    const w = Math.max(lane.seconds * scale, 8);
    s.text(lane.label, 30, y + 26, { size: 19 });
    s.line(labelWidth, y + 40, width - 60, y + 40, { stroke: MUTED, strokeWidth: 1, roughness: 0.6 });
    s.group(`class="${lane.name}-bar"`, (g) => g.rect(labelWidth, y, w, 34, { fill: lane.fill, stroke: lane.stroke }));
    s.group(`class="${lane.name}-label"`, (g) => g.text(lane.value, labelWidth + w + 12, y + 25, { size: 19, color: lane.valueColor ?? INK }));
  });
  return s.toSVG(race(cycle, named));
}

/** An element visible from `from` to `to` seconds of every cycle. */
function during(cls: string, cycle: number, from: number, to: number): string {
  const frames: string[] = [];
  if (from > 0) frames.push(`0% { opacity: 0; }`);
  frames.push(`${pct(from, cycle)}% { opacity: 1; }`);
  if (to < cycle) frames.push(`${pct(to, cycle)}%, 100% { opacity: 0; }`);
  else frames.push(`100% { opacity: 1; }`);
  return `.${cls} { animation: ${cls} ${cycle}s step-end infinite; } @keyframes ${cls} { ${frames.join(" ")} }`;
}

// Sketches, one section per post. Register each as sketches["<post>/<name>"].

// Write everything registered above. Keep this at the end of the file.
const only = process.argv[2];
for (const [name, draw] of Object.entries(sketches)) {
  if (only && !name.startsWith(only)) continue;
  const file = new URL(`${name}.svg`, OUT);
  mkdirSync(new URL(".", file), { recursive: true });
  const svg = draw();
  writeFileSync(file, svg);
  console.log(`${name}.svg  ${(svg.length / 1024).toFixed(1)} KB`);
}
