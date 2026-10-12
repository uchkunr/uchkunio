// A tiny hand-drawn SVG toolkit: rough.js strokes (the library Excalidraw draws with) and
// Excalidraw's Virgil font, with text converted to paths so the SVG needs no font at runtime.
// Sketches are drawn for a light background; the site inverts them in dark mode.

import { readFileSync } from "node:fs";
import opentype from "opentype.js";
import rough from "roughjs";

const font = opentype.parse(readFileSync(new URL("./Virgil.ttf", import.meta.url)).buffer);
const generator = rough.generator();

const round = (n: number) => Math.round(n * 10) / 10;
/** rough.js writes coordinates with 15 decimals; one is plenty at this size. */
const compact = (d: string) => d.replace(/-?\d+\.\d+/g, (n) => String(round(Number(n))));

/** opentype.js 2.0's toPathData emits NaN for some glyph sequences, so serialize the commands directly. */
function pathData(commands: opentype.PathCommand[]): string {
  return commands
    .map((c) => {
      switch (c.type) {
        case "M":
        case "L":
          return `${c.type}${round(c.x)} ${round(c.y)}`;
        case "Q":
          return `Q${round(c.x1)} ${round(c.y1)} ${round(c.x)} ${round(c.y)}`;
        case "C":
          return `C${round(c.x1)} ${round(c.y1)} ${round(c.x2)} ${round(c.y2)} ${round(c.x)} ${round(c.y)}`;
        default:
          return "Z";
      }
    })
    .join("");
}

export const INK = "#1e1e1e";
export const MUTED = "#868e96";
export const FILL = {
  blue: "#a5d8ff",
  green: "#b2f2bb",
  red: "#ffc9c9",
  yellow: "#ffec99",
  violet: "#d0bfff",
  gray: "#e9ecef",
} as const;
export const STROKE = { red: "#e03131", green: "#2f9e44", blue: "#1971c2", violet: "#6741d9" } as const;

export interface Shape {
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  fillStyle?: "hachure" | "solid" | "cross-hatch" | "zigzag";
  roughness?: number;
  dashed?: boolean;
}

export interface Text {
  size?: number;
  anchor?: "start" | "middle" | "end";
  color?: string;
}

export class Sketch {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  private body: string[] = [];
  private glyphs = new Map<string, string>();
  private seed: number;

  constructor(width: number, height: number, title: string, seed = 7) {
    this.width = width;
    this.height = height;
    this.title = title;
    this.seed = seed;
  }

  private options(shape: Shape) {
    const strokeWidth = shape.strokeWidth ?? 1.6;
    return {
      seed: this.seed++,
      roughness: shape.roughness ?? 1.1,
      bowing: 1,
      stroke: shape.stroke ?? INK,
      strokeWidth,
      fill: shape.fill,
      fillStyle: shape.fillStyle ?? "hachure",
      fillWeight: 1.2,
      hachureGap: 6,
      strokeLineDash: shape.dashed ? [8, 8] : undefined,
    };
  }

  private draw(drawable: ReturnType<typeof generator.rectangle>): this {
    for (const p of generator.toPaths(drawable)) {
      const dash = drawable.options.strokeLineDash ? ` stroke-dasharray="${drawable.options.strokeLineDash.join(" ")}"` : "";
      this.body.push(
        `<path d="${compact(p.d)}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" fill="${p.fill ?? "none"}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`,
      );
    }
    return this;
  }

  rect(x: number, y: number, w: number, h: number, shape: Shape = {}): this {
    return this.draw(generator.rectangle(x, y, w, h, this.options(shape)));
  }

  ellipse(cx: number, cy: number, w: number, h: number, shape: Shape = {}): this {
    return this.draw(generator.ellipse(cx, cy, w, h, this.options(shape)));
  }

  line(x1: number, y1: number, x2: number, y2: number, shape: Shape = {}): this {
    return this.draw(generator.line(x1, y1, x2, y2, this.options(shape)));
  }

  /** A straight arrow with an open head at (x2, y2). */
  arrow(x1: number, y1: number, x2: number, y2: number, shape: Shape = {}): this {
    this.line(x1, y1, x2, y2, shape);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = 12;
    for (const side of [-1, 1]) {
      const a = angle + Math.PI + (side * Math.PI) / 7;
      this.line(x2, y2, x2 + head * Math.cos(a), y2 + head * Math.sin(a), { ...shape, dashed: false });
    }
    return this;
  }

  /**
   * Text as paths. `y` is the baseline. Each glyph is defined once in <defs> at size 100 and
   * placed with <use>, so repeated letters cost a few bytes instead of a full outline.
   */
  text(value: string, x: number, y: number, text: Text = {}): this {
    // Sketches render at roughly 0.7 to 0.8 of their size in the column; below 15 is unreadable.
    const size = Math.max(text.size ?? 20, 15);
    const scale = size / font.unitsPerEm;
    const glyphs = [...value].map((char) => {
      const glyph = font.charToGlyph(char);
      if (glyph.index === 0 && char !== " ") throw new Error(`Virgil has no glyph for "${char}" in "${value}"`);
      return glyph;
    });
    const width = glyphs.reduce((sum, g) => sum + (g.advanceWidth ?? 0) * scale, 0);
    let cursor = text.anchor === "middle" ? x - width / 2 : text.anchor === "end" ? x - width : x;
    const uses: string[] = [];
    for (const glyph of glyphs) {
      if (glyph.unicode !== 32) {
        const id = `g${glyph.index}`;
        if (!this.glyphs.has(id)) this.glyphs.set(id, pathData(glyph.getPath(0, 0, 100).commands));
        uses.push(`<use href="#${id}" transform="translate(${round(cursor)} ${round(y)}) scale(${round(size) / 100})"/>`);
      }
      cursor += (glyph.advanceWidth ?? 0) * scale;
    }
    this.body.push(`<g fill="${text.color ?? INK}">${uses.join("")}</g>`);
    return this;
  }

  /** Wraps everything drawn inside `draw` in a <g> with the given attributes (for animation). */
  group(attributes: string, draw: (sketch: this) => void): this {
    this.body.push(`<g ${attributes}>`);
    draw(this);
    this.body.push("</g>");
    return this;
  }

  /**
   * Serializes the sketch. `motion` holds animations and runs only when the reader allows motion;
   * `still` always applies and sets the frame shown without animation.
   */
  toSVG(motion = "", still = ""): string {
    const css = (still ? still : "") + (motion ? `@media (prefers-reduced-motion: no-preference) {${motion}}` : "");
    const style = css ? `<style>${css}</style>` : "";
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.width} ${this.height}" width="${this.width}" height="${this.height}" role="img">`,
      `<title>${this.title}</title>`,
      style,
      `<defs>${[...this.glyphs].map(([id, d]) => `<path id="${id}" d="${d}"/>`).join("")}</defs>`,
      ...this.body,
      "</svg>",
      "",
    ].join("\n");
  }
}
