/**
 * renderer.js — Canvas-based visualizer for the TCP Flow-Control Simulator
 *
 * Draws three canvases on every animation frame using the simulator snapshot:
 *   1. Sender Window   — byte-sequence strip coloured by segment state
 *   2. Network Pipe    — animated data/ACK packets flying between endpoints
 *   3. Receiver Buffer — fill bar showing buffer occupancy and rwnd
 */

'use strict';

// ── Colours (match CSS legend) ────────────────────────────────────────────────
const COLORS = {
  sentAcked:      '#27ae60',
  sentUnacked:    '#e67e22',
  inFlight:       '#3498db',
  unsentAllowed:  '#9b59b6',
  unsentBlocked:  '#bdc3c7',
  lost:           '#e74c3c',
  retrans:        '#f39c12',
  pktData:        '#3498db',
  pktAck:         '#2ecc71',
  pktLost:        '#e74c3c',
  pktRetrans:     '#e67e22',
  bufferFree:     '#ecf0f1',
  bufferUsed:     '#e74c3c',
  bufferRwnd:     '#2ecc71',
  windowBorder:   '#f1c40f',
};

// ─────────────────────────────────────────────────────────────────────────────
class Renderer {
  constructor() {
    this.senderCanvas   = document.getElementById('senderCanvas');
    this.pipeCanvas     = document.getElementById('pipeCanvas');
    this.receiverCanvas = document.getElementById('receiverCanvas');

    this.sCtx = this.senderCanvas.getContext('2d');
    this.pCtx = this.pipeCanvas.getContext('2d');
    this.rCtx = this.receiverCanvas.getContext('2d');

    this._resizeAll();
    window.addEventListener('resize', () => this._resizeAll());
  }

  _resizeAll() {
    // Make canvases fill their CSS width at device pixel ratio
    [this.senderCanvas, this.pipeCanvas, this.receiverCanvas].forEach(c => {
      const rect  = c.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      c.width  = Math.floor(rect.width  * ratio);
      c.height = Math.floor(rect.height * ratio);
    });
  }

  // ── Master render call ───────────────────────────────────────────────────
  render(snap) {
    this._drawSender(snap);
    this._drawPipe(snap);
    this._drawReceiver(snap);
    this._updateStats(snap);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. SENDER WINDOW CANVAS
  // ─────────────────────────────────────────────────────────────────────────
  _drawSender(snap) {
    const ctx = this.sCtx;
    const W   = this.senderCanvas.width;
    const H   = this.senderCanvas.height;
    const dpr = window.devicePixelRatio || 1;

    ctx.clearRect(0, 0, W, H);

    const PAD     = 16 * dpr;
    const stripY  = H * 0.28;
    const stripH  = H * 0.44;
    const usableW = W - PAD * 2;

    const total = snap.totalBytes;

    // ── Draw each segment as a coloured rectangle ────────────────────────
    for (const seg of snap.segments) {
      const x1 = PAD + (seg.seqNo / total) * usableW;
      const x2 = PAD + ((seg.seqNo + seg.len) / total) * usableW;
      const w  = Math.max(x2 - x1 - 1, 1);

      ctx.fillStyle = this._segColor(seg, snap);
      ctx.fillRect(x1, stripY, w, stripH);
    }

    // ── Sliding window border ────────────────────────────────────────────
    const effWin = snap.effectiveWin;
    const winX1  = PAD + (snap.sndUna / total) * usableW;
    const winX2  = PAD + (Math.min(snap.sndUna + effWin, total) / total) * usableW;

    ctx.strokeStyle = COLORS.windowBorder;
    ctx.lineWidth   = 3 * dpr;
    ctx.strokeRect(winX1, stripY - 4 * dpr, Math.max(winX2 - winX1, 2), stripH + 8 * dpr);

    // ── SND.UNA and SND.NXT tick marks ───────────────────────────────────
    const tickH = stripH + 18 * dpr;
    this._drawTick(ctx, PAD + (snap.sndUna / total) * usableW, stripY, tickH,
      `SND.UNA\n${snap.sndUna}`, '#f1c40f', dpr);
    if (snap.sndNxt > snap.sndUna) {
      this._drawTick(ctx, PAD + (snap.sndNxt / total) * usableW, stripY, tickH,
        `SND.NXT\n${snap.sndNxt}`, '#3498db', dpr);
    }

    // ── Sequence ruler (tick every 10 segments) ──────────────────────────
    const tickEvery = Math.ceil(snap.totalSegs / 10) * snap.mss;
    ctx.fillStyle   = '#7f8c8d';
    ctx.font        = `${10 * dpr}px monospace`;
    ctx.textAlign   = 'center';
    for (let seq = 0; seq <= total; seq += tickEvery) {
      const rx = PAD + (seq / total) * usableW;
      ctx.fillRect(rx - dpr / 2, stripY + stripH, dpr, 5 * dpr);
      ctx.fillText(seq, rx, stripY + stripH + 14 * dpr);
    }

    // ── "Window closed" indicator ────────────────────────────────────────
    if (snap.rwnd === 0) {
      ctx.fillStyle = 'rgba(231,76,60,0.18)';
      ctx.fillRect(PAD, stripY, usableW, stripH);
      ctx.fillStyle   = '#e74c3c';
      ctx.font        = `bold ${13 * dpr}px sans-serif`;
      ctx.textAlign   = 'center';
      ctx.fillText('⚠ Zero Window — Sender Blocked', W / 2, stripY + stripH / 2 + 5 * dpr);
    }
  }

  _segColor(seg, snap) {
    if (seg.state === SEG_STATE.ACKED)     return COLORS.sentAcked;
    if (seg.state === SEG_STATE.LOST)      return COLORS.lost;
    if (seg.state === SEG_STATE.IN_FLIGHT) return COLORS.inFlight;
    if (seg.state === SEG_STATE.RECEIVED)  return COLORS.sentUnacked;

    // UNSENT — check if inside effective window
    const winEnd = snap.sndUna + snap.effectiveWin;
    return seg.seqNo < winEnd ? COLORS.unsentAllowed : COLORS.unsentBlocked;
  }

  _drawTick(ctx, x, y, h, label, color, dpr) {
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(x, y - 6 * dpr);
    ctx.lineTo(x, y + h);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font      = `bold ${9 * dpr}px monospace`;
    ctx.textAlign = 'center';
    const lines = label.split('\n');
    lines.forEach((line, i) => {
      ctx.fillText(line, x, y - 8 * dpr - (lines.length - 1 - i) * 11 * dpr);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. NETWORK PIPE CANVAS
  // ─────────────────────────────────────────────────────────────────────────
  _drawPipe(snap) {
    const ctx = this.pCtx;
    const W   = this.pipeCanvas.width;
    const H   = this.pipeCanvas.height;
    const dpr = window.devicePixelRatio || 1;

    ctx.clearRect(0, 0, W, H);

    const PAD       = 40 * dpr;
    const pipeY_fwd = H * 0.30;   // sender → receiver row
    const pipeY_bwd = H * 0.70;   // receiver → sender row
    const pipeH     = 22 * dpr;
    const lineLen   = W - PAD * 2;

    // ── Pipe rails ────────────────────────────────────────────────────────
    ctx.strokeStyle = '#34495e';
    ctx.lineWidth   = 2 * dpr;

    // fwd pipe
    ctx.strokeRect(PAD, pipeY_fwd - pipeH / 2, lineLen, pipeH);
    // bwd pipe
    ctx.strokeRect(PAD, pipeY_bwd - pipeH / 2, lineLen, pipeH);

    // ── Labels ────────────────────────────────────────────────────────────
    ctx.fillStyle = '#ecf0f1';
    ctx.font      = `${10 * dpr}px sans-serif`;
    ctx.textAlign = 'center';

    // Left endpoint: Sender
    this._drawEndpoint(ctx, PAD - 2 * dpr, H / 2, 'Sender', dpr);
    // Right endpoint: Receiver
    this._drawEndpoint(ctx, W - PAD + 2 * dpr, H / 2, 'Receiver', dpr);

    // Direction arrows on pipes
    ctx.fillStyle = '#636e72';
    ctx.font      = `${9 * dpr}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('▶  DATA', W / 2, pipeY_fwd - pipeH / 2 - 4 * dpr);
    ctx.fillText('◀  ACK',  W / 2, pipeY_bwd + pipeH / 2 + 12 * dpr);

    // ── Pipe packets ──────────────────────────────────────────────────────
    for (const pkt of snap.pipePackets) {
      if (pkt.arrived && pkt.progress >= 1) continue;

      const prog  = Math.max(0, Math.min(1, pkt.progress));
      const isFwd = pkt.dir === 'fwd';
      const px    = isFwd
        ? PAD + prog * lineLen
        : W - PAD - prog * lineLen;
      const py    = isFwd ? pipeY_fwd : pipeY_bwd;

      const pktW = 36 * dpr;
      const pktH = 16 * dpr;

      // Glow / shadow for lost packets
      if (pkt.lost) {
        ctx.shadowColor = '#e74c3c';
        ctx.shadowBlur  = 8 * dpr;
      }

      ctx.fillStyle = pkt.color;
      this._roundRect(ctx, px - pktW / 2, py - pktH / 2, pktW, pktH, 4 * dpr);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Label inside packet
      ctx.fillStyle = '#fff';
      ctx.font      = `bold ${8 * dpr}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(pkt.label, px, py + 3 * dpr);

      // ✗ on lost packets
      if (pkt.lost && pkt.progress > 0.5) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font      = `bold ${12 * dpr}px sans-serif`;
        ctx.fillText('✗', px, py + 4 * dpr);
      }
    }
  }

  _drawEndpoint(ctx, x, y, label, dpr) {
    const r = 20 * dpr;
    ctx.fillStyle = '#2c3e50';
    ctx.strokeStyle = '#7f8c8d';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ecf0f1';
    ctx.font      = `bold ${9 * dpr}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y + 3 * dpr);
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. RECEIVER BUFFER CANVAS
  // ─────────────────────────────────────────────────────────────────────────
  _drawReceiver(snap) {
    const ctx = this.rCtx;
    const W   = this.receiverCanvas.width;
    const H   = this.receiverCanvas.height;
    const dpr = window.devicePixelRatio || 1;

    ctx.clearRect(0, 0, W, H);

    const PAD    = 16 * dpr;
    const barY   = H * 0.30;
    const barH   = H * 0.40;
    const barW   = W - PAD * 2;

    const total  = snap.bufferSize;
    const used   = snap.bufferUsed;
    const rwnd   = snap.rwnd;

    // Background
    ctx.fillStyle = COLORS.bufferFree;
    ctx.strokeStyle = '#7f8c8d';
    ctx.lineWidth = 1.5 * dpr;
    ctx.fillRect(PAD, barY, barW, barH);
    ctx.strokeRect(PAD, barY, barW, barH);

    // Used portion (app hasn't read yet — reduces rwnd)
    if (used > 0) {
      const usedW = (used / total) * barW;
      ctx.fillStyle = COLORS.bufferUsed;
      ctx.fillRect(PAD, barY, usedW, barH);
    }

    // rwnd portion (free space advertised to sender)
    if (rwnd > 0) {
      const rwndX = PAD + (used / total) * barW;
      const rwndW = (rwnd / total) * barW;
      ctx.fillStyle = COLORS.bufferRwnd;
      ctx.fillRect(rwndX, barY, rwndW, barH);
    }

    // Divider line: used | rwnd
    if (used > 0 && used < total) {
      const divX = PAD + (used / total) * barW;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(divX, barY);
      ctx.lineTo(divX, barY + barH);
      ctx.stroke();
    }

    // ── Labels ────────────────────────────────────────────────────────────
    ctx.fillStyle = '#2c3e50';
    ctx.font      = `${10 * dpr}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(`Used: ${Math.round(used)} B`, PAD, barY + barH + 16 * dpr);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#27ae60';
    ctx.font      = `bold ${10 * dpr}px sans-serif`;
    ctx.fillText(`rwnd = ${Math.round(rwnd)} B`, W / 2, barY + barH + 16 * dpr);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#7f8c8d';
    ctx.font      = `${10 * dpr}px sans-serif`;
    ctx.fillText(`Buffer: ${total} B`, W - PAD, barY + barH + 16 * dpr);

    // rwnd badge
    const badge = document.getElementById('rwndLabel');
    if (badge) {
      badge.textContent = `rwnd = ${Math.round(rwnd)} / ${total} B`;
      badge.className   = `rwnd-badge ${rwnd === 0 ? 'zero' : rwnd < total * 0.25 ? 'warn' : ''}`;
    }

    // Buffer stats
    const bs = document.getElementById('bufferStats');
    if (bs) {
      const pct = Math.round((used / total) * 100);
      bs.innerHTML =
        `<span class="bs-used">Used ${pct}%</span>` +
        `<span class="bs-sep"> | </span>` +
        `<span class="bs-free">Free ${100 - pct}%</span>`;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. STATS PANEL UPDATE
  // ─────────────────────────────────────────────────────────────────────────
  _updateStats(snap) {
    _set('statSent',      snap.sndNxt + ' B');
    _set('statAcked',     snap.totalAcked + ' B');
    _set('statInFlight',  snap.inFlight + ' B');
    _set('statRwnd',      Math.round(snap.rwnd) + ' B');
    _set('statCwnd',      Math.floor(snap.cwnd) + ' seg');
    _set('statEffWindow', Math.round(snap.effectiveWin) + ' B');
    _set('statRetrans',   snap.retransCount);

    // Throughput: acked bytes / sim time in seconds
    if (snap.simTime > 0) {
      const bps = Math.round((snap.totalAcked / snap.simTime) * 1000);
      _set('statUtil', bps + ' B/s');
    }
  }
}

function _set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

window.Renderer = Renderer;
