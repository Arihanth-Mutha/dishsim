// Canvas renderers. Each view owns its canvas, sizes it for the device pixel ratio,
// and draws from plain arrays so it never holds views into WebAssembly memory.

import { GRID, N_ELECTRODES, SAMPLES_PER_MS } from "./dish";
import type { Condition } from "./task";

const COLORS = {
  exc: "79, 209, 197",
  inh: "244, 114, 182",
  accent: "251, 191, 36",
  ink: "#e6edf3",
  muted: "#8b98a5",
  grid: "#16202a",
};

function fit(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number; dpr: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

export class DishView {
  hover = -1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly positions: Float32Array,
    private readonly kinds: Uint8Array,
    readonly electrodes: Float32Array,
  ) {}

  private scale(): number {
    return this.canvas.clientWidth;
  }

  /** Electrode under a point in CSS pixels, or -1. */
  electrodeAt(x: number, y: number): number {
    const s = this.scale();
    let best = -1;
    let bestD = 0.035 * s;
    for (let e = 0; e < N_ELECTRODES; e++) {
      const d = Math.hypot(this.electrodes[2 * e] * s - x, this.electrodes[2 * e + 1] * s - y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  draw(
    now: number,
    lastSpike: Uint32Array,
    electrodeRate: Float32Array,
    selected: number,
    stimulated: Float64Array,
    sensory: number[],
  ): void {
    const { ctx, w } = fit(this.canvas);
    const s = w;
    ctx.clearRect(0, 0, w, w);

    const dish = ctx.createRadialGradient(0.5 * s, 0.5 * s, 0, 0.5 * s, 0.5 * s, 0.49 * s);
    dish.addColorStop(0, "#0c1a20");
    dish.addColorStop(0.85, "#09131a");
    dish.addColorStop(1, "#0d2028");
    ctx.fillStyle = dish;
    ctx.beginPath();
    ctx.arc(0.5 * s, 0.5 * s, 0.49 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#1f3a44";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Electrode tracks and pads under the neurons.
    const pad = 0.022 * s;
    for (let e = 0; e < N_ELECTRODES; e++) {
      const x = this.electrodes[2 * e] * s;
      const y = this.electrodes[2 * e + 1] * s;
      const rate = Math.min(1, electrodeRate[e] / 40);
      ctx.fillStyle = `rgba(${COLORS.accent}, ${0.05 + 0.55 * rate})`;
      ctx.strokeStyle = e === this.hover ? "#e6edf3" : "#2b3d4a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(x - pad / 2, y - pad / 2, pad, pad);
      ctx.fill();
      ctx.stroke();
    }

    // Neurons: dim base dots, then glows for recent spikes.
    const n = this.kinds.length;
    const r = Math.max(1, 0.0028 * s);
    for (const kind of [0, 1]) {
      ctx.fillStyle = `rgba(${kind === 0 ? COLORS.exc : COLORS.inh}, 0.28)`;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (this.kinds[i] !== kind) continue;
        const x = this.positions[2 * i] * s;
        const y = this.positions[2 * i + 1] * s;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < n; i++) {
      const last = lastSpike[i];
      if (last === 0xffffffff) continue;
      const age = now - last;
      if (age > 90) continue;
      const a = Math.exp(-age / 22);
      const color = this.kinds[i] === 0 ? COLORS.exc : COLORS.inh;
      const x = this.positions[2 * i] * s;
      const y = this.positions[2 * i + 1] * s;
      ctx.fillStyle = `rgba(${color}, ${0.18 * a})`;
      ctx.beginPath();
      ctx.arc(x, y, r * 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * a})`;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";

    // Sensory electrodes used by the closed loop, the recorded electrode, stimuli.
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = `rgba(${COLORS.accent}, 0.7)`;
    for (const e of sensory) {
      const x = this.electrodes[2 * e] * s;
      const y = this.electrodes[2 * e + 1] * s;
      ctx.strokeRect(x - pad * 0.85, y - pad * 0.85, pad * 1.7, pad * 1.7);
    }
    ctx.setLineDash([]);
    {
      const x = this.electrodes[2 * selected] * s;
      const y = this.electrodes[2 * selected + 1] * s;
      ctx.strokeStyle = `rgb(${COLORS.exc})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, pad * 1.25, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let e = 0; e < N_ELECTRODES; e++) {
      const age = now - stimulated[e];
      if (age < 0 || age > 300) continue;
      const x = this.electrodes[2 * e] * s;
      const y = this.electrodes[2 * e + 1] * s;
      const k = age / 300;
      ctx.strokeStyle = `rgba(${COLORS.accent}, ${1 - k})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, pad * (0.8 + 3.2 * k), 0, Math.PI * 2);
      ctx.stroke();
    }

    // Scale bar: 0.25 dish units ~ 500 um.
    const bx = 0.07 * s;
    const by = 0.95 * s;
    ctx.strokeStyle = COLORS.muted;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + 0.25 * s, by);
    ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.font = "11px ui-monospace, Menlo, monospace";
    ctx.fillText("500 µm", bx, by - 6);
    if (this.hover >= 0) {
      const row = Math.floor(this.hover / GRID);
      const col = this.hover % GRID;
      ctx.fillStyle = COLORS.ink;
      ctx.fillText(`electrode ${this.hover} · row ${row} col ${col} · ${electrodeRate[this.hover].toFixed(1)} Hz`, 0.07 * s, 0.05 * s);
    }
  }
}

/** Last WINDOW_MS of electrode events and per-ms population counts. */
export class Activity {
  static readonly WINDOW_MS = 4000;
  private readonly times: number[] = [];
  private readonly electrodes: number[] = [];
  readonly perMs = new Float32Array(60_000);
  private readonly stimTimes: number[] = [];
  private readonly allStims: number[] = [];
  readonly electrodeRate = new Float32Array(N_ELECTRODES);
  private head = 0;

  push(now: number, fired: number, events: Uint32Array, counts: Uint32Array): void {
    for (let k = 0; k + 1 < events.length; k += 2) {
      this.times.push(now);
      this.electrodes.push(events[k + 1]);
    }
    this.perMs[this.head % this.perMs.length] = fired;
    this.head++;
    // Exponential moving average of each electrode's rate (Hz), tau = 500 ms.
    for (let e = 0; e < N_ELECTRODES; e++) {
      this.electrodeRate[e] += (counts[e] * 1000 - this.electrodeRate[e]) / 500;
    }
  }

  /** Record a stimulus; `shown` ones are drawn on the raster. */
  stim(now: number, shown = true): void {
    if (shown) this.stimTimes.push(now);
    this.allStims.push(now);
  }

  /** Whether `t` falls within `ms` after any stimulus. */
  nearStimulus(t: number, ms: number): boolean {
    for (let i = this.allStims.length - 1; i >= 0; i--) {
      const dt = t - this.allStims[i];
      if (dt >= 0 && dt <= ms) return true;
      if (dt > ms && this.allStims[i] < t - 1000) break;
    }
    return false;
  }

  prune(now: number): void {
    let drop = 0;
    while (drop < this.times.length && this.times[drop] < now - Activity.WINDOW_MS) drop++;
    if (drop) {
      this.times.splice(0, drop);
      this.electrodes.splice(0, drop);
    }
    while (this.stimTimes.length && this.stimTimes[0] < now - Activity.WINDOW_MS) this.stimTimes.shift();
    while (this.allStims.length && this.allStims[0] < now - Activity.WINDOW_MS) this.allStims.shift();
  }

  /** Fired counts for the last `ms` milliseconds, oldest first. */
  recent(ms: number): Float32Array {
    const out = new Float32Array(Math.min(ms, this.head, this.perMs.length));
    for (let i = 0; i < out.length; i++) out[i] = this.perMs[(this.head - out.length + i) % this.perMs.length];
    return out;
  }

  get events(): { times: number[]; electrodes: number[]; stims: number[] } {
    return { times: this.times, electrodes: this.electrodes, stims: this.stimTimes };
  }
}

export function drawRaster(canvas: HTMLCanvasElement, now: number, activity: Activity): void {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const span = Activity.WINDOW_MS;
  const rowH = (h - 8) / N_ELECTRODES;
  ctx.fillStyle = COLORS.grid;
  for (let row = 0; row <= GRID; row++) ctx.fillRect(0, 4 + row * GRID * rowH, w, 1);
  const { times, electrodes, stims } = activity.events;
  ctx.fillStyle = `rgba(${COLORS.accent}, 0.5)`;
  for (const t of stims) ctx.fillRect(w - ((now - t) / span) * w, 0, 1, h);
  ctx.fillStyle = `rgb(${COLORS.exc})`;
  for (let i = 0; i < times.length; i++) {
    const x = w - ((now - times[i]) / span) * w;
    ctx.fillRect(x, 4 + electrodes[i] * rowH, 1.2, Math.max(1, rowH - 0.5));
  }
  ctx.fillStyle = COLORS.muted;
  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.fillText("4 s", 4, h - 4);
  ctx.fillText("now", w - 24, h - 4);
}

/** Draws the population rate and returns the number of spontaneous bursts in view
 * (threshold crossings more than 40 ms after any stimulus). */
export function drawRate(canvas: HTMLCanvasElement, activity: Activity, n: number, now: number): number {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const counts = activity.recent(Activity.WINDOW_MS);
  const bin = 10;
  const bins = Math.floor(counts.length / bin);
  const values = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    let sum = 0;
    for (let k = 0; k < bin; k++) sum += counts[b * bin + k];
    values[b] = sum;
  }
  const threshold = n / 20; // a burst: >5% of neurons fire within 10 ms
  const top = Math.max(threshold * 4, ...values);
  const total = Activity.WINDOW_MS / bin;
  const x = (b: number) => w - ((bins - b) / total) * w;
  const y = (v: number) => h - 4 - (v / top) * (h - 10);
  ctx.beginPath();
  ctx.moveTo(x(0), h);
  for (let b = 0; b < bins; b++) ctx.lineTo(x(b), y(values[b]));
  ctx.lineTo(x(bins), h);
  ctx.closePath();
  ctx.fillStyle = `rgba(${COLORS.exc}, 0.25)`;
  ctx.fill();
  ctx.strokeStyle = `rgb(${COLORS.exc})`;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = `rgba(${COLORS.accent}, 0.6)`;
  ctx.beginPath();
  ctx.moveTo(0, y(threshold));
  ctx.lineTo(w, y(threshold));
  ctx.stroke();
  ctx.setLineDash([]);
  let bursts = 0;
  for (let b = 1; b < bins; b++) {
    const t = now - (bins - b) * bin;
    if (values[b] > threshold && values[b - 1] <= threshold && !activity.nearStimulus(t, 40)) bursts++;
  }
  return bursts;
}

export class Scope {
  static readonly WINDOW_MS = 120;
  private readonly buffer = new Float32Array(Scope.WINDOW_MS * SAMPLES_PER_MS);
  private head = 0;

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.head % this.buffer.length] = samples[i];
      this.head++;
    }
  }

  clear(): void {
    this.buffer.fill(0);
    this.head = 0;
  }

  draw(canvas: HTMLCanvasElement): void {
    const { ctx, w, h } = fit(canvas);
    ctx.clearRect(0, 0, w, h);
    const len = this.buffer.length;
    const ordered = new Float32Array(len);
    for (let i = 0; i < len; i++) ordered[i] = this.buffer[(this.head + i) % len];
    const abs = Float32Array.from(ordered, Math.abs).sort();
    const sigma = abs[Math.floor(len / 2)] / 0.6745;
    const threshold = -4.5 * sigma;
    const range = 160;
    const y = (v: number) => h / 2 - (Math.max(-range, Math.min(range, v)) / range) * (h / 2 - 6);

    ctx.fillStyle = COLORS.grid;
    ctx.fillRect(0, h / 2, w, 1);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = `rgba(${COLORS.accent}, 0.7)`;
    ctx.beginPath();
    ctx.moveTo(0, y(threshold));
    ctx.lineTo(w, y(threshold));
    ctx.stroke();
    ctx.setLineDash([]);

    const perPx = len / w;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let px = 0; px < w; px++) {
      let lo = Infinity;
      let hi = -Infinity;
      const start = Math.floor(px * perPx);
      const end = Math.min(len, Math.floor((px + 1) * perPx) + 1);
      for (let i = start; i < end; i++) {
        lo = Math.min(lo, ordered[i]);
        hi = Math.max(hi, ordered[i]);
      }
      ctx.moveTo(px + 0.5, y(hi));
      ctx.lineTo(px + 0.5, y(lo) + 0.5);
    }
    ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.fillText(`±${range} µV · ${Scope.WINDOW_MS} ms`, 4, 12);
    if (sigma > 0) {
      ctx.fillStyle = `rgb(${COLORS.accent})`;
      ctx.fillText(`−4.5σ = ${threshold.toFixed(0)} µV`, w - 110, y(threshold) - 4);
    }
  }
}

const CONDITION_COLOR: Record<Condition, string> = {
  real: `rgb(${COLORS.exc})`,
  zero: "#8b98a5",
  random_matched: `rgb(${COLORS.inh})`,
  off: "#3a4652",
};

export function drawTask(
  canvas: HTMLCanvasElement,
  now: number,
  history: { time: number; target: number; cursor: number; hit: boolean; condition: Condition }[],
): void {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const span = 8000;
  const x = (t: number) => w - ((now - t) / span) * w;
  const y = (v: number) => h / 2 - v * (h / 2 - 8);
  ctx.fillStyle = COLORS.grid;
  ctx.fillRect(0, h / 2, w, 1);
  const visible = history.filter((p) => now - p.time <= span);
  for (const p of visible) {
    ctx.fillStyle = p.condition === "off" ? "transparent" : p.hit ? "rgba(52, 211, 153, 0.12)" : "rgba(248, 113, 113, 0.08)";
    ctx.fillRect(x(p.time) - (w * 50) / span, 0, (w * 50) / span + 0.5, h);
  }
  const line = (key: "target" | "cursor", color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    visible.forEach((p, i) => (i ? ctx.lineTo(x(p.time), y(p[key])) : ctx.moveTo(x(p.time), y(p[key]))));
    ctx.stroke();
  };
  line("target", `rgb(${COLORS.accent})`, 2);
  for (let i = 1; i < visible.length; i++) {
    ctx.strokeStyle = CONDITION_COLOR[visible[i].condition];
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x(visible[i - 1].time), y(visible[i - 1].cursor));
    ctx.lineTo(x(visible[i].time), y(visible[i].cursor));
    ctx.stroke();
  }
  ctx.font = "11px ui-monospace, Menlo, monospace";
  ctx.fillStyle = `rgb(${COLORS.accent})`;
  ctx.fillText("target", 6, 14);
  ctx.fillStyle = COLORS.ink;
  ctx.fillText("cursor (colour = condition)", 64, 14);
}
