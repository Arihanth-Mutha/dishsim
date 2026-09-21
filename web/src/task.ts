// The closed-loop tracking task and the counterbalanced experiment runner.
//
// Every TICK_MS the encoder stimulates the sensory electrodes on the side the target
// is on; the decoder moves the cursor by the right-minus-left spike difference. The
// experiment interleaves the real loop with two controls in Latin-square order and
// produces the long-format table beatnull reads.

import { Dish, GRID, N_ELECTRODES } from "./dish";

export type Condition = "real" | "zero" | "random_matched" | "off";
export const CONDITIONS: Condition[] = ["real", "zero", "random_matched"];

export const TICK_MS = 50;
const ROWS = [2, 3, 4, 5];
export const LEFT_SENSORY = ROWS.map((r) => r * GRID + 1);
export const RIGHT_SENSORY = ROWS.map((r) => r * GRID + GRID - 2);
const HIT_RADIUS = 0.2;
const GAIN = 0.35;

/** Small deterministic PRNG (mulberry32) so experiment schedules are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Trial {
  hit: boolean;
  target: number;
  cursor: number;
  time: number;
}

export class Tracker {
  condition: Condition = "off";
  target = 0;
  cursor = 0;
  /** Recent trial outcomes for the live hit rate. */
  readonly recent: boolean[] = [];
  /** Target and cursor history (one point per tick) for the plot. */
  readonly history: { time: number; target: number; cursor: number; hit: boolean; condition: Condition }[] = [];
  onTrial: ((trial: Trial) => void) | null = null;
  onStimulus: ((now: number) => void) | null = null;
  /** Times (ms) of recent stimuli, for the dish view. */
  readonly stimulated = new Float64Array(N_ELECTRODES).fill(-1e9);

  private clock = 0;
  private left = 0;
  private right = 0;
  private pulses: { at: number; side: -1 | 1 }[] = [];
  private readonly random: () => number;
  private readonly phase: number;

  constructor(seed = Math.floor(Math.random() * 2 ** 32)) {
    this.random = rng(seed);
    this.phase = this.random() * Math.PI * 2;
  }

  targetAt(t: number): number {
    const p = this.phase;
    return 0.55 * Math.sin((2 * Math.PI * t) / 7000 + p) + 0.3 * Math.sin((2 * Math.PI * t) / 2900 + 2 * p);
  }

  resetCursor(): void {
    this.cursor = 0;
  }

  /** Call before each 1 ms simulation step. */
  beforeStep(dish: Dish, now: number): void {
    const offset = this.clock % TICK_MS;
    if (offset === 0) {
      this.left = 0;
      this.right = 0;
      this.target = this.targetAt(this.clock);
      this.pulses = this.plan();
    }
    for (const pulse of this.pulses) {
      if (pulse.at === offset) {
        for (const e of pulse.side < 0 ? LEFT_SENSORY : RIGHT_SENSORY) {
          dish.stimulate(e, 1);
          this.stimulated[e] = now;
        }
        this.onStimulus?.(now);
      }
    }
  }

  /** Call after each 1 ms step with that step's spike count per electrode. */
  afterStep(counts: Uint32Array, now: number): void {
    for (let e = 0; e < N_ELECTRODES; e++) {
      if (counts[e] === 0) continue;
      if (e % GRID < GRID / 2) this.left += counts[e];
      else this.right += counts[e];
    }
    this.clock++;
    if (this.clock % TICK_MS !== 0) return;
    if (this.condition !== "off") {
      const delta = (GAIN * (this.right - this.left)) / (this.right + this.left + 8);
      this.cursor = Math.max(-1, Math.min(1, 0.99 * this.cursor + delta));
    }
    const hit = Math.abs(this.target - this.cursor) < HIT_RADIUS;
    this.history.push({ time: now, target: this.target, cursor: this.cursor, hit, condition: this.condition });
    if (this.history.length > 400) this.history.shift();
    if (this.condition === "off") return;
    this.recent.push(hit);
    if (this.recent.length > 200) this.recent.shift();
    this.onTrial?.({ hit, target: this.target, cursor: this.cursor, time: now });
  }

  hitRate(): number {
    if (this.recent.length === 0) return NaN;
    return this.recent.filter(Boolean).length / this.recent.length;
  }

  private plan(): { at: number; side: -1 | 1 }[] {
    if (this.condition === "off" || this.condition === "zero") return [];
    const error = this.target - this.cursor;
    const n = Math.abs(error) < 0.1 ? 0 : Math.min(4, Math.ceil(Math.abs(error) / 0.15));
    const out: { at: number; side: -1 | 1 }[] = [];
    for (let k = 0; k < n; k++) {
      const side: -1 | 1 =
        this.condition === "real" ? (error < 0 ? -1 : 1) : this.random() < 0.5 ? -1 : 1;
      out.push({ at: k * 12, side });
    }
    return out;
  }
}

export interface Row {
  suite: string;
  block: string;
  position: number;
  condition: Condition;
  trial: number;
  hit: number;
}

const LATIN: Condition[][] = [
  ["real", "zero", "random_matched"],
  ["zero", "random_matched", "real"],
  ["random_matched", "real", "zero"],
];

export class Experiment {
  readonly rows: Row[] = [];
  private readonly schedule: { suite: string; block: string; position: number; condition: Condition }[] = [];
  private index = -1;
  private trial = 0;
  private resting = 0;
  done = false;

  constructor(
    private readonly tracker: Tracker,
    readonly suites = 3,
    readonly cycles = 3,
    readonly trialsPerBlock = 40,
    readonly restMs = 500,
    seed = Date.now(),
  ) {
    const random = rng(seed);
    for (let s = 1; s <= suites; s++) {
      let position = 0;
      for (let c = 0; c < cycles; c++) {
        for (const condition of LATIN[Math.floor(random() * LATIN.length)]) {
          const block = `s${s}-b${String(position + 1).padStart(2, "0")}`;
          this.schedule.push({ suite: `s${s}`, block, position, condition });
          position++;
        }
      }
    }
    tracker.onTrial = (t) => this.record(t);
    this.next();
  }

  get totalBlocks(): number {
    return this.schedule.length;
  }

  progress(): number {
    if (this.done) return 1;
    return (Math.max(0, this.index) + this.trial / this.trialsPerBlock) / this.schedule.length;
  }

  /** Call once per simulated ms, after the tracker. */
  tick(): void {
    if (this.done || this.resting <= 0) return;
    this.resting--;
    if (this.resting === 0) this.start();
  }

  private record(t: Trial): void {
    const current = this.schedule[this.index];
    if (this.done || this.resting > 0 || !current) return;
    this.rows.push({ ...current, trial: this.trial, hit: t.hit ? 1 : 0 });
    this.trial++;
    if (this.trial >= this.trialsPerBlock) this.next();
  }

  private next(): void {
    this.index++;
    this.trial = 0;
    this.tracker.condition = "off";
    if (this.index >= this.schedule.length) {
      this.done = true;
      this.tracker.onTrial = null;
      return;
    }
    this.resting = this.restMs;
  }

  private start(): void {
    this.tracker.resetCursor();
    this.tracker.condition = this.schedule[this.index].condition;
  }

  csv(): string {
    const lines = ["suite,block,position,condition,trial,hit"];
    for (const r of this.rows) lines.push(`${r.suite},${r.block},${r.position},${r.condition},${r.trial},${r.hit}`);
    return lines.join("\n") + "\n";
  }

  summary(): { condition: Condition; blocks: number; mean: number; sd: number }[] {
    return CONDITIONS.map((condition) => {
      const perBlock = new Map<string, number[]>();
      for (const r of this.rows) {
        if (r.condition !== condition) continue;
        const list = perBlock.get(r.block) ?? [];
        list.push(r.hit);
        perBlock.set(r.block, list);
      }
      const means = [...perBlock.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
      const mean = means.reduce((a, b) => a + b, 0) / Math.max(1, means.length);
      const sd = Math.sqrt(means.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, means.length - 1));
      return { condition, blocks: means.length, mean, sd };
    });
  }
}
