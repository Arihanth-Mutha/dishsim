// Run the counterbalanced closed-loop experiment headless and print the beatnull CSV.
//
//   npm run experiment -- [seed] > dishsim-experiment.csv
//   beatnull check dishsim-experiment.csv --metric hit --group suite --report report.html

import { readFileSync } from "node:fs";

import { Dish } from "../src/dish";
import { Experiment, Tracker } from "../src/task";

const seed = Number(process.argv[2] ?? 1);
const wasm = readFileSync("public/dishsim.wasm"); // npm runs scripts from web/
const dish = await Dish.fromBytes(wasm);
dish.init(seed);
for (let i = 0; i < 300; i++) dish.step(1);

const tracker = new Tracker(seed);
const experiment = new Experiment(tracker, 3, 3, 40, 500, seed);
const started = performance.now();
while (!experiment.done) {
  const now = dish.time;
  tracker.beforeStep(dish, now);
  dish.step(1);
  tracker.afterStep(dish.electrodeCounts(), now);
  experiment.tick();
}
process.stdout.write(experiment.csv());
const seconds = dish.time / 1000;
console.error(`seed ${seed}: ${experiment.rows.length} trials, ${seconds.toFixed(1)} s simulated in ${((performance.now() - started) / 1000).toFixed(2)} s`);
for (const s of experiment.summary()) {
  console.error(`  ${s.condition.padEnd(15)} ${(100 * s.mean).toFixed(1).padStart(5)}% hit rate (sd ${(100 * s.sd).toFixed(1)}%, ${s.blocks} blocks)`);
}
