// Thin typed wrapper over the WebAssembly exports in core/src/lib.rs.
// Views into linear memory are created on every access because memory can grow.

export const GRID = 8;
export const N_ELECTRODES = 64;
export const SAMPLES_PER_MS = 20;

export const Param = {
  noise: 0,
  stdp: 1,
  depression: 2,
  stimCurrent: 3,
  meanWeight: 4,
  meanResource: 5,
  selected: 6,
  synapses: 7,
} as const;

const Buffer = {
  positions: 0,
  kinds: 1,
  lastSpike: 2,
  events: 3,
  electrodeCounts: 4,
  electrodePositions: 5,
  trace: 6,
  voltage: 7,
  fired: 8,
} as const;

interface Exports {
  memory: WebAssembly.Memory;
  dish_init(seed: number, n: number): void;
  dish_step(ms: number): number;
  dish_stimulate(electrode: number, amplitude: number): void;
  dish_set(id: number, value: number): void;
  dish_get(id: number): number;
  dish_n(): number;
  dish_time(): number;
  dish_ptr(id: number): number;
  dish_len(id: number): number;
}

export class Dish {
  private constructor(private readonly ex: Exports) {}

  static async load(url: string): Promise<Dish> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not fetch ${url}: ${response.status}`);
    return Dish.fromBytes(await response.arrayBuffer());
  }

  static async fromBytes(bytes: BufferSource): Promise<Dish> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Dish(instance.exports as unknown as Exports);
  }

  init(seed: number, n = 1024): void {
    this.ex.dish_init(seed >>> 0, n);
  }

  /** Advance `ms` milliseconds; returns how many neurons fired. */
  step(ms: number): number {
    return this.ex.dish_step(ms);
  }

  stimulate(electrode: number, amplitude = 1): void {
    this.ex.dish_stimulate(electrode, amplitude);
  }

  set(id: number, value: number): void {
    this.ex.dish_set(id, value);
  }

  get(id: number): number {
    return this.ex.dish_get(id);
  }

  get n(): number {
    return this.ex.dish_n();
  }

  get time(): number {
    return this.ex.dish_time();
  }

  private view<T>(id: number, make: (buf: ArrayBuffer, ptr: number, len: number) => T): T {
    return make(this.ex.memory.buffer, this.ex.dish_ptr(id), this.ex.dish_len(id));
  }

  positions(): Float32Array {
    return this.view(Buffer.positions, (b, p, n) => new Float32Array(b, p, n));
  }
  kinds(): Uint8Array {
    return this.view(Buffer.kinds, (b, p, n) => new Uint8Array(b, p, n));
  }
  lastSpike(): Uint32Array {
    return this.view(Buffer.lastSpike, (b, p, n) => new Uint32Array(b, p, n));
  }
  /** (ms offset, electrode) pairs for the last step call. */
  events(): Uint32Array {
    return this.view(Buffer.events, (b, p, n) => new Uint32Array(b, p, n));
  }
  electrodeCounts(): Uint32Array {
    return this.view(Buffer.electrodeCounts, (b, p, n) => new Uint32Array(b, p, n));
  }
  electrodePositions(): Float32Array {
    return this.view(Buffer.electrodePositions, (b, p, n) => new Float32Array(b, p, n));
  }
  trace(): Float32Array {
    return this.view(Buffer.trace, (b, p, n) => new Float32Array(b, p, n));
  }
}
