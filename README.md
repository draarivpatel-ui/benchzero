# BenchZero

A circuit lab bench that runs in any browser. Build or tune a circuit, watch it on a four-view oscilloscope, and check every trace against the closed-form physics from the textbook, live.

Built to run as plain static files at https://aariv.me/benchzero/ with no install, no account and no API keys, and to keep working offline after the first load.

## Why

Most students meet circuits as equations on paper. A real bench (function generator, scope, parts) is a great way to build intuition, but not every classroom has one, and many simulators are desktop installs that hide how they work. BenchZero puts the bench in a browser tab and makes the physics visible. Every guided lab overlays the analytical solution on the simulated trace and reports the error between them, so a student can see that `Vc(t) = V0(1 - e^(-t/RC))` is not just a formula, it is what the circuit does.

## What it does

- **SPICE-style solver.** Modified Nodal Analysis with resistors, capacitors, inductors, independent voltage sources (DC, sine, square, triangle, step, chirp), Shockley diodes (silicon and red LED models) and a saturating op-amp. DC operating point, transient and AC small-signal analyses.
- **Four-view oscilloscope.** Time domain (CH1, CH2, theory overlay, Math V x I power trace, trigger marks, draggable time and voltage cursors), FFT spectrum with harmonic markers and THD, Bode magnitude and phase with the -3 dB line and the cutoff or resonance marker, and an acoustic view.
- **Verify Against Theory.** For the five guided labs, the closed-form curve is computed independently of the solver and compared sample by sample (RMSE, max error), plus physics checks such as the -3.01 dB cutoff, resonant peak, step overshoot, diode drop and op-amp gain.
- **Five guided labs with challenges** that check themselves, such as "critically damp the RLC" or "keep a 1 kOhm load within 5% of the unloaded voltage". A test puts every lab into each challenge's solved state and confirms the challenge passes with no failing check.
- **Interactive schematic.** IEEE-style symbols, live node-voltage badges, animated current flow, drag to move parts, click a node to probe it, add or delete parts, rewire any terminal, tune values with log sliders or SI text (`1k`, `100n`, `4.7m`, `10u`).
- **Sonification.** Press `S` to hear the CH1 trace as pitch (220 Hz at its lowest voltage, 880 Hz at its highest, panned left to right over 3 seconds), so RC charging, RLC ringing and diode clipping can be heard as well as seen.
- **Acoustic lab.** A stepped sine sweep from 100 Hz to 10 kHz played through the speakers and measured with the microphone. If there is no microphone or permission is refused, it runs a silent simulated loopback and every screen says SIMULATED.
- **Share links.** One click copies a URL whose `#lab=` hash rebuilds the circuit, layout, probes and timebase with full numeric precision. All five labs encode in under 400 bytes, and decoding validates every field, bounds coordinates and rejects reserved node names.
- **Offline and private.** A service worker caches the app, the lab autosaves to `localStorage`, and nothing leaves the browser.

## Measured accuracy

From `node --test tests/` on 2026-11-20 (Node 26). RMSE is between the simulated node voltage and the closed-form curve over the whole window; percent is of the theory's full scale.

| Lab | Model | RMSE | RMSE % of full scale | Max error |
| --- | --- | --- | --- | --- |
| 1 RC low-pass, 5 V step, R = 1 kOhm, C = 1 uF, dt = RC/400 | exact | 0.584 uV | 0.0000118 % | 0.963 uV |
| 2 Series RLC step, R = 20 Ohm, L = 10 mH, C = 1 uF (zeta = 0.1) | exact | 66.1 uV | 0.000765 % | 154 uV |
| 3 Half-wave rectifier, 10 V 60 Hz, 100 uF, 1 kOhm | approximate | 55.6 mV | 0.593 % | 96.6 mV |
| 4 Inverting op-amp, gain -10, open-loop gain 1e5 | exact (ideal op-amp) | 0.407 mV | 0.00815 % | 0.586 mV |
| 5 Divider, 10 V, 10 k / 10 k, 1 MOhm load | exact | 8.9e-16 V | 1.8e-14 % | 8.9e-16 V |

Other checks from the same run.

- RC Bode at exactly fc = 159.1549 Hz gives -3.01030 dB and -45.000000 degrees. The full pipeline finds the -3 dB crossing at 159.1549 Hz by bisection.
- RLC resonant peak (capacitor voltage) at 1575.554 Hz and 14.0230 dB, matching `f0 sqrt(1 - 2 zeta^2)` and `1 / (2 zeta sqrt(1 - zeta^2))` to the printed digits.
- RC square, sine and triangle drive, RLC sine drive at f0, and an op-amp driven into its rails all stay under 0.007 % RMSE.
- Rectifier peak diode drop 0.726 V. Newton-Raphson took 21,675 iterations over 10,000 steps, at most 5 in one step.
- Whole-cycle FFT of a simulated 200 Hz square wave gives THD (harmonics 2 to 10) of 42.879 %, against 42.879 % from the Fourier series. The clean inverting amplifier output measures 1.8e-4 % THD. THD is withheld with a clear reason when the window has too few cycles or the drive is non-periodic.
- The op-amp Math trace plots output-port power, V(out) times I(out): 2.499 mW peak in lab 4. Supply consumption cannot be inferred from the three-pin model.
- A full lab run (transient, AC sweep with refinement, spectra, theory) took 0.2 ms to 14 ms per lab in Node 26. The suite has 39 tests and passes with zero dependencies.

The rectifier model is the textbook ideal-switch analysis with a Shockley forward drop. It is labelled approximate in the app and its 0.59 % RMSE is reported as is.

## Architecture

Zero build. Plain HTML, CSS and ES modules, served as static files.

```
index.html, styles.css      page and instrument styling
src/units.js                SI parsing and formatting (1k, 100n, 4.7m, 2.2meg)
src/waves.js                source waveforms and their discontinuities
src/mna.js                  MNA solver: dense LU with partial pivoting, Newton-Raphson,
                            DC, transient (trapezoidal or backward Euler), complex AC
src/fft.js                  radix-2 FFT, Hann and whole-cycle spectra, THD, scope metrics
src/theory.js               closed-form models for the five labs (never imports mna.js)
src/compute.js              one lab run: transient + AC + spectra + theory check
src/worker.js, bridge.js    Web Worker compute with a main-thread fallback
src/presets.js              the five labs, layouts and self-checking challenges
src/faults.js               open/short fault injection helpers
src/serialize.js            #lab= share-link codec with strict validation
src/schematic.js            schematic canvas
src/scope.js                oscilloscope canvas (time, spectrum, Bode, acoustic)
src/audio.js                sonification and the acoustic lab (WebAudio)
src/app.js                  state, panels, keyboard, autosave, sharing
sw.js                       offline cache (relative paths, works under any subpath)
fonts/                      BenchZero Segment, the app's own display face
tools/build-font.py         generator for that font (dev tool only, needs fontTools)
tests/engine.test.mjs       node:test suite, no dependencies
```

### Solver details

- **MNA.** Unknowns are the non-ground node voltages plus one branch current per voltage source, inductor and op-amp output. The system is dense `Float64Array` and solved by Gaussian elimination with partial pivoting. A pivot below `1e-14` of the matrix scale is reported as a singular circuit (for example two voltage sources in parallel), never as `NaN`.
- **Topology checks first.** A union-find pass reports nodes with no path to ground (`FLOATING_NODE`, with the node names), a missing ground, shorted parts and bad values before any matrix is built. Nodes that reach ground only through capacitors get a 1 GOhm tie so their DC level is defined.
- **Companion models.** Trapezoidal by default (`G = 2C/h`, `Z = 2L/h`), backward Euler selectable.
- **Exact source edges.** Step and square sources expose their edge times. The solver steps exactly to each edge using the source's left limit, then takes a tiny backward-Euler step (1e-6 of dt) with capacitor voltages and inductor currents held, which gives the correct state just after the edge. Plain trapezoidal integration would shift a step by half a time step.
- **Diode.** `I = Is (exp(Vd / (n Vt)) - 1)` with `Vt = 0.02585 V`, `Gmin = 1e-12 S` across the junction, SPICE-style junction voltage limiting, and the exponential continued linearly above `exp(80)` so it cannot overflow. Silicon uses `Is = 1e-14 A, n = 1`; the red LED uses `Is = 1e-18 A, n = 2`.
- **Op-amp.** `Vout = Vrail tanh(A (V+ - V-) / Vrail)`, a high-gain VCVS (A = 1e5 by default) that clamps smoothly at the rails, with Newton step limiting on the tanh argument.
- **AC.** Linearized around the DC operating point and solved with complex Gaussian elimination at log-spaced frequencies (60 per decade). The -3 dB crossing is refined by bisection and resonant peaks by golden-section search.
- **Chirp.** Phase is the integral of the instantaneous frequency, `phi(t) = 2 pi (f1 t + (f2 - f1) t^2 / (2T))`.

### Closed-form models (src/theory.js)

1. **RC low-pass.** `Vc(t) = V0 (1 - e^(-t/RC))` for a step, `fc = 1 / (2 pi R C)`, `|H(fc)| = -3.01 dB`. Square and triangle inputs use the exact piecewise solution for a linear input segment, and sine input uses the steady-state plus decaying transient in closed form.
2. **Series RLC.** `f0 = 1 / (2 pi sqrt(L C))`, `zeta = (R/2) sqrt(C/L)`, solved as `x'' + 2 zeta w0 x' + w0^2 x = w0^2 u` in all three damping regimes, with exact initial conditions carried across each source edge.
3. **Half-wave rectifier.** Ideal-switch analysis with a Shockley drop at the load current (approximate, labelled so).
4. **Inverting amplifier.** `Av = -Rf / Rin`, 180 degree phase inversion, clipped at the rails.
5. **Divider and Thevenin load.** `Vout = Vin R2 / (R1 + R2)`, `Rth = R1 || R2`, loaded output `Vth RL / (Rth + RL)`.

## Limitations

- The op-amp has no gain-bandwidth product, slew rate or offset, so its Bode plot is flat. The diode has no series resistance, junction capacitance or reverse breakdown.
- Fixed output time step (with exact edge handling) rather than adaptive step control. Up to 40 parts and 20,000 time steps per run.
- No current sources, transistors, transformers or coupled inductors yet.
- The theory check and guided challenge grading only apply while a lab keeps its preset topology. Values can change freely; adding, removing or rewiring parts turns both off and says why. The op-amp gain challenge grades the measured AC gain, not just the component ratio.
- The acoustic lab reports uncalibrated levels in dBFS, so it shows the shape of a speaker and microphone response, not absolute sound pressure.
- The live-microphone path of the acoustic lab has not been tested on real hardware yet; only the simulated loopback has been run.
- Sonification has not been tested with blind or low-vision students. It is offered as an extra channel, not as a validated accessibility tool.
- Browser testing so far is headless Chrome (desktop and phone widths). Safari and Firefox have not been checked yet.

## Keyboard

| Key | Action |
| --- | --- |
| `1` to `5` | Load a guided lab |
| `Space` | Run or pause the sweep |
| `S` | Sonify CH1 |
| `T` | Theory overlay |
| `M` | Math V x I power trace |
| `V` | Next scope view |
| `R` | Reset the current lab |
| `A` or `B`, then arrows | Move a time cursor (Shift for big steps) |
| Schematic focused, left and right arrows | Pick a part |
| Schematic focused, up and down arrows | Nudge its value by 5 % (Shift for 25 %) |
| Schematic focused, `N`, then `1` or `2` | Cycle nodes and put CH1 or CH2 on one |
| `Enter` | Edit the selected part |
| `Delete` | Remove the selected part |
| Click a node | CH1 probe (Shift-click for CH2) |
| `?` | Shortcut list |

Screen readers get live announcements for lab loads, probe moves, value edits, verification results, completed challenges and errors, and the schematic has a text description of every part and connection.

## Run locally

Modules do not load from `file://`, so serve the folder with any static server.

```
python3 -m http.server 8000
# then open http://localhost:8000/
```

Run the tests with no install (checked with Node 26).

```
node --test tests/
```

## License

MIT. See `LICENSE`. The BenchZero Segment font is original to this project and covered by the same license.
