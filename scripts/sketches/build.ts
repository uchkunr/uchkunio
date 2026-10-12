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

/** An element visible from `from` to `to` seconds of every cycle. */
function during(cls: string, cycle: number, from: number, to: number): string {
  const frames: string[] = [];
  if (from > 0) frames.push(`0% { opacity: 0; }`);
  frames.push(`${pct(from, cycle)}% { opacity: 1; }`);
  if (to < cycle) frames.push(`${pct(to, cycle)}%, 100% { opacity: 0; }`);
  else frames.push(`100% { opacity: 1; }`);
  return `.${cls} { animation: ${cls} ${cycle}s step-end infinite; } @keyframes ${cls} { ${frames.join(" ")} }`;
}

// npm-check-updates ---------------------------------------------------------------------------

sketches["npm/payload"] = () => {
  const s = new Sketch(760, 300, "GET /typescript returns 15.8 MB; GET /typescript/latest returns 4.8 KB");
  s.rect(30, 115, 140, 90, { fill: FILL.gray });
  s.text("your CLI", 100, 167, { anchor: "middle", size: 22 });

  s.arrow(175, 128, 365, 80);
  s.text("GET /typescript", 190, 72, { size: 17 });
  s.rect(380, 20, 350, 130, { fill: FILL.red, stroke: STROKE.red });
  s.text("15.8 MB", 555, 88, { anchor: "middle", size: 40 });
  s.text("every version, its dependencies, its dates", 555, 125, { anchor: "middle", size: 15, color: MUTED });

  s.arrow(175, 192, 365, 240);
  s.text("GET /typescript/latest", 172, 268, { size: 17 });
  s.rect(380, 215, 90, 50, { fill: FILL.green, stroke: STROKE.green });
  s.text("4.8 KB", 425, 247, { anchor: "middle", size: 19 });
  s.text("only the latest version", 490, 247, { size: 15, color: MUTED });
  return s.toSVG();
};

sketches["npm/race"] = () => {
  const s = new Sketch(760, 270, "Checking 78 dependencies: ncu 2.75 s, fast-ncu 2.70 s at 15 requests, 0.88 s at 30");
  s.text("78 dependencies, cold cache, real time", 30, 36, { size: 17, color: MUTED });
  const scale = 500 / 3; // px per second
  const lanes = [
    { name: "a", label: "ncu", seconds: 2.75, fill: FILL.gray, stroke: INK },
    { name: "b", label: "fast-ncu, 15", seconds: 2.7, fill: FILL.blue, stroke: STROKE.blue },
    { name: "c", label: "fast-ncu, 30", seconds: 0.88, fill: FILL.green, stroke: STROKE.green },
  ];
  lanes.forEach((lane, i) => {
    const y = 70 + i * 62;
    const w = lane.seconds * scale;
    s.text(lane.label, 30, y + 26, { size: 20 });
    s.line(190, y + 40, 700, y + 40, { stroke: MUTED, strokeWidth: 1, roughness: 0.6 });
    s.group(`class="${lane.name}-bar"`, (g) => g.rect(190, y, w, 34, { fill: lane.fill, stroke: lane.stroke }));
    s.group(`class="${lane.name}-label"`, (g) => g.text(`${lane.seconds.toFixed(2)} s`, 190 + w + 12, y + 25, { size: 20 }));
  });
  return s.toSVG(race(4.5, lanes));
};

// pgmq-ts -------------------------------------------------------------------------------------

sketches["pgmq/dual-write"] = () => {
  const s = new Sketch(860, 370, "Two systems lose the message when the process dies; one Postgres transaction keeps the row and the message together");
  s.text("two systems", 30, 35, { size: 18, color: MUTED });
  s.rect(30, 140, 100, 60, { fill: FILL.gray });
  s.text("app", 80, 177, { anchor: "middle", size: 22 });
  s.rect(220, 60, 170, 70, { fill: FILL.blue, stroke: STROKE.blue });
  s.text("Postgres", 305, 102, { anchor: "middle", size: 22 });
  s.rect(220, 220, 170, 70, { fill: FILL.yellow });
  s.text("Kafka", 305, 262, { anchor: "middle", size: 22 });
  s.arrow(135, 155, 215, 100);
  s.text("1. INSERT", 120, 115, { size: 15, color: MUTED });
  s.arrow(135, 185, 215, 250, { stroke: STROKE.red, dashed: true });
  s.line(165, 205, 190, 230, { stroke: STROKE.red, strokeWidth: 2.4 });
  s.line(190, 205, 165, 230, { stroke: STROKE.red, strokeWidth: 2.4 });
  s.text("2. send", 105, 252, { size: 15, color: MUTED });
  s.text("process dies here: row saved, message lost", 210, 330, { anchor: "middle", size: 16, color: STROKE.red });

  s.line(440, 30, 440, 340, { stroke: MUTED, strokeWidth: 1, dashed: true });

  s.text("one transaction", 470, 35, { size: 18, color: MUTED });
  s.rect(470, 140, 100, 60, { fill: FILL.gray });
  s.text("app", 520, 177, { anchor: "middle", size: 22 });
  s.rect(630, 50, 210, 270, { fill: FILL.blue, stroke: STROKE.blue, fillStyle: "solid" });
  s.text("Postgres", 735, 82, { anchor: "middle", size: 22 });
  s.rect(648, 100, 174, 190, { dashed: true });
  s.text("BEGIN ... COMMIT", 735, 125, { anchor: "middle", size: 15, color: MUTED });
  s.rect(665, 140, 140, 50, { fill: FILL.gray, fillStyle: "solid" });
  s.text("orders", 735, 171, { anchor: "middle", size: 18 });
  s.rect(665, 215, 140, 50, { fill: FILL.green, fillStyle: "solid" });
  s.text("pgmq.q_events", 735, 246, { anchor: "middle", size: 16 });
  s.arrow(575, 170, 640, 170);
  s.text("both or neither", 735, 352, { anchor: "middle", size: 18, color: STROKE.green });
  return s.toSVG();
};

// yardlens ------------------------------------------------------------------------------------

sketches["yardlens/threads"] = () => {
  const s = new Sketch(860, 300, "Per camera: a capture thread keeps only the newest frame; inference at 3 fps and rendering at 15 fps read it independently");
  s.rect(20, 120, 110, 60, { fill: FILL.gray });
  s.text("camera", 75, 157, { anchor: "middle", size: 20 });
  s.arrow(135, 150, 170, 150);
  s.rect(175, 120, 120, 60, { fill: FILL.blue, stroke: STROKE.blue });
  s.text("capture", 235, 157, { anchor: "middle", size: 20 });
  s.arrow(300, 150, 335, 150);
  s.rect(340, 110, 120, 80, { fill: FILL.yellow });
  s.text("latest", 400, 145, { anchor: "middle", size: 20 });
  s.text("frame", 400, 170, { anchor: "middle", size: 20 });

  s.arrow(465, 130, 525, 75);
  s.rect(530, 40, 150, 64, { fill: FILL.violet, stroke: STROKE.violet });
  s.text("inference", 605, 70, { anchor: "middle", size: 20 });
  s.text("YOLO, 3 fps", 605, 93, { anchor: "middle", size: 14, color: MUTED });
  s.arrow(685, 72, 720, 72);
  s.rect(725, 42, 115, 60, { fill: FILL.green, stroke: STROKE.green });
  s.text("events", 782, 79, { anchor: "middle", size: 20 });

  s.arrow(465, 170, 525, 225);
  s.rect(530, 196, 150, 64, { fill: FILL.violet, stroke: STROKE.violet });
  s.text("render", 605, 226, { anchor: "middle", size: 20 });
  s.text("15 fps", 605, 249, { anchor: "middle", size: 14, color: MUTED });
  s.arrow(685, 228, 720, 228);
  s.rect(725, 198, 115, 60, { fill: FILL.gray });
  s.text("MJPEG", 782, 235, { anchor: "middle", size: 20 });

  s.text("a new frame overwrites the old one: nothing queues", 20, 250, { size: 15, color: MUTED });
  return s.toSVG();
};

sketches["yardlens/queue-vs-latest"] = () => {
  const s = new Sketch(860, 330, "With a queue the lag grows every second; with only the latest frame it stays under one frame");
  const cycle = 6.2;
  const arrive = (i: number) => i * 0.2;
  s.text("camera 5 frames/s, model 1 frame/s", 840, 30, { anchor: "end", size: 15, color: MUTED });

  s.text("queue", 20, 52, { size: 18 });
  s.rect(20, 65, 90, 50, { fill: FILL.blue, stroke: STROKE.blue });
  s.text("model", 65, 97, { anchor: "middle", size: 18 });
  const motion: string[] = [];
  const still: string[] = [];
  for (let i = 0; i < 30; i++) {
    const consumed = i < 6 ? i + 1 : cycle;
    s.group(`class="q${i}"`, (g) => g.rect(140 + i * 23, 80, 18, 18, { fill: FILL.blue, fillStyle: "solid", stroke: STROKE.blue, roughness: 0.8 }));
    motion.push(during(`q${i}`, cycle, arrive(i), consumed));
    if (i < 6) still.push(`.q${i} { opacity: 0; }`);
  }
  for (let second = 1; second <= 6; second++) {
    const cls = `lag${second}`;
    s.group(`class="${cls}"`, (g) => g.text(`lag ${second * 4} s`, 140, 145, { size: 20, color: STROKE.red }));
    motion.push(during(cls, cycle, second, second === 6 ? cycle : second + 1));
    if (second !== 6) still.push(`.${cls} { opacity: 0; }`);
  }
  s.arrow(135, 90, 115, 90);

  s.line(20, 180, 840, 180, { stroke: MUTED, strokeWidth: 1, dashed: true });

  s.text("latest frame", 20, 220, { size: 18 });
  s.rect(20, 233, 90, 50, { fill: FILL.green, stroke: STROKE.green });
  s.text("model", 65, 265, { anchor: "middle", size: 18 });
  s.rect(136, 244, 28, 28, { dashed: true, stroke: MUTED });
  for (let i = 0; i < 2; i++) {
    s.group(`class="slot${i}"`, (g) => g.rect(141, 249, 18, 18, { fill: FILL.green, fillStyle: "solid", stroke: STROKE.green, roughness: 0.8 }));
  }
  motion.push(during("slot0", 0.4, 0, 0.2), during("slot1", 0.4, 0.2, 0.4));
  still.push(".slot1 { opacity: 0; }");
  s.arrow(132, 258, 115, 258);
  s.text("lag 0.2 s, always", 185, 265, { size: 20, color: STROKE.green });
  s.text("older frames are overwritten, never queued", 185, 300, { size: 15, color: MUTED });
  return s.toSVG(motion.join(""), still.join(""));
};

// multi-tenancy -------------------------------------------------------------------------------

sketches["multi-tenancy/rls"] = () => {
  const s = new Sketch(860, 340, "The interceptor sets the tenant for the transaction; the RLS policy returns only that tenant's rows");
  s.rect(20, 135, 130, 60, { fill: FILL.gray });
  s.text("request", 85, 170, { anchor: "middle", size: 20 });
  s.text("JWT: tenant A", 85, 220, { anchor: "middle", size: 15, color: MUTED });
  s.arrow(155, 165, 205, 165);
  s.rect(210, 110, 200, 110, { fill: FILL.violet, stroke: STROKE.violet });
  s.text("interceptor", 310, 142, { anchor: "middle", size: 20 });
  s.text("BEGIN", 310, 170, { anchor: "middle", size: 15, color: MUTED });
  s.text("set_config(tenant A)", 310, 192, { anchor: "middle", size: 15, color: MUTED });
  s.arrow(415, 165, 470, 165);

  s.rect(475, 30, 365, 290, { fill: FILL.blue, stroke: STROKE.blue, fillStyle: "solid" });
  s.text("invoices", 500, 62, { size: 20 });
  const rows = [
    ["A", "100.00"],
    ["B", "900.00"],
    ["A", "250.00"],
    ["B", "40.00"],
    ["A", "42.00"],
  ];
  rows.forEach(([tenant, amount], i) => {
    const y = 80 + i * 44;
    const mine = tenant === "A";
    s.rect(500, y, 150, 34, {
      fill: mine ? FILL.green : FILL.gray,
      fillStyle: "solid",
      stroke: mine ? STROKE.green : MUTED,
    });
    s.text(`${tenant}   ${amount}`, 515, y + 24, { size: 17, color: mine ? INK : MUTED });
    if (!mine) s.line(505, y + 17, 645, y + 17, { stroke: STROKE.red, strokeWidth: 2 });
  });
  s.text("RLS policy:", 670, 120, { size: 17 });
  s.text("tenant_id =", 670, 148, { size: 15, color: MUTED });
  s.text("app.tenant_id", 670, 170, { size: 15, color: MUTED });
  s.text("app sees", 670, 235, { size: 17 });
  s.text("only A", 670, 262, { size: 17, color: STROKE.green });
  return s.toSVG();
};

sketches["multi-tenancy/index-race"] = () => {
  const s = new Sketch(760, 220, "Sum for one tenant on 1M rows: 118.8 ms with a sequential scan, 3.2 ms with an index on tenant_id");
  s.text("1 000 000 rows, 1000 tenants, slowed down 25x", 30, 36, { size: 17, color: MUTED });
  const scale = 500 / 3.2; // px per second of animation
  const lanes = [
    { name: "seq", label: "Seq Scan", ms: 118.757, fill: FILL.red, stroke: STROKE.red },
    { name: "idx", label: "Index Scan", ms: 3.159, fill: FILL.green, stroke: STROKE.green },
  ];
  const timed = lanes.map((lane) => ({ ...lane, seconds: (lane.ms / 1000) * 25 }));
  timed.forEach((lane, i) => {
    const y = 70 + i * 66;
    const w = Math.max(lane.seconds * scale, 8);
    s.text(lane.label, 30, y + 26, { size: 20 });
    s.line(170, y + 40, 700, y + 40, { stroke: MUTED, strokeWidth: 1, roughness: 0.6 });
    s.group(`class="${lane.name}-bar"`, (g) => g.rect(170, y, w, 34, { fill: lane.fill, stroke: lane.stroke }));
    s.group(`class="${lane.name}-label"`, (g) => g.text(`${lane.ms.toFixed(1)} ms`, 170 + w + 12, y + 25, { size: 20 }));
  });
  return s.toSVG(race(4.5, timed));
};

// transactional outbox ------------------------------------------------------------------------

sketches["outbox/flow"] = () => {
  const s = new Sketch(900, 290, "The order and its outbox row commit together; a relay sends the row to Kafka; the consumer skips duplicates");
  s.rect(20, 110, 100, 60, { fill: FILL.gray });
  s.text("service", 70, 147, { anchor: "middle", size: 19 });
  s.arrow(125, 140, 160, 140);
  s.rect(165, 30, 240, 220, { dashed: true });
  s.text("one transaction", 285, 58, { anchor: "middle", size: 16, color: MUTED });
  s.rect(185, 75, 200, 55, { fill: FILL.gray });
  s.text("orders", 285, 109, { anchor: "middle", size: 19 });
  s.rect(185, 160, 200, 55, { fill: FILL.yellow });
  s.text("outbox", 285, 194, { anchor: "middle", size: 19 });
  s.arrow(390, 187, 445, 145);
  s.rect(450, 110, 130, 60, { fill: FILL.violet, stroke: STROKE.violet });
  s.text("relay", 515, 138, { anchor: "middle", size: 19 });
  s.text("SKIP LOCKED", 515, 160, { anchor: "middle", size: 15, color: MUTED });
  s.arrow(585, 140, 620, 140);
  s.rect(625, 110, 100, 60, { fill: FILL.yellow });
  s.text("Kafka", 675, 147, { anchor: "middle", size: 19 });
  s.arrow(730, 140, 760, 140);
  s.rect(765, 110, 125, 60, { fill: FILL.green, stroke: STROKE.green });
  s.text("consumer", 827, 138, { anchor: "middle", size: 18 });
  s.text("dedup by id", 827, 160, { anchor: "middle", size: 15, color: MUTED });
  s.text("at least once: duplicates are expected", 640, 230, { anchor: "middle", size: 15, color: MUTED });

  // The message: drawn at the origin and moved along the pipeline.
  s.group(`class="msg"`, (g) => {
    g.rect(-14, -10, 28, 20, { fill: FILL.red, fillStyle: "solid", stroke: STROKE.red, roughness: 0.7 });
    g.line(-14, -10, 0, 2, { stroke: STROKE.red, roughness: 0.5 });
    g.line(0, 2, 14, -10, { stroke: STROKE.red, roughness: 0.5 });
  });
  const stops: [number, number, number][] = [
    [0, 345, 187],
    [0.25, 345, 187],
    [0.4, 515, 92],
    [0.55, 515, 92],
    [0.7, 675, 92],
    [0.8, 675, 92],
    [0.92, 827, 92],
    [1, 827, 92],
  ];
  const frames = stops.map(([t, x, y]) => `${(t * 100).toFixed(0)}% { transform: translate(${x}px, ${y}px); }`).join(" ");
  const motion = `.msg { animation: msg 5s ease-in-out infinite; } @keyframes msg { ${frames} }`;
  const still = `.msg { transform: translate(345px, 187px); }`;
  return s.toSVG(motion, still);
};

sketches["outbox/cursor-gap"] = () => {
  const s = new Sketch(860, 330, "Transaction A takes id 7 but commits after B's id 8; a relay reading id > cursor skips 7 forever");
  const x = (t: number) => 140 + t * 140;
  s.arrow(130, 290, 840, 290, { stroke: MUTED });
  s.text("time", 840, 315, { anchor: "end", size: 15, color: MUTED });

  s.text("tx A", 20, 75, { size: 20 });
  s.rect(x(0), 52, x(3.2) - x(0), 34, { fill: FILL.red, stroke: STROKE.red });
  s.text("id 7", x(0) + 12, 76, { size: 17 });
  s.text("COMMIT", x(3.2) + 10, 76, { size: 17 });

  s.text("tx B", 20, 145, { size: 20 });
  s.rect(x(0.8), 122, x(1.5) - x(0.8), 34, { fill: FILL.blue, stroke: STROKE.blue });
  s.text("id 8", x(0.8) + 12, 146, { size: 17 });
  s.text("COMMIT", x(1.5) + 10, 146, { size: 17 });

  s.text("relay", 20, 225, { size: 20 });
  s.ellipse(x(2.2), 218, 16, 16, { fill: INK, fillStyle: "solid" });
  s.text("id > 6 -> 8", x(2.2) - 20, 252, { size: 15 });
  s.text("cursor = 8", x(2.2) - 20, 272, { size: 15, color: MUTED });
  s.ellipse(x(3.9), 218, 16, 16, { fill: INK, fillStyle: "solid" });
  s.text("id > 8 -> nothing", x(3.9) - 20, 252, { size: 15 });
  s.text("7 is never sent", x(3.9) - 20, 200, { size: 18, color: STROKE.red });
  return s.toSVG();
};

// microservices -------------------------------------------------------------------------------

sketches["microservices/map"] = () => {
  const s = new Sketch(860, 350, "Client to API gateway to three services, each owning its database, publishing events to Kafka");
  s.rect(20, 145, 100, 60, { fill: FILL.gray });
  s.text("client", 70, 182, { anchor: "middle", size: 20 });
  s.arrow(125, 175, 165, 175);
  s.rect(170, 140, 130, 70, { fill: FILL.violet, stroke: STROKE.violet });
  s.text("API", 235, 170, { anchor: "middle", size: 20 });
  s.text("gateway", 235, 195, { anchor: "middle", size: 20 });
  const services = [
    { name: "orders", y: 35 },
    { name: "payments", y: 148 },
    { name: "stock", y: 261 },
  ];
  for (const { name, y } of services) {
    s.arrow(305, 175, 370, y + 27);
    s.rect(375, y, 130, 55, { fill: FILL.blue, stroke: STROKE.blue });
    s.text(name, 440, y + 34, { anchor: "middle", size: 19 });
    s.line(510, y + 27, 545, y + 27);
    // A cylinder: body, sides, then the lid on top.
    s.ellipse(590, y + 45, 80, 18, { fill: FILL.gray, fillStyle: "solid" });
    s.rect(550, y + 8, 80, 37, { fill: FILL.gray, fillStyle: "solid", stroke: "none" });
    s.line(550, y + 8, 550, y + 45);
    s.line(630, y + 8, 630, y + 45);
    s.ellipse(590, y + 8, 80, 18, { fill: FILL.gray, fillStyle: "solid" });
    s.text("db", 590, y + 38, { anchor: "middle", size: 16 });
    s.arrow(635, y + 27, 705, y + 27, { dashed: true, stroke: MUTED });
  }
  s.rect(710, 30, 130, 290, { fill: FILL.yellow });
  s.text("Kafka", 775, 172, { anchor: "middle", size: 22 });
  s.text("events", 775, 200, { anchor: "middle", size: 15, color: MUTED });
  s.text("via outbox", 775, 220, { anchor: "middle", size: 15, color: MUTED });
  s.text("traceparent travels with every call", 20, 335, { size: 15, color: MUTED });
  return s.toSVG();
};

sketches["microservices/breaker"] = () => {
  const s = new Sketch(860, 300, "Circuit breaker: closed until 3 failures, open for 1 s, then one half-open probe decides");
  const cycle = 4;
  const states = [
    { cls: "closed", label: "closed", x: 150, fill: FILL.green, stroke: STROKE.green, from: 0, to: 1.2 },
    { cls: "open", label: "open", x: 430, fill: FILL.red, stroke: STROKE.red, from: 1.2, to: 2.6 },
    { cls: "half", label: "half-open", x: 710, fill: FILL.yellow, stroke: INK, from: 2.6, to: 3.1 },
  ];
  const motion: string[] = [];
  // Fills first, so outlines and labels stay on top of whichever state is lit.
  for (const state of states) {
    s.group(`class="${state.cls}"`, (g) => g.ellipse(state.x, 130, 180, 90, { fill: state.fill, stroke: state.stroke }));
    motion.push(during(state.cls, cycle, state.from, state.to));
  }
  s.group(`class="closed2"`, (g) => g.ellipse(150, 130, 180, 90, { fill: FILL.green, stroke: STROKE.green }));
  motion.push(during("closed2", cycle, 3.1, cycle));
  for (const state of states) {
    s.ellipse(state.x, 130, 180, 90, { stroke: state.stroke });
    s.text(state.label, state.x, 138, { anchor: "middle", size: 22 });
  }

  s.arrow(245, 112, 335, 112);
  s.text("3 failures", 290, 95, { anchor: "middle", size: 15 });
  s.arrow(525, 112, 615, 112);
  s.text("after 1 s", 570, 95, { anchor: "middle", size: 15 });
  s.arrow(615, 152, 525, 152);
  s.text("probe fails", 570, 180, { anchor: "middle", size: 15 });
  s.line(710, 178, 710, 245);
  s.line(710, 245, 150, 245);
  s.arrow(150, 245, 150, 180);
  s.text("probe ok", 430, 270, { anchor: "middle", size: 15 });
  s.text("open: requests fail instantly, the network is never touched", 430, 296, { anchor: "middle", size: 14, color: MUTED });
  return s.toSVG(motion.join(""), ".closed2, .open, .half { opacity: 0; }");
};

sketches["microservices/jitter"] = () => {
  const s = new Sketch(860, 320, "1000 clients retrying: without jitter all at 1600 ms, with full jitter spread across 0 to 1600 ms");
  // Deterministic random numbers so the drawing doesn't change between builds.
  let seed = 42;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const buckets = Array.from({ length: 16 }, () => 0);
  for (let i = 0; i < 1000; i++) buckets[Math.min(15, Math.floor((random() * 1600) / 100))]++;
  const unit = 200 / 1000; // px per request

  const panel = (left: number, title: string, bars: number[]) => {
    s.text(title, left, 35, { size: 18, color: MUTED });
    s.line(left, 270, left + 360, 270, { stroke: MUTED, strokeWidth: 1 });
    bars.forEach((count, i) => {
      if (count === 0) return;
      const h = Math.max(count * unit, 3);
      s.rect(left + i * 22, 270 - h, 18, h, { fill: FILL.blue, stroke: STROKE.blue, roughness: 0.7 });
    });
    s.text("0", left, 292, { size: 14, color: MUTED });
    s.text("1600 ms", left + 360, 292, { anchor: "end", size: 14, color: MUTED });
  };
  panel(30, "no jitter", [...Array(15).fill(0), 1000]);
  s.text("1000 at once", 30 + 15 * 22 + 9, 58, { anchor: "end", size: 17, color: STROKE.red });
  panel(470, "full jitter", buckets);
  s.text("the same 1000, spread out", 470 + 180, 200, { anchor: "middle", size: 17, color: STROKE.green });
  return s.toSVG();
};

// ---------------------------------------------------------------------------------------------

const only = process.argv[2];
for (const [name, draw] of Object.entries(sketches)) {
  if (only && !name.startsWith(only)) continue;
  const file = new URL(`${name}.svg`, OUT);
  mkdirSync(new URL(".", file), { recursive: true });
  const svg = draw();
  writeFileSync(file, svg);
  console.log(`${name}.svg  ${(svg.length / 1024).toFixed(1)} KB`);
}
