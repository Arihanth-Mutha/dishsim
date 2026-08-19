//! Network statistics for a few seconds of simulated time: firing rate, network
//! bursts, stimulus response and simulation speed.
//!
//! cargo run --release --example stats [seconds] [noise] [w_exc] [w_inh]

use std::time::Instant;

use dishsim_core::{Build, Sim, N_ELECTRODES};

fn main() {
    let args: Vec<f32> = std::env::args().skip(1).filter_map(|a| a.parse().ok()).collect();
    let seconds = args.first().copied().unwrap_or(20.0) as u32;
    let mut build = Build::default();
    if let Some(&w) = args.get(2) {
        build.w_exc = w;
    }
    if let Some(&w) = args.get(3) {
        build.w_inh = w;
    }
    let mut sim = Sim::new(&build);
    if let Some(&noise) = args.get(1) {
        sim.params.noise = noise;
    }
    let n = sim.n();

    let started = Instant::now();
    let mut per_ms = Vec::with_capacity(seconds as usize * 1000);
    for _ in 0..seconds * 1000 {
        per_ms.push(sim.step(1));
    }
    let elapsed = started.elapsed().as_secs_f64();

    // Population rate in 10 ms bins; a burst is a bin where >5% of neurons fire,
    // counted once per contiguous run.
    let bins: Vec<usize> = per_ms.chunks(10).map(|c| c.iter().sum()).collect();
    let threshold = n / 20;
    let mut bursts = 0;
    let mut in_burst = false;
    let mut burst_spikes = 0usize;
    for &b in &bins {
        if b > threshold {
            if !in_burst {
                bursts += 1;
            }
            burst_spikes += b;
            in_burst = true;
        } else {
            in_burst = false;
        }
    }
    let total: usize = per_ms.iter().sum();
    println!(
        "neurons {n}, synapses {}, {} s simulated in {:.2} s ({:.0}x real time)",
        sim.n_synapses(),
        seconds,
        elapsed,
        seconds as f64 / elapsed
    );
    println!(
        "mean rate {:.2} Hz, network bursts {} ({:.2}/s), fraction of spikes in bursts {:.0}%",
        total as f64 / n as f64 / seconds as f64,
        bursts,
        bursts as f64 / seconds as f64,
        100.0 * burst_spikes as f64 / total.max(1) as f64
    );
    println!(
        "mean plastic weight {:.3}, mean resource {:.3}",
        sim.mean_plastic_weight(),
        sim.mean_resource()
    );

    // Stimulus response: probability that the stimulated electrode records a spike
    // within 10 ms, versus the same window with no stimulus.
    let (mut hits, mut base) = (0, 0);
    let trials = 100;
    for k in 0..trials {
        let e = (k * 13) % N_ELECTRODES;
        sim.step(150);
        sim.step(1);
        sim.step(10);
        base += (sim.electrode_counts[e] > 0) as u32;
        sim.step(150);
        sim.stimulate(e, 1.0);
        sim.step(10);
        hits += (sim.electrode_counts[e] > 0) as u32;
    }
    println!("electrode responds within 10 ms: {hits}/{trials} after a stimulus, {base}/{trials} without");
}
