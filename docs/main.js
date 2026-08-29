/**
 * main.js — Simulation controller and event wiring
 *
 * Owns the run-loop (requestAnimationFrame-based), connects UI controls
 * to TCPSimulator, feeds snapshots to Renderer, and manages the event log.
 */

'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const btnStart  = document.getElementById('btnStart');
const btnPause  = document.getElementById('btnPause');
const btnStep   = document.getElementById('btnStep');
const btnReset  = document.getElementById('btnReset');
const eventLog  = document.getElementById('eventLog');

const cfgFields = {
  totalBytes: document.getElementById('totalBytes'),
  mss:        document.getElementById('mss'),
  rwnd:       document.getElementById('rwnd'),
  rtt:        document.getElementById('rtt'),
  speed:      document.getElementById('speed'),
  lossMode:   document.getElementById('lossMode'),
};

// ── Sim state ─────────────────────────────────────────────────────────────────
let sim      = null;
let renderer = null;
let running  = false;
let rafId    = null;
let lastWall = null;   // wall-clock timestamp of last frame
let stepMode = false;

// ── Initialise renderer once DOM is ready ────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  renderer = new Renderer();
  _buildBlankFrame();
});

// ── Button handlers ───────────────────────────────────────────────────────────
btnStart.addEventListener('click', () => {
  if (sim && sim.done) { _reset(); return; }
  if (!sim) _createSim();
  _start();
});

btnPause.addEventListener('click', () => {
  if (running) {
    _pause();
  } else {
    _start();          // resume
  }
});

btnStep.addEventListener('click', () => {
  stepMode = true;
  if (!sim) _createSim();
  _doStep();
});

btnReset.addEventListener('click', _reset);

// ── Sim factory ───────────────────────────────────────────────────────────────
function _createSim() {
  sim = new TCPSimulator({
    totalBytes: parseInt(cfgFields.totalBytes.value, 10),
    mss:        parseInt(cfgFields.mss.value, 10),
    rwndInit:   parseInt(cfgFields.rwnd.value, 10),
    rtt:        parseInt(cfgFields.rtt.value, 10),
    lossMode:   cfgFields.lossMode.value,
    onEvent:    _onSimEvent,
  });
  _clearLog();
  _log('info', 'Simulation created', `${sim.totalSegs} segments, MSS=${sim.cfg.mss}B, rwnd=${sim.cfg.rwndInit}B`);
}

// ── Run-loop ──────────────────────────────────────────────────────────────────
function _start() {
  running  = true;
  stepMode = false;
  lastWall = performance.now();

  btnStart.disabled = true;
  btnPause.disabled = false;
  btnStep.disabled  = false;
  btnPause.textContent = '⏸ Pause';

  _disableControls(true);
  _loop();
}

function _pause() {
  running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  btnPause.textContent = '▶ Resume';
  btnStart.disabled    = false;
  btnStep.disabled     = false;
}

function _loop(wallNow) {
  if (!running) return;

  wallNow  = wallNow || performance.now();
  const wallDelta = wallNow - lastWall;
  lastWall = wallNow;

  // Scale wall time → sim time using speed multiplier
  // e.g. speed=500ms means 1 wall-second = 2 sim-seconds
  const baseMs    = parseInt(cfgFields.speed.value, 10);   // ms per sim-unit
  const simDelta  = wallDelta * (1000 / baseMs);           // sim ms per wall ms

  // Advance sim in small sub-steps to keep events granular
  const subStepMs = Math.min(simDelta, 20);
  let remaining   = simDelta;
  while (remaining > 0) {
    const dt = Math.min(remaining, subStepMs);
    const cont = sim.tick(dt);
    remaining -= dt;
    if (!cont) { running = false; break; }
  }

  renderer.render(sim.snapshot());

  if (running) {
    rafId = requestAnimationFrame(_loop);
  } else {
    _onSimDone();
  }
}

function _doStep() {
  if (!sim) _createSim();
  const rtt = parseInt(cfgFields.rtt.value, 10);
  // One "step" = one RTT worth of sim time
  const stepMs = rtt;
  for (let t = 0; t < stepMs; t += 20) {
    const cont = sim.tick(20);
    if (!cont) { _onSimDone(); break; }
  }
  renderer.render(sim.snapshot());
}

function _reset() {
  running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  sim     = null;
  lastWall = null;

  btnStart.disabled = false;
  btnPause.disabled = true;
  btnStep.disabled  = true;
  btnPause.textContent = '⏸ Pause';

  _disableControls(false);
  _clearLog();
  _buildBlankFrame();
}

function _onSimDone() {
  running = false;
  btnStart.disabled    = false;
  btnStart.textContent = '↺ Restart';
  btnPause.disabled    = true;
  btnStep.disabled     = true;
}

// ── Blank initial render ──────────────────────────────────────────────────────
function _buildBlankFrame() {
  const totalBytes = parseInt(cfgFields.totalBytes.value, 10);
  const mss        = parseInt(cfgFields.mss.value, 10);
  const rwndInit   = parseInt(cfgFields.rwnd.value, 10);

  // Build a dummy snapshot to render placeholders
  const dummySim = new TCPSimulator({
    totalBytes, mss, rwndInit, rtt: 400,
    lossMode: 'none', onEvent: () => {},
  });
  renderer.render(dummySim.snapshot());

  // Reset stat displays
  ['statSent','statAcked','statInFlight','statRwnd','statCwnd',
   'statEffWindow','statRetrans','statUtil'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '—';
  });
}

// ── Event log ─────────────────────────────────────────────────────────────────
function _onSimEvent(type, detail, simTime) {
  const t = _fmtTime(simTime);

  switch (type) {
    case EV.SEND:
      if (detail.lost) {
        _log('loss', t, `SEQ ${detail.seq} (${detail.len}B) — DROPPED by network`);
      } else {
        _log('send', t, `SEQ ${detail.seq} (${detail.len}B) sent`);
      }
      break;

    case EV.ACK:
      _log('ack', t,
        `ACK ${detail.ackSeq} | rwnd=${detail.rwnd}B | cwnd=${Math.floor(detail.cwnd)} seg | total acked=${detail.totalAcked}B`);
      break;

    case EV.RETRANS:
      _log('retrans', t,
        `RETRANSMIT SEQ ${detail.seq} (#${detail.retransCnt}) | cwnd→${Math.floor(detail.cwnd)}, ssthresh→${detail.ssthresh}`);
      break;

    case EV.RWND_UPD:
      if (detail.rwnd === 0) {
        _log('warn', t, `⚠ Zero Window — sender must wait for probe`);
      }
      break;

    case EV.CWND_UPD:
      _log('cwnd', t,
        `cwnd updated → ${Math.floor(detail.cwnd)} seg (ssthresh=${detail.ssthresh === Infinity ? '∞' : detail.ssthresh})`);
      break;

    case EV.PROBE:
      _log('warn', t, `Zero-Window Probe scheduled`);
      break;

    case EV.DONE:
      _log('done', t,
        `✔ Transfer complete — ${detail.totalAcked}B in ${_fmtTime(detail.simTime)}`);
      break;

    default:
      break;
  }
}

function _log(cls, time, msg) {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${cls}`;
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${msg}</span>`;
  eventLog.prepend(entry);

  // Cap log at 200 entries
  while (eventLog.children.length > 200) {
    eventLog.removeChild(eventLog.lastChild);
  }
}

function _clearLog() {
  eventLog.innerHTML = '';
}

function _fmtTime(ms) {
  return (ms / 1000).toFixed(2) + 's';
}

// ── Disable/enable config inputs while sim runs ───────────────────────────────
function _disableControls(disabled) {
  Object.values(cfgFields).forEach(el => {
    if (el.id !== 'speed' && el.id !== 'lossMode') {
      el.disabled = disabled;
    }
  });
}
