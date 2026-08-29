/**
 * tcp.js — TCP Sliding-Window & Receiver-Window Core Engine
 *
 * Models:
 *  - Sender:   SND.UNA, SND.NXT, cwnd (slow-start / congestion-avoidance)
 *  - Receiver: RCV.NXT, receive buffer, rwnd advertisement
 *  - Network:  RTT delay, optional segment loss
 *  - Segments fly through a simulated pipe with timestamps
 */

'use strict';

// ─── Segment states ──────────────────────────────────────────────────────────
const SEG_STATE = Object.freeze({
  UNSENT:    'UNSENT',
  IN_FLIGHT: 'IN_FLIGHT',
  LOST:      'LOST',
  RECEIVED:  'RECEIVED',
  ACKED:     'ACKED',
});

// ─── Event types (emitted to UI log) ────────────────────────────────────────
const EV = Object.freeze({
  SEND:      'SEND',
  ACK:       'ACK',
  LOSS:      'LOSS',
  RETRANS:   'RETRANS',
  RWND_UPD:  'RWND_UPD',
  CWND_UPD:  'CWND_UPD',
  PROBE:     'PROBE',
  DONE:      'DONE',
});

// ─── Segment descriptor ──────────────────────────────────────────────────────
class Segment {
  /**
   * @param {number} seqNo   - first byte sequence number
   * @param {number} len     - payload length (MSS or final chunk)
   * @param {number} segIdx  - index in the segment array
   */
  constructor(seqNo, len, segIdx) {
    this.seqNo      = seqNo;
    this.len        = len;
    this.segIdx     = segIdx;
    this.state      = SEG_STATE.UNSENT;
    this.sentAt     = null;   // simulation time when last sent
    this.ackedAt    = null;
    this.retransCnt = 0;
    this.pipeX      = null;   // x-position in pipe animation (0-1)
    this.isAck      = false;  // true for ACK packets travelling back
  }
}

// ─── In-flight pipe packet (visual only) ─────────────────────────────────────
class PipePacket {
  constructor({ id, label, dir, sentAt, arriveAt, color, lost = false }) {
    this.id       = id;
    this.label    = label;
    this.dir      = dir;        // 'fwd' | 'bwd'
    this.sentAt   = sentAt;
    this.arriveAt = arriveAt;
    this.color    = color;
    this.lost     = lost;
    this.progress = 0;          // 0 → 1
    this.arrived  = false;
  }
}

// ─── Main TCP simulation state ────────────────────────────────────────────────
class TCPSimulator {
  /**
   * @param {object} cfg
   * @param {number} cfg.totalBytes   - total data to transfer
   * @param {number} cfg.mss          - max segment size (bytes)
   * @param {number} cfg.rwndInit     - initial receiver buffer (bytes)
   * @param {number} cfg.rtt          - round-trip time (ms)
   * @param {string} cfg.lossMode     - 'none' | 'single' | 'random'
   * @param {function} cfg.onEvent    - callback(type, detail, simTime)
   */
  constructor(cfg) {
    this.cfg = cfg;

    // ── Derived segment list ────────────────────────────────────────────────
    this.segments = [];
    let seq = 0, idx = 0;
    while (seq < cfg.totalBytes) {
      const len = Math.min(cfg.mss, cfg.totalBytes - seq);
      this.segments.push(new Segment(seq, len, idx));
      seq += len;
      idx++;
    }
    this.totalSegs = this.segments.length;

    // ── Sender state ────────────────────────────────────────────────────────
    this.sndUna   = 0;           // oldest unacked byte
    this.sndNxt   = 0;           // next byte to send
    this.cwnd     = 1;           // congestion window (segments)
    this.ssthresh = Infinity;    // slow-start threshold

    // ── Receiver state ──────────────────────────────────────────────────────
    this.rwnd          = cfg.rwndInit;    // advertised window (bytes)
    this.bufferSize    = cfg.rwndInit;    // total receiver buffer capacity
    this.bufferUsed    = 0;              // bytes not yet consumed by app
    this.rcvNxt        = 0;              // next expected byte
    this.outOfOrder    = [];             // segments received out of order

    // ── Timing ─────────────────────────────────────────────────────────────
    this.simTime       = 0;      // ms
    this.rto           = cfg.rtt * 2;   // retransmit timeout

    // ── Loss bookkeeping ───────────────────────────────────────────────────
    this.lossMode      = cfg.lossMode;
    this.lossTriggered = false;
    this.randomLossPct = 0.15;   // 15 % drop rate in random mode
    this.lostSegIdxSet = new Set();

    // ── Pipe animation packets ─────────────────────────────────────────────
    this.pipePackets   = [];
    this._pktIdSeq     = 0;

    // ── Misc ───────────────────────────────────────────────────────────────
    this.retransCount  = 0;
    this.totalAcked    = 0;
    this.done          = false;
    this.startWallTime = null;   // for throughput calc
    this.probeScheduled = false;

    // ── Pre-compute which segment to drop ─────────────────────────────────
    if (this.lossMode === 'single' && this.totalSegs > 2) {
      // drop the 3rd segment so the effect is visible
      this.lossTrigerIdx = 2;
    }
  }

  // ── Public helpers ────────────────────────────────────────────────────────

  /** Effective window = min(cwnd*MSS, rwnd) */
  get effectiveWindow() {
    return Math.min(this.cwnd * this.cfg.mss, this.rwnd);
  }

  /** Bytes currently in-flight (sent but not acked) */
  get inFlight() {
    return this.sndNxt - this.sndUna;
  }

  /** Index of first UNSENT segment */
  get nextUnsentIdx() {
    return this.segments.findIndex(s => s.state === SEG_STATE.UNSENT);
  }

  /** Segment that owns a given sequence number */
  segForSeq(seq) {
    return this.segments.find(s => s.seqNo === seq) || null;
  }

  // ── Core tick (called every sim step) ─────────────────────────────────────
  /**
   * Advance the simulation by `deltaMs` milliseconds.
   * Returns true if there is still work to do.
   */
  tick(deltaMs) {
    if (this.done) return false;

    this.simTime += deltaMs;

    // 1. Progress pipe packets
    this._advancePipe(deltaMs);

    // 2. Check RTO for any in-flight segments
    this._checkRetransmits();

    // 3. Send new segments into the window
    this._trySend();

    // 4. App drains receiver buffer (simulate steady read rate)
    this._appDrain(deltaMs);

    // 5. Check completion
    if (this.totalAcked >= this.cfg.totalBytes) {
      this.done = true;
      this._emit(EV.DONE, { totalAcked: this.totalAcked, simTime: this.simTime });
    }

    return !this.done;
  }

  // ── Internal: send eligible segments ─────────────────────────────────────
  _trySend() {
    // Zero-window probe
    if (this.rwnd === 0 && this.inFlight === 0 && !this.probeScheduled) {
      this._scheduleProbe();
      return;
    }

    let sentAny = true;
    while (sentAny) {
      sentAny = false;
      // Find the next segment that can be sent
      for (const seg of this.segments) {
        if (seg.state !== SEG_STATE.UNSENT) continue;

        // Window check: can we send this many more bytes?
        if (this.inFlight + seg.len > this.effectiveWindow) break;

        this._sendSegment(seg);
        sentAny = true;
        break; // re-evaluate window after each send
      }
    }
  }

  _sendSegment(seg) {
    seg.state  = SEG_STATE.IN_FLIGHT;
    seg.sentAt = this.simTime;
    this.sndNxt = seg.seqNo + seg.len;

    const lost = this._shouldDrop(seg);
    if (lost) {
      seg.state = SEG_STATE.LOST;
      this.lostSegIdxSet.add(seg.segIdx);
    }

    this._emit(EV.SEND, {
      seq: seg.seqNo, len: seg.len, segIdx: seg.segIdx, lost,
    });

    // Add forward pipe packet
    this._addPipePacket({
      label: `SEQ ${seg.seqNo}`,
      dir:   'fwd',
      color: lost ? '#e74c3c' : '#3498db',
      lost,
      arriveDelay: this.cfg.rtt / 2,
      seg,
    });
  }

  // ── Internal: pipe advancement ────────────────────────────────────────────
  _advancePipe(deltaMs) {
    for (const pkt of this.pipePackets) {
      if (pkt.arrived) continue;
      const elapsed  = this.simTime - pkt.sentAt;
      const duration = pkt.arriveAt - pkt.sentAt;
      pkt.progress = Math.min(1, elapsed / duration);

      if (pkt.progress >= 1 && !pkt.arrived) {
        pkt.arrived = true;
        if (!pkt.lost) {
          this._onPacketArrive(pkt);
        }
      }
    }

    // Prune very old packets to keep memory clean
    const cutoff = this.simTime - this.cfg.rtt * 6;
    this.pipePackets = this.pipePackets.filter(p => p.sentAt > cutoff || !p.arrived);
  }

  _addPipePacket({ label, dir, color, lost, arriveDelay, seg }) {
    const pkt = new PipePacket({
      id:       this._pktIdSeq++,
      label,
      dir,
      sentAt:   this.simTime,
      arriveAt: this.simTime + arriveDelay,
      color,
      lost,
    });
    pkt._seg = seg || null;
    this.pipePackets.push(pkt);
    return pkt;
  }

  _onPacketArrive(pkt) {
    if (pkt.dir === 'fwd') {
      // Data segment arrived at receiver
      this._receiveSegment(pkt._seg);
    } else if (pkt.dir === 'bwd') {
      // ACK arrived at sender
      this._processAck(pkt._ackSeq, pkt._rwnd);
    }
  }

  // ── Internal: receiver logic ──────────────────────────────────────────────
  _receiveSegment(seg) {
    if (!seg || seg.state === SEG_STATE.ACKED) return;

    // Buffer availability check
    const freeSpace = this.bufferSize - this.bufferUsed;
    if (freeSpace < seg.len) {
      // Drop due to full buffer (simulated receiver overflow)
      this._emit(EV.RWND_UPD, { rwnd: 0, reason: 'buffer full' });
      return;
    }

    seg.state    = SEG_STATE.RECEIVED;
    this.bufferUsed += seg.len;

    // Update rcvNxt if in-order
    if (seg.seqNo === this.rcvNxt) {
      this.rcvNxt += seg.len;
      // Drain any buffered out-of-order segments now in order
      this._drainOutOfOrder();
    } else if (seg.seqNo > this.rcvNxt) {
      // Out-of-order: buffer it
      this.outOfOrder.push(seg);
      this.outOfOrder.sort((a, b) => a.seqNo - b.seqNo);
    }

    // Update rwnd = free space after buffering this segment
    this.rwnd = Math.max(0, this.bufferSize - this.bufferUsed);
    this._emit(EV.RWND_UPD, { rwnd: this.rwnd, bufferUsed: this.bufferUsed });

    // Send ACK back (delayed ACK: one ACK per two segments, simplified to immediate)
    this._sendAck();
  }

  _drainOutOfOrder() {
    let again = true;
    while (again) {
      again = false;
      for (let i = 0; i < this.outOfOrder.length; i++) {
        const s = this.outOfOrder[i];
        if (s.seqNo === this.rcvNxt) {
          this.rcvNxt += s.len;
          this.outOfOrder.splice(i, 1);
          again = true;
          break;
        }
      }
    }
  }

  _sendAck() {
    // ACK number = rcvNxt (cumulative)
    const ackNum = this.rcvNxt;
    const rwnd   = this.rwnd;

    this._addPipePacket({
      label:       `ACK ${ackNum}`,
      dir:         'bwd',
      color:       '#2ecc71',
      lost:        false,
      arriveDelay: this.cfg.rtt / 2,
    });
    // Attach metadata to the pipe packet
    const pkt = this.pipePackets[this.pipePackets.length - 1];
    pkt._ackSeq = ackNum;
    pkt._rwnd   = rwnd;
  }

  // ── Internal: sender ACK processing ──────────────────────────────────────
  _processAck(ackSeq, rwnd) {
    if (ackSeq <= this.sndUna) {
      // Duplicate ACK (simplified — not triggering fast retransmit in this model)
      return;
    }

    const prevUna = this.sndUna;
    this.sndUna = ackSeq;

    // Mark segments as ACKED
    for (const seg of this.segments) {
      if (seg.seqNo + seg.len <= ackSeq && seg.state !== SEG_STATE.ACKED) {
        seg.state   = SEG_STATE.ACKED;
        seg.ackedAt = this.simTime;
        this.totalAcked += seg.len;
      }
    }

    const ackedBytes = ackSeq - prevUna;

    // Update rwnd from ACK
    this.rwnd = rwnd;

    // Congestion control: slow-start / congestion-avoidance
    this._updateCwnd(ackedBytes);

    this._emit(EV.ACK, {
      ackSeq, rwnd, ackedBytes,
      cwnd: this.cwnd, totalAcked: this.totalAcked,
    });
  }

  _updateCwnd(ackedBytes) {
    const prevCwnd = this.cwnd;
    if (this.cwnd < this.ssthresh) {
      // Slow start: cwnd += 1 per ACK
      this.cwnd += 1;
    } else {
      // Congestion avoidance: cwnd += 1/cwnd per ACK (approx +1 per RTT)
      this.cwnd += Math.max(1 / this.cwnd, 0.01);
    }
    this.cwnd = Math.min(this.cwnd, Math.ceil(this.cfg.rwndInit / this.cfg.mss));

    if (Math.floor(this.cwnd) !== Math.floor(prevCwnd)) {
      this._emit(EV.CWND_UPD, { cwnd: this.cwnd, ssthresh: this.ssthresh });
    }
  }

  // ── Internal: retransmit timeout ─────────────────────────────────────────
  _checkRetransmits() {
    for (const seg of this.segments) {
      if (seg.state !== SEG_STATE.IN_FLIGHT && seg.state !== SEG_STATE.LOST) continue;
      if (seg.sentAt === null) continue;

      const age = this.simTime - seg.sentAt;
      if (age >= this.rto) {
        this._retransmit(seg);
      }
    }
  }

  _retransmit(seg) {
    seg.retransCnt++;
    seg.sentAt = this.simTime;
    seg.state  = SEG_STATE.IN_FLIGHT;
    this.retransCount++;

    // Congestion response: ssthresh = max(cwnd/2, 2), cwnd = 1
    this.ssthresh = Math.max(Math.floor(this.cwnd / 2), 2);
    this.cwnd = 1;

    this._emit(EV.RETRANS, {
      seq: seg.seqNo, len: seg.len, segIdx: seg.segIdx,
      retransCnt: seg.retransCnt, cwnd: this.cwnd, ssthresh: this.ssthresh,
    });

    const lost = this._shouldDrop(seg);
    if (lost) {
      seg.state = SEG_STATE.LOST;
    }

    this._addPipePacket({
      label:       `RET ${seg.seqNo}`,
      dir:         'fwd',
      color:       lost ? '#e74c3c' : '#e67e22',
      lost,
      arriveDelay: this.cfg.rtt / 2,
      seg,
    });
  }

  // ── Internal: zero-window probe ──────────────────────────────────────────
  _scheduleProbe() {
    this.probeScheduled = true;
    this._emit(EV.PROBE, { simTime: this.simTime });

    // After one RTO, send a 1-byte probe
    const probeDelay = this.rto;
    const doProbe = () => {
      if (this.rwnd === 0) {
        // receiver hasn't opened window yet – reschedule
        setTimeout(doProbe, probeDelay);
      } else {
        this.probeScheduled = false;
      }
    };
    // We model this via a fake future event using simTime tracking
    this._probeAt = this.simTime + probeDelay;
  }

  // ── Internal: app drains receiver buffer ─────────────────────────────────
  _appDrain(deltaMs) {
    // App reads at ~2× the send rate to keep buffer from always filling
    const drainRate = (this.cfg.totalBytes / (this.cfg.rtt * 10)) * deltaMs;
    const drained   = Math.min(this.bufferUsed, drainRate);
    this.bufferUsed = Math.max(0, this.bufferUsed - drained);
    this.rwnd       = Math.max(0, this.bufferSize - this.bufferUsed);

    // Clear zero-window probe flag when window opens
    if (this.rwnd > 0 && this.probeScheduled) {
      this.probeScheduled = false;
    }
  }

  // ── Internal: loss decision ───────────────────────────────────────────────
  _shouldDrop(seg) {
    if (this.lossMode === 'none') return false;

    if (this.lossMode === 'single') {
      // Drop the pre-selected segment exactly once
      if (!this.lossTriggered && seg.segIdx === this.lossTrigerIdx && seg.retransCnt === 0) {
        this.lossTriggered = true;
        return true;
      }
      return false;
    }

    if (this.lossMode === 'random') {
      // Random drop, but never retransmitted segments
      if (seg.retransCnt > 0) return false;
      return Math.random() < this.randomLossPct;
    }

    return false;
  }

  // ── Event emitter ─────────────────────────────────────────────────────────
  _emit(type, detail = {}) {
    if (typeof this.cfg.onEvent === 'function') {
      this.cfg.onEvent(type, detail, this.simTime);
    }
  }

  // ── Snapshot (for renderer) ───────────────────────────────────────────────
  snapshot() {
    return {
      simTime:      this.simTime,
      segments:     this.segments,
      totalSegs:    this.totalSegs,
      totalBytes:   this.cfg.totalBytes,
      mss:          this.cfg.mss,
      sndUna:       this.sndUna,
      sndNxt:       this.sndNxt,
      cwnd:         this.cwnd,
      ssthresh:     this.ssthresh,
      rwnd:         this.rwnd,
      bufferSize:   this.bufferSize,
      bufferUsed:   this.bufferUsed,
      rcvNxt:       this.rcvNxt,
      inFlight:     this.inFlight,
      effectiveWin: this.effectiveWindow,
      retransCount: this.retransCount,
      totalAcked:   this.totalAcked,
      pipePackets:  this.pipePackets,
      done:         this.done,
    };
  }
}

// Export for other modules
window.TCPSimulator = TCPSimulator;
window.SEG_STATE    = SEG_STATE;
window.EV           = EV;
