//! The culture: Izhikevich neurons on a dish, wired by distance, with conduction
//! delays, short-term synaptic depression, spike-timing-dependent plasticity, and a
//! 64-electrode array that records and stimulates.
//!
//! Units: time in ms (one step = 1 ms), membrane potential in mV, space in dish
//! units (the dish is a disc of radius 0.48 centred on (0.5, 0.5); 1 unit ~ 2 mm).
//!
//! This is a toy network built to behave like a cultured network at a glance
//! (spontaneous network bursts, local responses to stimulation, slow plastic change).
//! It is not fitted to any culture, organoid or device.

use crate::rng::Rng;

pub const GRID: usize = 8;
pub const N_ELECTRODES: usize = GRID * GRID;
/// Scope samples generated per 1 ms step (20 kHz).
pub const SAMPLES_PER_MS: usize = 20;

const MAX_DELAY: usize = 8;
const RING: usize = MAX_DELAY + 1;
const DISH_RADIUS: f32 = 0.48;
const ELECTRODE_SPAN: (f32, f32) = (0.2, 0.8);
const RECORD_RADIUS: f32 = 0.032;
const STIM_RADIUS: f32 = 0.075;
const TRACE_DECAY: f32 = 0.951_229_4; // exp(-1 / 20 ms)
const WAVEFORM_SAMPLES: usize = 40;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Excitatory = 0,
    Inhibitory = 1,
}

/// Live-tunable parameters.
#[derive(Clone, Debug)]
pub struct Params {
    /// Standard deviation of background input current to excitatory neurons.
    pub noise: f32,
    pub stdp: bool,
    pub depression: bool,
    /// Peak current injected by a stimulus into neurons at the electrode centre.
    pub stim_current: f32,
    pub a_plus: f32,
    pub a_minus: f32,
    pub w_max: f32,
    /// Recovery time constant of synaptic resources (ms).
    pub tau_recovery: f32,
    /// Fraction of available resources used by one spike.
    pub release: f32,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            noise: 3.0,
            stdp: true,
            depression: true,
            stim_current: 40.0,
            a_plus: 0.10,
            a_minus: 0.12,
            w_max: 10.0,
            tau_recovery: 1500.0,
            release: 0.25,
        }
    }
}

/// Construction-time settings.
#[derive(Clone, Debug)]
pub struct Build {
    pub n: usize,
    pub seed: u64,
    pub excitatory_fraction: f32,
    pub synapses_per_neuron: usize,
    /// Length scale of the distance-dependent connection probability.
    pub wiring_length: f32,
    pub w_exc: f32,
    pub w_inh: f32,
}

impl Default for Build {
    fn default() -> Self {
        Self {
            n: 1024,
            seed: 1,
            excitatory_fraction: 0.8,
            synapses_per_neuron: 80,
            wiring_length: 0.12,
            w_exc: 6.0,
            w_inh: -7.0,
        }
    }
}

pub struct Sim {
    pub params: Params,
    rng: Rng,
    n: usize,
    pub pos: Vec<f32>,
    pub kind: Vec<u8>,
    a: Vec<f32>,
    b: Vec<f32>,
    c: Vec<f32>,
    d: Vec<f32>,
    pub v: Vec<f32>,
    u: Vec<f32>,
    syn_start: Vec<u32>,
    syn_post: Vec<u32>,
    pub syn_w: Vec<f32>,
    syn_delay: Vec<u8>,
    plastic: Vec<bool>,
    in_start: Vec<u32>,
    in_syn: Vec<u32>,
    syn_pre: Vec<u32>,
    ring: Vec<f32>,
    pre_trace: Vec<f32>,
    post_trace: Vec<f32>,
    pub resource: Vec<f32>,
    pub last_spike: Vec<u32>,
    stim_input: Vec<f32>,
    t: u32,
    pub electrode_pos: Vec<f32>,
    neuron_electrode: Vec<i16>,
    neuron_gain: Vec<f32>,
    stim_targets: Vec<Vec<(u32, f32)>>,
    /// `(ms offset within the last call, electrode)` for every recorded spike.
    pub events: Vec<u32>,
    /// Spikes per electrode during the last call.
    pub electrode_counts: Vec<u32>,
    /// Every neuron that fired during the last call (indices, in order).
    pub fired: Vec<u32>,
    selected: usize,
    /// Scope samples (microvolts) for the selected electrode during the last call.
    pub trace: Vec<f32>,
    carry: Vec<f32>,
    pending_artifact: f32,
    waveform: Vec<f32>,
}

fn waveform() -> Vec<f32> {
    (0..WAVEFORM_SAMPLES)
        .map(|i| {
            let t = (i as f32 - 6.0) / SAMPLES_PER_MS as f32; // ms, trough at sample 6
            let trough = (-(t / 0.15).powi(2) / 2.0).exp();
            let rebound = 0.35 * (-((t - 0.45) / 0.25).powi(2) / 2.0).exp();
            rebound - trough
        })
        .collect()
}

impl Sim {
    pub fn new(build: &Build) -> Self {
        let n = build.n.max(16);
        let mut rng = Rng::new(build.seed);
        let n_exc = ((n as f32) * build.excitatory_fraction).round() as usize;

        let mut pos = Vec::with_capacity(2 * n);
        for _ in 0..n {
            let r = DISH_RADIUS * (rng.uniform() as f32).sqrt();
            let th = std::f32::consts::TAU * rng.uniform() as f32;
            pos.push(0.5 + r * th.cos());
            pos.push(0.5 + r * th.sin());
        }

        let (mut a, mut b, mut c, mut d) = (vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        let mut kind = vec![0u8; n];
        for i in 0..n {
            let r = rng.uniform() as f32;
            if i < n_exc {
                // Regular spiking, shading into chattering (Izhikevich 2003).
                (a[i], b[i], c[i], d[i]) = (0.02, 0.2, -65.0 + 15.0 * r * r, 8.0 - 6.0 * r * r);
            } else {
                kind[i] = Kind::Inhibitory as u8;
                (a[i], b[i], c[i], d[i]) = (0.02 + 0.08 * r, 0.25 - 0.05 * r, -65.0, 2.0);
            }
        }
        let v = vec![-65.0f32; n];
        let u: Vec<f32> = (0..n).map(|i| b[i] * -65.0).collect();

        let dist = |p: &[f32], i: usize, j: usize| {
            let (dx, dy) = (p[2 * i] - p[2 * j], p[2 * i + 1] - p[2 * j + 1]);
            (dx * dx + dy * dy).sqrt()
        };
        let mut syn_start = Vec::with_capacity(n + 1);
        let (mut syn_post, mut syn_w, mut syn_delay, mut plastic) = (vec![], vec![], vec![], vec![]);
        let mut syn_pre = vec![];
        for i in 0..n {
            syn_start.push(syn_post.len() as u32);
            let mut made = 0;
            let mut tries = 0;
            while made < build.synapses_per_neuron && tries < 400 * build.synapses_per_neuron {
                tries += 1;
                let j = (rng.next_u64() % n as u64) as usize;
                if j == i {
                    continue;
                }
                let dij = dist(&pos, i, j);
                if rng.uniform() as f32 > (-dij / build.wiring_length).exp() {
                    continue;
                }
                let exc = i < n_exc;
                let jitter = 0.5 + rng.uniform() as f32;
                syn_post.push(j as u32);
                syn_pre.push(i as u32);
                syn_w.push(if exc { build.w_exc * jitter } else { build.w_inh * jitter });
                syn_delay.push((1 + (dij / 0.07) as usize).min(MAX_DELAY) as u8);
                plastic.push(exc && j < n_exc);
                made += 1;
            }
        }
        syn_start.push(syn_post.len() as u32);

        // Incoming plastic synapses per postsynaptic neuron (for potentiation).
        let mut counts = vec![0u32; n + 1];
        for (s, &post) in syn_post.iter().enumerate() {
            if plastic[s] {
                counts[post as usize + 1] += 1;
            }
        }
        for i in 0..n {
            counts[i + 1] += counts[i];
        }
        let in_start = counts.clone();
        let mut fill = counts;
        let mut in_syn = vec![0u32; *in_start.last().unwrap() as usize];
        for (s, &post) in syn_post.iter().enumerate() {
            if plastic[s] {
                in_syn[fill[post as usize] as usize] = s as u32;
                fill[post as usize] += 1;
            }
        }

        let (lo, hi) = ELECTRODE_SPAN;
        let step = (hi - lo) / (GRID - 1) as f32;
        let mut electrode_pos = Vec::with_capacity(2 * N_ELECTRODES);
        for row in 0..GRID {
            for col in 0..GRID {
                electrode_pos.push(lo + col as f32 * step);
                electrode_pos.push(lo + row as f32 * step);
            }
        }
        let mut neuron_electrode = vec![-1i16; n];
        let mut neuron_gain = vec![0.0f32; n];
        let mut stim_targets = vec![Vec::new(); N_ELECTRODES];
        for i in 0..n {
            for e in 0..N_ELECTRODES {
                let (dx, dy) = (pos[2 * i] - electrode_pos[2 * e], pos[2 * i + 1] - electrode_pos[2 * e + 1]);
                let de = (dx * dx + dy * dy).sqrt();
                if de < RECORD_RADIUS {
                    neuron_electrode[i] = e as i16;
                    neuron_gain[i] = 30.0 + 90.0 * (1.0 - de / RECORD_RADIUS);
                }
                if de < STIM_RADIUS {
                    stim_targets[e].push((i as u32, 1.0 - de / STIM_RADIUS));
                }
            }
        }

        Self {
            params: Params::default(),
            rng,
            n,
            pos,
            kind,
            a,
            b,
            c,
            d,
            v,
            u,
            syn_start,
            syn_post,
            syn_w,
            syn_delay,
            plastic,
            in_start,
            in_syn,
            syn_pre,
            ring: vec![0.0; RING * n],
            pre_trace: vec![0.0; n],
            post_trace: vec![0.0; n],
            resource: vec![1.0; n],
            last_spike: vec![u32::MAX; n],
            stim_input: vec![0.0; n],
            t: 0,
            electrode_pos,
            neuron_electrode,
            neuron_gain,
            stim_targets,
            events: Vec::new(),
            electrode_counts: vec![0; N_ELECTRODES],
            fired: Vec::new(),
            selected: 27,
            trace: Vec::new(),
            carry: vec![0.0; WAVEFORM_SAMPLES],
            pending_artifact: 0.0,
            waveform: waveform(),
        }
    }

    pub fn n(&self) -> usize {
        self.n
    }

    pub fn time(&self) -> u32 {
        self.t
    }

    pub fn n_synapses(&self) -> usize {
        self.syn_post.len()
    }

    /// Mean weight of plastic (excitatory to excitatory) synapses.
    pub fn mean_plastic_weight(&self) -> f32 {
        let (sum, count) = self
            .syn_w
            .iter()
            .zip(&self.plastic)
            .filter(|(_, &p)| p)
            .fold((0.0f64, 0usize), |(s, c), (&w, _)| (s + w as f64, c + 1));
        if count == 0 {
            0.0
        } else {
            (sum / count as f64) as f32
        }
    }

    /// Mean available synaptic resource across excitatory neurons (1 = fully recovered).
    pub fn mean_resource(&self) -> f32 {
        let n_exc = self.kind.iter().filter(|&&k| k == 0).count().max(1);
        self.resource.iter().zip(&self.kind).filter(|(_, &k)| k == 0).map(|(r, _)| r).sum::<f32>()
            / n_exc as f32
    }

    pub fn select_electrode(&mut self, e: usize) {
        self.selected = e.min(N_ELECTRODES - 1);
        self.carry.fill(0.0);
    }

    pub fn selected_electrode(&self) -> usize {
        self.selected
    }

    /// Number of neurons a stimulus on electrode `e` reaches.
    pub fn stim_reach(&self, e: usize) -> usize {
        self.stim_targets[e].len()
    }

    /// Deliver a stimulus on electrode `e`, scaled by `amplitude` (1 = default current).
    /// It takes effect at the next step.
    pub fn stimulate(&mut self, e: usize, amplitude: f32) {
        if e >= N_ELECTRODES {
            return;
        }
        let peak = self.params.stim_current * amplitude;
        for &(i, w) in &self.stim_targets[e] {
            self.stim_input[i as usize] += peak * w;
        }
        let (dx, dy) = (
            self.electrode_pos[2 * e] - self.electrode_pos[2 * self.selected],
            self.electrode_pos[2 * e + 1] - self.electrode_pos[2 * self.selected + 1],
        );
        let distance = (dx * dx + dy * dy).sqrt();
        self.pending_artifact += 900.0 * amplitude * (-distance / 0.12).exp();
    }

    /// Advance `ms` steps. Per-call outputs (`events`, `electrode_counts`, `fired`,
    /// `trace`) describe only this call.
    pub fn step(&mut self, ms: u32) -> usize {
        self.events.clear();
        self.fired.clear();
        self.electrode_counts.fill(0);
        let samples = ms as usize * SAMPLES_PER_MS;
        self.trace.clear();
        self.trace.resize(samples + WAVEFORM_SAMPLES, 0.0);
        self.trace[..WAVEFORM_SAMPLES].copy_from_slice(&self.carry);
        for k in 0..ms as usize {
            if self.pending_artifact != 0.0 {
                for s in 0..WAVEFORM_SAMPLES {
                    let i = k * SAMPLES_PER_MS + s;
                    self.trace[i] -= self.pending_artifact * (-(s as f32) / 6.0).exp();
                }
                self.pending_artifact = 0.0;
            }
            self.tick(k as u32);
        }
        self.carry.copy_from_slice(&self.trace[samples..]);
        self.trace.truncate(samples);
        for x in self.trace.iter_mut() {
            *x += 4.0 * self.rng.normal() as f32;
        }
        self.fired.len()
    }

    fn tick(&mut self, offset: u32) {
        let n = self.n;
        let t = self.t;
        let slot = (t as usize % RING) * n;
        let (noise_e, noise_i) = (self.params.noise, self.params.noise * 0.6);
        let recover = 1.0 / self.params.tau_recovery;

        let first_fired = self.fired.len();
        for i in 0..n {
            let noise = if self.kind[i] == 0 { noise_e } else { noise_i };
            let input = self.ring[slot + i] + self.stim_input[i] + noise * self.rng.normal() as f32;
            self.ring[slot + i] = 0.0;
            self.stim_input[i] = 0.0;
            let (mut v, mut u) = (self.v[i], self.u[i]);
            let mut spiked = false;
            for _ in 0..2 {
                v += 0.5 * (0.04 * v * v + 5.0 * v + 140.0 - u + input);
                if v >= 30.0 {
                    spiked = true;
                    break;
                }
            }
            u += self.a[i] * (self.b[i] * v - u);
            if spiked {
                v = self.c[i];
                u += self.d[i];
                self.fired.push(i as u32);
            }
            self.v[i] = v;
            self.u[i] = u;
            self.pre_trace[i] *= TRACE_DECAY;
            self.post_trace[i] *= TRACE_DECAY;
            if self.params.depression {
                self.resource[i] += (1.0 - self.resource[i]) * recover;
            }
        }

        for idx in first_fired..self.fired.len() {
            let i = self.fired[idx] as usize;
            self.last_spike[i] = t;
            let e = self.neuron_electrode[i];
            if e >= 0 {
                self.events.push(offset);
                self.events.push(e as u32);
                self.electrode_counts[e as usize] += 1;
                if e as usize == self.selected {
                    let at = offset as usize * SAMPLES_PER_MS
                        + (self.rng.next_u64() % SAMPLES_PER_MS as u64) as usize;
                    let gain = self.neuron_gain[i];
                    for (s, w) in self.waveform.iter().enumerate() {
                        if let Some(x) = self.trace.get_mut(at + s) {
                            *x += gain * w;
                        }
                    }
                }
            }
            let efficacy = if self.params.depression { self.resource[i] } else { 1.0 };
            let (start, end) = (self.syn_start[i] as usize, self.syn_start[i + 1] as usize);
            for s in start..end {
                let post = self.syn_post[s] as usize;
                let when = (t as usize + self.syn_delay[s] as usize) % RING;
                self.ring[when * n + post] += self.syn_w[s] * efficacy;
            }
            if self.params.depression {
                self.resource[i] -= self.params.release * self.resource[i];
            }
            if self.params.stdp && self.kind[i] == 0 {
                let (a_plus, a_minus, w_max) = (self.params.a_plus, self.params.a_minus, self.params.w_max);
                // Pre fired: depress synapses onto neurons that fired recently.
                for s in start..end {
                    if self.plastic[s] {
                        let post = self.syn_post[s] as usize;
                        self.syn_w[s] = (self.syn_w[s] - a_minus * self.post_trace[post]).max(0.0);
                    }
                }
                // Post fired: potentiate synapses from neurons that fired recently.
                for k in self.in_start[i] as usize..self.in_start[i + 1] as usize {
                    let s = self.in_syn[k] as usize;
                    let pre = self.syn_pre[s] as usize;
                    self.syn_w[s] = (self.syn_w[s] + a_plus * self.pre_trace[pre]).min(w_max);
                }
            }
            self.pre_trace[i] += 1.0;
            self.post_trace[i] += 1.0;
        }
        self.t += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sim(seed: u64) -> Sim {
        Sim::new(&Build { seed, ..Default::default() })
    }

    #[test]
    fn deterministic_for_a_seed() {
        let (mut a, mut b) = (sim(3), sim(3));
        let (sa, sb) = (a.step(500), b.step(500));
        assert_eq!(sa, sb);
        assert_eq!(a.fired, b.fired);
        assert_eq!(a.v, b.v);
    }

    #[test]
    fn wiring_is_local_and_complete() {
        let s = sim(1);
        assert_eq!(s.n_synapses(), s.n() * 80);
        let mean_len: f32 = (0..s.n_synapses())
            .map(|k| {
                let (i, j) = (s.syn_pre[k] as usize, s.syn_post[k] as usize);
                ((s.pos[2 * i] - s.pos[2 * j]).powi(2) + (s.pos[2 * i + 1] - s.pos[2 * j + 1]).powi(2)).sqrt()
            })
            .sum::<f32>()
            / s.n_synapses() as f32;
        assert!(mean_len < 0.25, "connections should be mostly local, mean length {mean_len}");
    }

    #[test]
    fn every_electrode_records_and_stimulates_someone() {
        let s = sim(1);
        let recorded = s.neuron_electrode.iter().filter(|&&e| e >= 0).count();
        assert!(recorded > N_ELECTRODES, "{recorded} neurons under electrodes");
        assert!((0..N_ELECTRODES).all(|e| s.stim_reach(e) > 0));
    }

    #[test]
    fn stimulation_evokes_local_activity() {
        let mut s = sim(2);
        s.params.noise = 0.0; // silence the background so the response is the stimulus's
        s.step(300);
        let e = 27;
        s.stimulate(e, 1.0);
        s.step(5);
        let near = s.electrode_counts[e] + s.electrode_counts[e + 1] + s.electrode_counts[e - 1];
        let far = s.electrode_counts[0] + s.electrode_counts[7] + s.electrode_counts[63];
        assert!(near > 0, "stimulus should make nearby neurons fire");
        assert_eq!(far, 0, "a 5 ms response should stay local");
    }

    #[test]
    fn trace_has_one_block_of_samples_per_ms() {
        let mut s = sim(1);
        s.step(50);
        assert_eq!(s.trace.len(), 50 * SAMPLES_PER_MS);
        assert!(s.trace.iter().all(|x| x.is_finite()));
    }
}
