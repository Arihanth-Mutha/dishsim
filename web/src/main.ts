import { Dish, Param } from "./dish";
import { Experiment, LEFT_SENSORY, RIGHT_SENSORY, Tracker, type Condition } from "./task";
import { Activity, DishView, drawRaster, drawRate, drawTask, Scope } from "./views";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const FRAME_BUDGET_MS = 12;
const SENSORY = [...LEFT_SENSORY, ...RIGHT_SENSORY];

async function main(): Promise<void> {
  const dish = await Dish.load(new URL("dishsim.wasm", document.baseURI).href);
  let seed = 1;
  let view: DishView;
  let activity: Activity;
  let scope: Scope;
  let tracker: Tracker;
  let experiment: Experiment | null = null;
  let running = true;
  let speed = 1;
  let carry = 0;
  let clickMode: "stim" | "rec" = "stim";
  let burstHistory: number[] = [];
  let achieved = 0;

  const reset = () => {
    dish.init(seed);
    dish.set(Param.noise, Number($<HTMLInputElement>("noise").value));
    dish.set(Param.stdp, $<HTMLInputElement>("stdp").checked ? 1 : 0);
    dish.set(Param.depression, $<HTMLInputElement>("depression").checked ? 1 : 0);
    view = new DishView($("dish"), dish.positions().slice(), dish.kinds().slice(), dish.electrodePositions().slice());
    activity = new Activity();
    scope = new Scope();
    const condition = tracker?.condition ?? "off";
    tracker = new Tracker();
    tracker.condition = experiment ? "off" : condition;
    tracker.onStimulus = (t) => activity.stim(t, false);
    burstHistory = [];
    // Let the culture settle past its start-up transient, then fill the raster window
    // so the page opens on live-looking activity (about 0.1 s of compute).
    for (let i = 0; i < 300; i++) dish.step(1);
    if (!experiment) for (let i = 0; i < Activity.WINDOW_MS; i++) stepOne();
  };

  const stepOne = () => {
    const now = dish.time;
    tracker.beforeStep(dish, now);
    const fired = dish.step(1);
    const counts = dish.electrodeCounts();
    activity.push(now, fired, dish.events(), counts);
    scope.push(dish.trace());
    tracker.afterStep(counts, now);
    experiment?.tick();
  };
  reset();

  const stimulate = (electrodes: number[]) => {
    for (const e of electrodes) {
      dish.stimulate(e, 1);
      tracker.stimulated[e] = dish.time;
    }
    activity.stim(dish.time);
  };

  // Dish interaction.
  const canvas = $<HTMLCanvasElement>("dish");
  canvas.addEventListener("mousemove", (ev) => {
    const r = canvas.getBoundingClientRect();
    view.hover = view.electrodeAt(ev.clientX - r.left, ev.clientY - r.top);
  });
  canvas.addEventListener("mouseleave", () => (view.hover = -1));
  canvas.addEventListener("click", (ev) => {
    const r = canvas.getBoundingClientRect();
    const e = view.electrodeAt(ev.clientX - r.left, ev.clientY - r.top);
    if (e < 0) return;
    if (clickMode === "stim") stimulate([e]);
    else {
      dish.set(Param.selected, e);
      scope.clear();
    }
  });
  const setMode = (mode: "stim" | "rec") => {
    clickMode = mode;
    for (const [id, m] of [["mode-stim", "stim"], ["mode-rec", "rec"]] as const) {
      $(id).classList.toggle("on", m === mode);
      $(id).setAttribute("aria-pressed", String(m === mode));
    }
    $("hint").textContent =
      mode === "stim"
        ? "Click an electrode to stimulate it. Neurons flash when they fire; electrodes glow with their recent firing rate."
        : "Click an electrode to show its voltage on the scope (ringed in teal).";
  };
  $("mode-stim").addEventListener("click", () => setMode("stim"));
  $("mode-rec").addEventListener("click", () => setMode("rec"));

  // Controls.
  $("play").addEventListener("click", () => {
    running = !running;
    $("play").textContent = running ? "Pause" : "Play";
  });
  const speedInput = $<HTMLInputElement>("speed");
  const applySpeed = () => {
    speed = 2 ** Number(speedInput.value);
    $("speed-out").textContent = speed < 1 ? `1/${1 / speed}×` : `${speed}×`;
  };
  speedInput.addEventListener("input", applySpeed);
  applySpeed();
  const noise = $<HTMLInputElement>("noise");
  noise.addEventListener("input", () => {
    dish.set(Param.noise, Number(noise.value));
    $("noise-out").textContent = Number(noise.value).toFixed(1);
  });
  $<HTMLInputElement>("stdp").addEventListener("change", (ev) =>
    dish.set(Param.stdp, (ev.target as HTMLInputElement).checked ? 1 : 0),
  );
  $<HTMLInputElement>("depression").addEventListener("change", (ev) =>
    dish.set(Param.depression, (ev.target as HTMLInputElement).checked ? 1 : 0),
  );
  $("burst").addEventListener("click", () => stimulate([27, 28, 35, 36]));
  $("reset").addEventListener("click", () => {
    if (experiment && !experiment.done) return;
    seed += 1;
    reset();
  });

  // Closed-loop condition buttons.
  const condButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-cond]"));
  const showCondition = (c: Condition) => {
    for (const b of condButtons) {
      b.classList.toggle("on", b.dataset.cond === c);
      b.setAttribute("aria-pressed", String(b.dataset.cond === c));
    }
  };
  for (const b of condButtons) {
    b.addEventListener("click", () => {
      if (experiment && !experiment.done) return;
      tracker.condition = b.dataset.cond as Condition;
      tracker.recent.length = 0;
      showCondition(tracker.condition);
    });
  }

  // Counterbalanced experiment.
  $("run").addEventListener("click", () => {
    if (experiment && !experiment.done) return;
    seed += 1;
    experiment = null;
    reset();
    experiment = new Experiment(tracker);
    $<HTMLButtonElement>("run").disabled = true;
    (document.querySelector(".progress") as HTMLElement).hidden = false;
    $("results").hidden = true;
  });
  $("download").addEventListener("click", () => {
    if (!experiment) return;
    const blob = new Blob([experiment.csv()], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dishsim-experiment.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const finishExperiment = (exp: Experiment) => {
    $<HTMLButtonElement>("run").disabled = false;
    (document.querySelector(".progress") as HTMLElement).hidden = true;
    const rows = exp
      .summary()
      .map(
        (s) =>
          `<tr><td>${s.condition}</td><td>${s.blocks}</td><td>${(100 * s.mean).toFixed(1)}%</td><td>${(100 * s.sd).toFixed(1)}%</td></tr>`,
      )
      .join("");
    $("results-table").innerHTML =
      `<tr><th>condition</th><th>blocks</th><th>mean hit rate</th><th>sd across blocks</th></tr>${rows}`;
    $("results").hidden = false;
    tracker.condition = "off";
    showCondition("off");
    setMode(clickMode);
  };

  // Main loop.
  let last = performance.now();
  let statsAt = -Infinity;
  const frame = (t: number) => {
    const dt = Math.min(50, t - last);
    last = t;
    const start = performance.now();
    let stepped = 0;
    if (running) {
      const busy = experiment !== null && !experiment.done;
      carry += busy ? 1e9 : dt * speed;
      while (carry >= 1 && performance.now() - start < FRAME_BUDGET_MS) {
        stepOne();
        carry -= 1;
        stepped++;
        if (experiment?.done && busy) break;
      }
      if (carry > 1) carry = busy ? 0 : Math.min(carry, 1);
    }
    achieved = 0.9 * achieved + 0.1 * (dt > 0 ? stepped / dt : 0);

    const now = dish.time;
    activity.prune(now);
    const sensory = tracker.condition === "off" ? [] : SENSORY;
    view.draw(now, dish.lastSpike(), activity.electrodeRate, dish.get(Param.selected), tracker.stimulated, sensory);
    drawRaster($("raster"), now, activity);
    const bursts = drawRate($("rate"), activity, dish.n, now);
    scope.draw($("scope"));
    drawTask($("task"), now, tracker.history);

    if (experiment) {
      $("progress-bar").style.width = `${(100 * experiment.progress()).toFixed(1)}%`;
      if (experiment.done && $<HTMLButtonElement>("run").disabled) finishExperiment(experiment);
    }

    if (t - statsAt > 250) {
      statsAt = t;
      const recent = activity.recent(10_000);
      const spikes = recent.reduce((a, b) => a + b, 0);
      burstHistory.push(bursts);
      if (burstHistory.length > 60) burstHistory.shift();
      $("s-time").textContent = `${(now / 1000).toFixed(1)} s`;
      $("s-rate").textContent = recent.length ? `${(spikes / dish.n / (recent.length / 1000)).toFixed(1)} Hz` : "–";
      $("s-bursts").textContent = `${(bursts * 15).toFixed(0)}`;
      $("s-weight").textContent = dish.get(Param.meanWeight).toFixed(2);
      $("s-resource").textContent = `${(100 * dish.get(Param.meanResource)).toFixed(0)}%`;
      $("s-speed").textContent = achieved > 0.05 ? `${achieved.toFixed(1)}×` : "–";
      const rate = tracker.hitRate();
      $("hit-rate").textContent = Number.isNaN(rate) ? "–" : `${(100 * rate).toFixed(0)}%`;
      $("hit-rate").style.color =
        tracker.condition === "real" ? "var(--exc)" : tracker.condition === "random_matched" ? "var(--inh)" : "var(--ink)";
      const sel = dish.get(Param.selected);
      $("scope-label").textContent = `electrode ${sel} (row ${Math.floor(sel / 8)}, col ${sel % 8}) · synthetic 20 kHz`;
      $("burst-label").textContent = `spikes per 10 ms · dashed: burst threshold (5% of neurons)`;
      if (experiment && !experiment.done) {
        $("hint").textContent = `Running experiment: block ${Math.min(experiment.totalBlocks, Math.floor(experiment.progress() * experiment.totalBlocks) + 1)} of ${experiment.totalBlocks}, condition ${tracker.condition}.`;
        showCondition(tracker.condition);
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err) => {
  const box = $("fatal");
  box.hidden = false;
  box.textContent = `dishsim failed to start: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
