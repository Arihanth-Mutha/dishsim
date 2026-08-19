//! dishsim: a spiking neuronal culture on a 64-electrode array, small enough to run in
//! a browser tab.
//!
//! The WebAssembly interface is a handful of `extern "C"` functions over one global
//! simulation (WebAssembly here is single-threaded). The page reads results straight
//! out of linear memory through the pointers `dish_ptr` returns, so a frame costs no
//! copying or serialisation. There is no wasm-bindgen and there are no dependencies.

mod rng;
pub mod sim;

use std::cell::RefCell;

pub use sim::{Build, Kind, Params, Sim, GRID, N_ELECTRODES, SAMPLES_PER_MS};

thread_local! {
    static SIM: RefCell<Option<Sim>> = const { RefCell::new(None) };
}

fn with<R: Default>(f: impl FnOnce(&mut Sim) -> R) -> R {
    SIM.with(|cell| cell.borrow_mut().as_mut().map(f).unwrap_or_default())
}

/// Parameter ids for `dish_set` / `dish_get`.
pub mod param {
    pub const NOISE: u32 = 0;
    pub const STDP: u32 = 1;
    pub const DEPRESSION: u32 = 2;
    pub const STIM_CURRENT: u32 = 3;
    pub const MEAN_WEIGHT: u32 = 4;
    pub const MEAN_RESOURCE: u32 = 5;
    pub const SELECTED: u32 = 6;
    pub const SYNAPSES: u32 = 7;
}

/// Buffer ids for `dish_ptr` / `dish_len`.
pub mod buffer {
    /// f32 x, y per neuron.
    pub const POSITIONS: u32 = 0;
    /// u8 per neuron: 0 excitatory, 1 inhibitory.
    pub const KINDS: u32 = 1;
    /// u32 per neuron: time of last spike in ms (u32::MAX if never).
    pub const LAST_SPIKE: u32 = 2;
    /// u32 pairs (ms offset in last call, electrode) per recorded spike.
    pub const EVENTS: u32 = 3;
    /// u32 per electrode: spikes during the last call.
    pub const ELECTRODE_COUNTS: u32 = 4;
    /// f32 x, y per electrode.
    pub const ELECTRODE_POSITIONS: u32 = 5;
    /// f32 scope samples (uV, 20 kHz) for the selected electrode during the last call.
    pub const TRACE: u32 = 6;
    /// f32 membrane potential per neuron.
    pub const VOLTAGE: u32 = 7;
    /// u32 indices of neurons that fired during the last call.
    pub const FIRED: u32 = 8;
}

#[no_mangle]
pub extern "C" fn dish_init(seed: u32, n: u32) {
    let sim = Sim::new(&Build { seed: seed as u64, n: n as usize, ..Default::default() });
    SIM.with(|cell| *cell.borrow_mut() = Some(sim));
}

/// Advance `ms` milliseconds; returns how many neurons fired.
#[no_mangle]
pub extern "C" fn dish_step(ms: u32) -> u32 {
    with(|s| s.step(ms) as u32)
}

#[no_mangle]
pub extern "C" fn dish_stimulate(electrode: u32, amplitude: f32) {
    with(|s| s.stimulate(electrode as usize, amplitude))
}

#[no_mangle]
pub extern "C" fn dish_set(id: u32, value: f32) {
    with(|s| match id {
        param::NOISE => s.params.noise = value.max(0.0),
        param::STDP => s.params.stdp = value != 0.0,
        param::DEPRESSION => s.params.depression = value != 0.0,
        param::STIM_CURRENT => s.params.stim_current = value.max(0.0),
        param::SELECTED => s.select_electrode(value as usize),
        _ => {}
    })
}

#[no_mangle]
pub extern "C" fn dish_get(id: u32) -> f32 {
    with(|s| match id {
        param::NOISE => s.params.noise,
        param::STDP => s.params.stdp as u32 as f32,
        param::DEPRESSION => s.params.depression as u32 as f32,
        param::STIM_CURRENT => s.params.stim_current,
        param::MEAN_WEIGHT => s.mean_plastic_weight(),
        param::MEAN_RESOURCE => s.mean_resource(),
        param::SELECTED => s.selected_electrode() as f32,
        param::SYNAPSES => s.n_synapses() as f32,
        _ => f32::NAN,
    })
}

#[no_mangle]
pub extern "C" fn dish_n() -> u32 {
    with(|s| s.n() as u32)
}

#[no_mangle]
pub extern "C" fn dish_time() -> u32 {
    with(|s| s.time())
}

fn raw<T>(v: &[T]) -> (usize, u32) {
    (v.as_ptr() as usize, v.len() as u32)
}

fn view(s: &Sim, id: u32) -> (usize, u32) {
    match id {
        buffer::POSITIONS => raw(&s.pos),
        buffer::KINDS => raw(&s.kind),
        buffer::LAST_SPIKE => raw(&s.last_spike),
        buffer::EVENTS => raw(&s.events),
        buffer::ELECTRODE_COUNTS => raw(&s.electrode_counts),
        buffer::ELECTRODE_POSITIONS => raw(&s.electrode_pos),
        buffer::TRACE => raw(&s.trace),
        buffer::VOLTAGE => raw(&s.v),
        buffer::FIRED => raw(&s.fired),
        _ => (0, 0),
    }
}

/// Address of a buffer in linear memory. Valid until the next call that steps or
/// re-initialises the simulation.
#[no_mangle]
pub extern "C" fn dish_ptr(id: u32) -> usize {
    with(|s| view(s, id).0)
}

/// Number of elements (not bytes) in a buffer.
#[no_mangle]
pub extern "C" fn dish_len(id: u32) -> u32 {
    with(|s| view(s, id).1)
}
