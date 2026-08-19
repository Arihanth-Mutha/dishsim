//! Network-level behaviour the demo relies on.

use dishsim_core::{Build, Sim, N_ELECTRODES};

fn per_ms(sim: &mut Sim, ms: u32) -> Vec<usize> {
    (0..ms).map(|_| sim.step(1)).collect()
}

/// Bursts: 10 ms bins in which more than 5% of neurons fire.
fn burst_stats(counts: &[usize], n: usize) -> (usize, f64) {
    let bins: Vec<usize> = counts.chunks(10).map(|c| c.iter().sum()).collect();
    let mut bursts = 0;
    let mut inside = 0;
    for (k, &b) in bins.iter().enumerate() {
        if b > n / 20 {
            inside += b;
            if k == 0 || bins[k - 1] <= n / 20 {
                bursts += 1;
            }
        }
    }
    (bursts, inside as f64 / counts.iter().sum::<usize>().max(1) as f64)
}

#[test]
fn spontaneous_network_bursts_dominate_activity() {
    let mut sim = Sim::new(&Build::default());
    let counts = per_ms(&mut sim, 8_000);
    let (bursts, fraction) = burst_stats(&counts, sim.n());
    assert!(bursts >= 3, "expected recurring network bursts, got {bursts}");
    assert!(fraction > 0.5, "most spikes should fall inside bursts, got {fraction:.2}");
}

#[test]
fn synaptic_depression_restrains_recurrent_excitation() {
    let mut with = Sim::new(&Build::default());
    let mut without = Sim::new(&Build::default());
    without.params.depression = false;
    let a: usize = per_ms(&mut with, 3_000).iter().sum();
    let b: usize = per_ms(&mut without, 3_000).iter().sum();
    // Without resource depletion, only spike-frequency adaptation reins bursts in.
    assert!(b > 2 * a, "without depression {b} spikes vs {a} with it");
}

#[test]
fn stdp_changes_weights_only_when_enabled() {
    let mut on = Sim::new(&Build::default());
    let mut off = Sim::new(&Build::default());
    off.params.stdp = false;
    let w0 = on.mean_plastic_weight();
    per_ms(&mut on, 2_000);
    per_ms(&mut off, 2_000);
    assert_ne!(on.mean_plastic_weight(), w0);
    assert_eq!(off.mean_plastic_weight(), w0);
    // Excitatory weights stay within [0, w_max]; inhibitory ones are not plastic.
    assert!(on.syn_w.iter().filter(|&&w| w >= 0.0).all(|&w| w <= on.params.w_max));
}

#[test]
fn stimulus_response_is_reliable_and_above_baseline() {
    let mut sim = Sim::new(&Build::default());
    per_ms(&mut sim, 500);
    let (mut evoked, mut baseline) = (0, 0);
    for k in 0..60 {
        let e = (k * 13) % N_ELECTRODES;
        sim.step(200);
        sim.step(10);
        baseline += (sim.electrode_counts[e] > 0) as u32;
        sim.step(200);
        sim.stimulate(e, 1.0);
        sim.step(10);
        evoked += (sim.electrode_counts[e] > 0) as u32;
    }
    assert!(evoked >= 50, "stimulated electrode responded {evoked}/60");
    assert!(baseline <= 15, "unstimulated window had activity {baseline}/60");
}

#[test]
fn wasm_interface_round_trip() {
    use dishsim_core::{buffer, dish_get, dish_init, dish_len, dish_ptr, dish_set, dish_step, param};
    dish_init(9, 256);
    assert_eq!(dish_len(buffer::POSITIONS), 2 * 256);
    assert_eq!(dish_len(buffer::ELECTRODE_COUNTS), N_ELECTRODES as u32);
    assert_ne!(dish_ptr(buffer::POSITIONS), 0);
    dish_set(param::NOISE, 4.5);
    assert_eq!(dish_get(param::NOISE), 4.5);
    dish_step(25);
    assert_eq!(dish_len(buffer::TRACE), 25 * 20);
    assert!(dish_get(99).is_nan());
}
