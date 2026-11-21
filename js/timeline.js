// js/timeline.js — Multi-track Timeline (V2, V1, A1, A2), Ruler, Scrubbing, Trim, Reorder & Snap
import { store, clamp } from './state.js';

export class TimelineController {
  constructor(callbacks = {}) {
    this.onSeek = callbacks.onSeek || (() => {});
    this.scrollEl = document.getElementById('timelineScroll');
    this.trackArea = document.getElementById('timelineTrackArea');
    this.rulerCanvas = document.getElementById('timelineRuler');
    this.playheadEl = document.getElementById('playheadLine');
    this.snapGuideEl = document.getElementById('timelineSnapGuide');

    this.lanes = {
      V2: document.getElementById('laneV2'),
      V1: document.getElementById('laneV1'),
      A1: document.getElementById('laneA1'),
      A2: document.getElementById('laneA2'),
    };

    this._scrubbing = false;
    this._dragOp = null;

    this._bindEvents();
  }

  pxPerSec() {
    return store.ui.zoom || 70;
  }

  timeToPx(t) {
    return Math.max(0, t) * this.pxPerSec();
  }

  pxToTime(px) {
    return Math.max(0, px / this.pxPerSec());
  }

  getSnapPoints(excludeId = null) {
    const pts = [0, store.ui.currentTime];
    for (const c of store.project.v1Clips) {
      if (c.id === excludeId) continue;
      pts.push(c.startTime, c.startTime + store.getClipDuration(c));
    }
    for (const o of store.project.v2Overlays) {
      if (o.id === excludeId) continue;
      pts.push(o.startTime, o.endTime);
    }
    for (const a of store.project.audioClips) {
      if (a.id === excludeId) continue;
      pts.push(a.startTime, a.startTime + store.getClipDuration(a));
    }
    return pts;
  }

  snapTime(t, excludeId = null) {
    if (!store.ui.snap) {
      this._showSnapGuide(null);
      return Math.max(0, t);
    }
    const thresholdSec = 10 / this.pxPerSec();
    const pts = this.getSnapPoints(excludeId);
    let best = t;
    let bestDist = thresholdSec;
    let snapped = null;
    for (const p of pts) {
      const d = Math.abs(t - p);
      if (d < bestDist) {
        bestDist = d;
        best = p;
        snapped = p;
      }
    }
    this._showSnapGuide(snapped);
    return Math.max(0, best);
  }

  _showSnapGuide(timeSec) {
    if (timeSec == null) {
      this.snapGuideEl.classList.add('hidden');
    } else {
      this.snapGuideEl.classList.remove('hidden');
      this.snapGuideEl.style.left = `${this.timeToPx(timeSec)}px`;
    }
  }

  render() {
    const totalDur = Math.max(12, store.getTotalDuration() + 8);
    const minW = Math.max(this.scrollEl.clientWidth || 800, Math.ceil(this.timeToPx(totalDur)));
    this.trackArea.style.width = `${minW}px`;

    this._renderRuler(minW);
    this._renderLaneV1();
    this._renderLaneV2();
    this._renderLaneAudio('A1');
    this._renderLaneAudio('A2');
    this.updatePlayhead();
  }

  updatePlayhead() {
    const x = this.timeToPx(store.ui.currentTime);
    this.playheadEl.style.left = `${x}px`;
  }

  _renderRuler(widthPx) {
    const canvas = this.rulerCanvas;
    const dpr = window.devicePixelRatio || 1;
    const h = window.innerWidth <= 768 ? 24 : 28;
    if (canvas.width !== Math.round(widthPx * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(widthPx * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${widthPx}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, widthPx, h);

    const pps = this.pxPerSec();
    // Choose clean tick interval
    let majorStep = 1;
    if (pps < 28) majorStep = 10;
    else if (pps < 55) majorStep = 5;
    else if (pps < 110) majorStep = 2;
    else majorStep = 1;

    const minorStep = majorStep / 4;
    const maxSec = widthPx / pps;

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 10px ui-monospace, SFMono-Regular, monospace';
    ctx.textBaseline = 'top';

    for (let t = 0; t <= maxSec; t = Math.round((t + minorStep) * 1000) / 1000) {
      const x = Math.round(t * pps) + 0.5;
      const isMajor = Math.abs(t % majorStep) < 0.001 || Math.abs((t % majorStep) - majorStep) < 0.001;
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 14 : 20);
      ctx.lineTo(x, h);
      ctx.stroke();

      if (isMajor) {
        const mins = Math.floor(t / 60);
        const secs = Math.floor(t % 60);
        const label = `${mins}:${String(secs).padStart(2, '0')}`;
        ctx.fillText(label, x + 3, 3);
      }
    }
    ctx.restore();
  }

  _renderLaneV1() {
    const lane = this.lanes.V1;
    lane.innerHTML = '';
    const sel = store.ui.selected;

    for (const clip of store.project.v1Clips) {
      const dur = store.getClipDuration(clip);
      const el = document.createElement('div');
      el.className = `tl-clip v1-clip${clip.kind === 'freeze' ? ' freeze-clip' : ''}${sel?.type === 'v1' && sel.id === clip.id ? ' selected' : ''}`;
      el.dataset.type = 'v1';
      el.dataset.id = clip.id;
      el.style.left = `${this.timeToPx(clip.startTime)}px`;
      el.style.width = `${Math.max(18, this.timeToPx(dur))}px`;

      // Thumbnails strip
      const asset = store.getAsset(clip.assetId);
      if (asset?.thumbnails?.length) {
        const strip = document.createElement('div');
        strip.className = 'tl-clip-thumbs';
        for (const url of asset.thumbnails) {
          const img = document.createElement('img');
          img.src = url;
          img.draggable = false;
          strip.appendChild(img);
        }
        el.appendChild(strip);
      }

      // Visual fade indicators
      if (clip.fadeIn > 0) {
        const fi = document.createElement('div');
        fi.className = 'tl-fade-in';
        fi.style.width = `${Math.min(this.timeToPx(clip.fadeIn), this.timeToPx(dur) / 2)}px`;
        el.appendChild(fi);
      }
      if (clip.fadeOut > 0) {
        const fo = document.createElement('div');
        fo.className = 'tl-fade-out';
        fo.style.width = `${Math.min(this.timeToPx(clip.fadeOut), this.timeToPx(dur) / 2)}px`;
        el.appendChild(fo);
      }

      const label = document.createElement('span');
      label.className = 'tl-clip-label';
      label.textContent = clip.kind === 'freeze' ? `❄ Freeze (${dur.toFixed(1)}s)` : clip.name;
      el.appendChild(label);

      if (clip.speed && clip.speed !== 1) {
        const badge = document.createElement('span');
        badge.className = 'tl-clip-badge';
        badge.textContent = `${clip.speed}x`;
        el.appendChild(badge);
      } else if (clip.muted || clip.audioDetached) {
        const badge = document.createElement('span');
        badge.className = 'tl-clip-badge';
        badge.textContent = clip.audioDetached ? 'DET' : 'MUTE';
        el.appendChild(badge);
      }

      el.appendChild(this._makeHandle('left', 'v1', clip.id));
      el.appendChild(this._makeHandle('right', 'v1', clip.id));
      lane.appendChild(el);
    }
  }

  _renderLaneV2() {
    const lane = this.lanes.V2;
    lane.innerHTML = '';
    const sel = store.ui.selected;

    for (const ov of store.project.v2Overlays) {
      const dur = Math.max(0.1, ov.endTime - ov.startTime);
      const el = document.createElement('div');
      el.className = `tl-clip v2-clip${sel?.type === 'v2' && sel.id === ov.id ? ' selected' : ''}`;
      el.dataset.type = 'v2';
      el.dataset.id = ov.id;
      el.style.left = `${this.timeToPx(ov.startTime)}px`;
      el.style.width = `${Math.max(18, this.timeToPx(dur))}px`;

      const prefix = ov.type === 'text' ? 'T ' : ov.type === 'pip' ? 'PiP ' : ov.type === 'censor' ? 'Blur ' : '';
      const label = document.createElement('span');
      label.className = 'tl-clip-label';
      label.textContent = ov.type === 'text' ? `${prefix}${ov.text || 'Caption'}` : `${prefix}${ov.name}`;
      el.appendChild(label);

      el.appendChild(this._makeHandle('left', 'v2', ov.id));
      el.appendChild(this._makeHandle('right', 'v2', ov.id));
      lane.appendChild(el);
    }
  }

  _renderLaneAudio(trackName) {
    const lane = this.lanes[trackName];
    lane.innerHTML = '';
    const sel = store.ui.selected;
    const clips = store.project.audioClips.filter(a => a.track === trackName);

    for (const ac of clips) {
      const dur = store.getClipDuration(ac);
      const wPx = Math.max(18, this.timeToPx(dur));
      const el = document.createElement('div');
      el.className = `tl-clip ${trackName === 'A1' ? 'a1-clip' : 'a2-clip'}${sel?.type === 'audio' && sel.id === ac.id ? ' selected' : ''}`;
      el.dataset.type = 'audio';
      el.dataset.id = ac.id;
      el.style.left = `${this.timeToPx(ac.startTime)}px`;
      el.style.width = `${wPx}px`;

      // Waveform canvas
      const asset = store.getAsset(ac.assetId);
      if (asset?.waveform?.length) {
        const wc = document.createElement('canvas');
        wc.className = 'tl-clip-wave';
        wc.width = Math.min(600, Math.max(40, Math.round(wPx)));
        wc.height = 36;
        this._drawWaveform(wc, asset.waveform, ac);
        el.appendChild(wc);
      }

      if (ac.fadeIn > 0) {
        const fi = document.createElement('div');
        fi.className = 'tl-fade-in';
        fi.style.width = `${Math.min(this.timeToPx(ac.fadeIn), wPx / 2)}px`;
        el.appendChild(fi);
      }
      if (ac.fadeOut > 0) {
        const fo = document.createElement('div');
        fo.className = 'tl-fade-out';
        fo.style.width = `${Math.min(this.timeToPx(ac.fadeOut), wPx / 2)}px`;
        el.appendChild(fo);
      }

      const label = document.createElement('span');
      label.className = 'tl-clip-label';
      label.textContent = ac.name;
      el.appendChild(label);

      if (ac.muted) {
        const badge = document.createElement('span');
        badge.className = 'tl-clip-badge';
        badge.textContent = 'MUTE';
        el.appendChild(badge);
      } else if (ac.volume !== 1) {
        const badge = document.createElement('span');
        badge.className = 'tl-clip-badge';
        badge.textContent = `${Math.round(ac.volume * 100)}%`;
        el.appendChild(badge);
      }

      el.appendChild(this._makeHandle('left', 'audio', ac.id));
      el.appendChild(this._makeHandle('right', 'audio', ac.id));
      lane.appendChild(el);
    }
  }

  _drawWaveform(canvas, peaks, ac) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';

    const srcDur = Math.max(0.1, ac.sourceDuration || 5);
    const startFrac = clamp((ac.trimStart || 0) / srcDur, 0, 1);
    const endFrac = clamp((ac.trimEnd ?? srcDur) / srcDur, startFrac + 0.01, 1);
    const barCount = Math.max(12, Math.floor(w / 3));
    const barW = w / barCount;

    for (let i = 0; i < barCount; i++) {
      const f = startFrac + (i / barCount) * (endFrac - startFrac);
      const pIdx = Math.min(peaks.length - 1, Math.floor(f * peaks.length));
      const amp = clamp((peaks[pIdx] || 0.2) * Math.min(1.5, ac.volume ?? 1), 0.08, 1);
      const bh = amp * (h - 6);
      ctx.fillRect(i * barW, (h - bh) / 2, Math.max(1, barW - 1), bh);
    }
  }

  _makeHandle(side, type, id) {
    const h = document.createElement('div');
    h.className = `tl-handle ${side}`;
    h.dataset.handle = side;
    h.dataset.type = type;
    h.dataset.id = id;
    return h;
  }

  _clientXToTime(clientX) {
    const rect = this.trackArea.getBoundingClientRect();
    const x = Math.max(0, clientX - rect.left);
    return this.pxToTime(x);
  }

  _bindEvents() {
    // Scrubbing on ruler
    this.rulerCanvas.addEventListener('pointerdown', (e) => {
      this._scrubbing = true;
      this.rulerCanvas.setPointerCapture(e.pointerId);
      const t = this._clientXToTime(e.clientX);
      this.onSeek(t);
    });

    this.rulerCanvas.addEventListener('pointermove', (e) => {
      if (!this._scrubbing) return;
      this.onSeek(this._clientXToTime(e.clientX));
    });

    const endScrub = () => { this._scrubbing = false; };
    this.rulerCanvas.addEventListener('pointerup', endScrub);
    this.rulerCanvas.addEventListener('pointercancel', endScrub);

    // Clip selection, move, reorder, and trim handles
    this.trackArea.addEventListener('pointerdown', (e) => {
      if (e.target === this.rulerCanvas) return;

      const handleEl = e.target.closest('.tl-handle');
      const clipEl = e.target.closest('.tl-clip');

      if (!clipEl) {
        // Clicked empty lane space -> seek playhead
        this.onSeek(this._clientXToTime(e.clientX));
        return;
      }

      const type = clipEl.dataset.type;
      const id = clipEl.dataset.id;
      store.select(type, id);
      const item = store.getSelectedItem();
      if (!item) return;

      const mode = handleEl ? (handleEl.dataset.handle === 'left' ? 'trim-left' : 'trim-right') : 'move';

      this._dragOp = {
        mode,
        type,
        id,
        item,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        origStartTime: item.startTime,
        origEndTime: item.endTime,
        origTrimStart: item.trimStart || 0,
        origTrimEnd: item.trimEnd ?? item.sourceDuration ?? 3,
        origDuration: item.duration || store.getClipDuration(item),
      };
      this.trackArea.setPointerCapture(e.pointerId);
    });

    this.trackArea.addEventListener('pointermove', (e) => {
      if (!this._dragOp) return;
      const op = this._dragOp;
      if (!op.started) {
        if (Math.abs(e.clientX - op.startX) < 5 && Math.abs(e.clientY - op.startY) < 5) return;
        op.started = true;
        store.pushHistory();
      }
      const dt = (e.clientX - op.startX) / this.pxPerSec();
      const item = op.item;

      if (op.type === 'v1') {
        const speed = item.speed || 1;
        if (op.mode === 'move') {
          if (store.ui.ripple) {
            // Reorder V1 clips horizontally based on pointer center
            const pointerTime = this._clientXToTime(e.clientX);
            const list = store.project.v1Clips;
            const currIdx = list.findIndex(c => c.id === item.id);
            let targetIdx = currIdx;
            for (let i = 0; i < list.length; i++) {
              const mid = list[i].startTime + store.getClipDuration(list[i]) / 2;
              if (pointerTime < mid) { targetIdx = i; break; }
              targetIdx = list.length - 1;
            }
            if (currIdx >= 0 && targetIdx !== currIdx) {
              const [moved] = list.splice(currIdx, 1);
              list.splice(targetIdx, 0, moved);
              store.repackV1(true);
            }
          } else {
            item.startTime = this.snapTime(Math.max(0, op.origStartTime + dt), item.id);
          }
        } else if (op.mode === 'trim-left') {
          if (item.kind === 'image' || item.kind === 'freeze') {
            const newDur = Math.max(0.3, op.origDuration - dt);
            const delta = op.origDuration - newDur;
            item.duration = newDur;
            if (!store.ui.ripple) item.startTime = Math.max(0, op.origStartTime + delta);
            else store.repackV1(true);
          } else {
            const maxShift = (op.origTrimEnd - op.origTrimStart) / speed - 0.15;
            const shift = clamp(dt, -op.origTrimStart / speed, maxShift);
            item.trimStart = Math.max(0, op.origTrimStart + shift * speed);
            if (!store.ui.ripple) item.startTime = Math.max(0, op.origStartTime + shift);
            else store.repackV1(true);
          }
        } else if (op.mode === 'trim-right') {
          if (item.kind === 'image' || item.kind === 'freeze') {
            item.duration = Math.max(0.3, op.origDuration + dt);
          } else {
            const newEnd = clamp(op.origTrimEnd + dt * speed, item.trimStart + 0.15 * speed, item.sourceDuration);
            item.trimEnd = newEnd;
          }
          if (store.ui.ripple) store.repackV1(true);
        }
      } else if (op.type === 'v2') {
        const origDur = op.origEndTime - op.origStartTime;
        if (op.mode === 'move') {
          const ns = this.snapTime(Math.max(0, op.origStartTime + dt), item.id);
          item.startTime = ns;
          item.endTime = ns + origDur;
        } else if (op.mode === 'trim-left') {
          const ns = this.snapTime(clamp(op.origStartTime + dt, 0, op.origEndTime - 0.2), item.id);
          item.startTime = ns;
        } else if (op.mode === 'trim-right') {
          const ne = this.snapTime(Math.max(op.origStartTime + 0.2, op.origEndTime + dt), item.id);
          item.endTime = ne;
        }
      } else if (op.type === 'audio') {
        const speed = item.speed || 1;
        if (op.mode === 'move') {
          item.startTime = this.snapTime(Math.max(0, op.origStartTime + dt), item.id);
          // Allow vertical drag between A1 and A2
          const a1Rect = this.lanes.A1.getBoundingClientRect();
          const a2Rect = this.lanes.A2.getBoundingClientRect();
          if (e.clientY >= a2Rect.top && e.clientY <= a2Rect.bottom) item.track = 'A2';
          else if (e.clientY >= a1Rect.top && e.clientY <= a1Rect.bottom) item.track = 'A1';
        } else if (op.mode === 'trim-left') {
          const maxShift = (op.origTrimEnd - op.origTrimStart) / speed - 0.15;
          const shift = clamp(dt, -op.origTrimStart / speed, maxShift);
          item.trimStart = Math.max(0, op.origTrimStart + shift * speed);
          item.startTime = Math.max(0, op.origStartTime + shift);
        } else if (op.mode === 'trim-right') {
          item.trimEnd = clamp(op.origTrimEnd + dt * speed, item.trimStart + 0.15 * speed, item.sourceDuration);
        }
      }

      this.render();
      store.emit('timeline-drag');
    });

    const endDrag = () => {
      if (!this._dragOp) return;
      const didMove = this._dragOp.started;
      this._dragOp = null;
      this._showSnapGuide(null);
      if (didMove) store.emit('timeline-change');
    };
    this.trackArea.addEventListener('pointerup', endDrag);
    this.trackArea.addEventListener('pointercancel', endDrag);
  }
}
