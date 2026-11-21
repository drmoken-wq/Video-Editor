// js/timeline.js — Multi-track Timeline (V2, V1, A1, A2) with Mobile-First Touch Scrub, Trim Grips, Long-Press Move & Pinch-to-Zoom
import { store, clamp, formatTimecode } from './state.js';

export class TimelineController {
  constructor(callbacks = {}) {
    this.onSeek = callbacks.onSeek || (() => {});
    this.scrollEl = document.getElementById('timelineScroll');
    this.trackArea = document.getElementById('timelineTrackArea');
    this.rulerCanvas = document.getElementById('timelineRuler');
    this.playheadEl = document.getElementById('playheadLine');
    this.playheadHandle = document.getElementById('playheadHandle');
    this.scrubTooltipEl = document.getElementById('timelineScrubTooltip');
    this.snapGuideEl = document.getElementById('timelineSnapGuide');

    this.lanes = {
      V2: document.getElementById('laneV2'),
      V1: document.getElementById('laneV1'),
      A1: document.getElementById('laneA1'),
      A2: document.getElementById('laneA2'),
    };

    this._scrubbing = false;
    this._dragOp = null;
    this._touchHold = null;
    this._pinch = null;
    this._edgeScrollRaf = null;
    this._lastPointerClientX = 0;

    this._bindEvents();
  }

  isMobile() {
    return window.innerWidth <= 768;
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
    const thresholdSec = (this.isMobile() ? 14 : 10) / this.pxPerSec();
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

  _showTooltip(timeSec, customText = null) {
    if (!this.scrubTooltipEl) return;
    if (timeSec == null) {
      this.scrubTooltipEl.classList.add('hidden');
      return;
    }
    this.scrubTooltipEl.textContent = customText || formatTimecode(timeSec);
    const x = this.timeToPx(timeSec);
    const maxW = Math.max(80, this.trackArea.clientWidth - 44);
    this.scrubTooltipEl.style.left = `${clamp(x, 38, maxW)}px`;
    this.scrubTooltipEl.classList.remove('hidden');
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
    this.updatePlayhead(false);
  }

  /**
   * Fast 60fps DOM update during active drag/trim WITHOUT destroying touched DOM nodes
   * (prevents Android/iOS touch pointercancel drops!).
   */
  syncClipPositionsInPlace() {
    const totalDur = Math.max(12, store.getTotalDuration() + 8);
    const minW = Math.max(this.scrollEl.clientWidth || 800, Math.ceil(this.timeToPx(totalDur)));
    if (Math.abs(parseFloat(this.trackArea.style.width || 0) - minW) > 20) {
      this.trackArea.style.width = `${minW}px`;
      this._renderRuler(minW);
    }

    const updateLane = (lane, items, isV2 = false) => {
      const nodes = lane.querySelectorAll('.tl-clip');
      const byId = new Map(items.map(it => [it.id, it]));
      for (const el of nodes) {
        const it = byId.get(el.dataset.id);
        if (!it) continue;
        const dur = isV2 ? Math.max(0.1, it.endTime - it.startTime) : store.getClipDuration(it);
        el.style.left = `${this.timeToPx(it.startTime)}px`;
        el.style.width = `${Math.max(20, this.timeToPx(dur))}px`;
      }
    };

    updateLane(this.lanes.V1, store.project.v1Clips, false);
    updateLane(this.lanes.V2, store.project.v2Overlays, true);
    updateLane(this.lanes.A1, store.project.audioClips.filter(a => a.track === 'A1'), false);
    updateLane(this.lanes.A2, store.project.audioClips.filter(a => a.track === 'A2'), false);
    this.updatePlayhead(false);
  }

  updatePlayhead(autoFollow = false) {
    const x = this.timeToPx(store.ui.currentTime);
    this.playheadEl.style.left = `${x}px`;

    if (autoFollow && !this._scrubbing && !this._dragOp && this.scrollEl) {
      const viewW = this.scrollEl.clientWidth;
      const scrollL = this.scrollEl.scrollLeft;
      const margin = Math.min(64, viewW * 0.18);
      if (x > scrollL + viewW - margin) {
        this.scrollEl.scrollLeft = Math.max(0, x - viewW * 0.35);
      } else if (x < scrollL + 12) {
        this.scrollEl.scrollLeft = Math.max(0, x - viewW * 0.25);
      }
    }
  }

  _renderRuler(widthPx) {
    const canvas = this.rulerCanvas;
    const dpr = window.devicePixelRatio || 1;
    const h = this.isMobile() ? 34 : 28;
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
    let majorStep = 1;
    if (pps < 28) majorStep = 10;
    else if (pps < 55) majorStep = 5;
    else if (pps < 110) majorStep = 2;
    else majorStep = 1;

    const minorStep = majorStep / 4;
    const maxSec = widthPx / pps;

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 10px ui-monospace, SFMono-Regular, monospace';
    ctx.textBaseline = 'top';

    for (let t = 0; t <= maxSec; t = Math.round((t + minorStep) * 1000) / 1000) {
      const x = Math.round(t * pps) + 0.5;
      const isMajor = Math.abs(t % majorStep) < 0.001 || Math.abs((t % majorStep) - majorStep) < 0.001;
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? h - 13 : h - 7);
      ctx.lineTo(x, h);
      ctx.stroke();

      if (isMajor) {
        const mins = Math.floor(t / 60);
        const secs = Math.floor(t % 60);
        const label = `${mins}:${String(secs).padStart(2, '0')}`;
        ctx.fillText(label, x + 3, this.isMobile() ? 6 : 3);
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
      const isSelected = sel?.type === 'v1' && sel.id === clip.id;
      const el = document.createElement('div');
      el.className = `tl-clip v1-clip${clip.kind === 'freeze' ? ' freeze-clip' : ''}${isSelected ? ' selected' : ''}`;
      el.dataset.type = 'v1';
      el.dataset.id = clip.id;
      el.style.left = `${this.timeToPx(clip.startTime)}px`;
      el.style.width = `${Math.max(20, this.timeToPx(dur))}px`;

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
      const isSelected = sel?.type === 'v2' && sel.id === ov.id;
      const el = document.createElement('div');
      el.className = `tl-clip v2-clip${isSelected ? ' selected' : ''}`;
      el.dataset.type = 'v2';
      el.dataset.id = ov.id;
      el.style.left = `${this.timeToPx(ov.startTime)}px`;
      el.style.width = `${Math.max(20, this.timeToPx(dur))}px`;

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
      const wPx = Math.max(20, this.timeToPx(dur));
      const isSelected = sel?.type === 'audio' && sel.id === ac.id;
      const el = document.createElement('div');
      el.className = `tl-clip ${trackName === 'A1' ? 'a1-clip' : 'a2-clip'}${isSelected ? ' selected' : ''}`;
      el.dataset.type = 'audio';
      el.dataset.id = ac.id;
      el.style.left = `${this.timeToPx(ac.startTime)}px`;
      el.style.width = `${wPx}px`;

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

  _startEdgeAutoScroll() {
    if (this._edgeScrollRaf) return;
    const step = () => {
      if (!this._scrubbing && !this._dragOp) {
        this._edgeScrollRaf = null;
        return;
      }
      const rect = this.scrollEl.getBoundingClientRect();
      const edgeZone = 38;
      let delta = 0;
      if (this._lastPointerClientX > rect.right - edgeZone) {
        delta = Math.min(14, (this._lastPointerClientX - (rect.right - edgeZone)) * 0.35);
      } else if (this._lastPointerClientX < rect.left + edgeZone) {
        delta = -Math.min(14, ((rect.left + edgeZone) - this._lastPointerClientX) * 0.35);
      }
      if (Math.abs(delta) > 0.5) {
        this.scrollEl.scrollLeft = Math.max(0, this.scrollEl.scrollLeft + delta);
        if (this._scrubbing) {
          const t = this._clientXToTime(this._lastPointerClientX);
          this.onSeek(t);
          this._showTooltip(t);
        }
      }
      this._edgeScrollRaf = requestAnimationFrame(step);
    };
    this._edgeScrollRaf = requestAnimationFrame(step);
  }

  _stopEdgeAutoScroll() {
    if (this._edgeScrollRaf) {
      cancelAnimationFrame(this._edgeScrollRaf);
      this._edgeScrollRaf = null;
    }
  }

  _clearTouchHold() {
    if (this._touchHold) {
      clearTimeout(this._touchHold.timer);
      this._touchHold = null;
    }
  }

  _beginDragOp(mode, type, id, item, clientX, clientY, clipEl, pointerType) {
    return {
      mode,
      type,
      id,
      item,
      clipEl,
      pointerType,
      startX: clientX,
      startY: clientY,
      started: false,
      origStartTime: item.startTime,
      origEndTime: item.endTime,
      origTrimStart: item.trimStart || 0,
      origTrimEnd: item.trimEnd ?? item.sourceDuration ?? 3,
      origDuration: item.duration || store.getClipDuration(item),
    };
  }

  _applyDragDelta(op, clientX, clientY) {
    const dt = (clientX - op.startX) / this.pxPerSec();
    const item = op.item;
    let tooltipT = null;
    let tooltipLabel = null;

    if (op.type === 'v1') {
      const speed = item.speed || 1;
      if (op.mode === 'move') {
        if (store.ui.ripple) {
          const pointerTime = this._clientXToTime(clientX);
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
          tooltipT = item.startTime;
          tooltipLabel = `Pos #${list.findIndex(c => c.id === item.id) + 1}`;
        } else {
          item.startTime = this.snapTime(Math.max(0, op.origStartTime + dt), item.id);
          tooltipT = item.startTime;
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
        tooltipT = item.startTime;
        tooltipLabel = `Dur ${store.getClipDuration(item).toFixed(2)}s`;
      } else if (op.mode === 'trim-right') {
        if (item.kind === 'image' || item.kind === 'freeze') {
          item.duration = Math.max(0.3, op.origDuration + dt);
        } else {
          const newEnd = clamp(op.origTrimEnd + dt * speed, item.trimStart + 0.15 * speed, item.sourceDuration);
          item.trimEnd = newEnd;
        }
        if (store.ui.ripple) store.repackV1(true);
        const dur = store.getClipDuration(item);
        tooltipT = item.startTime + dur;
        tooltipLabel = `Dur ${dur.toFixed(2)}s`;
      }
    } else if (op.type === 'v2') {
      const origDur = op.origEndTime - op.origStartTime;
      if (op.mode === 'move') {
        const ns = this.snapTime(Math.max(0, op.origStartTime + dt), item.id);
        item.startTime = ns;
        item.endTime = ns + origDur;
        tooltipT = ns;
      } else if (op.mode === 'trim-left') {
        const ns = this.snapTime(clamp(op.origStartTime + dt, 0, op.origEndTime - 0.2), item.id);
        item.startTime = ns;
        tooltipT = ns;
        tooltipLabel = `${(item.endTime - item.startTime).toFixed(2)}s`;
      } else if (op.mode === 'trim-right') {
        const ne = this.snapTime(Math.max(op.origStartTime + 0.2, op.origEndTime + dt), item.id);
        item.endTime = ne;
        tooltipT = ne;
        tooltipLabel = `${(item.endTime - item.startTime).toFixed(2)}s`;
      }
    } else if (op.type === 'audio') {
      const speed = item.speed || 1;
      if (op.mode === 'move') {
        item.startTime = this.snapTime(Math.max(0, op.origStartTime + dt), item.id);
        const a1Rect = this.lanes.A1.getBoundingClientRect();
        const a2Rect = this.lanes.A2.getBoundingClientRect();
        if (clientY >= a2Rect.top && clientY <= a2Rect.bottom) item.track = 'A2';
        else if (clientY >= a1Rect.top && clientY <= a1Rect.bottom) item.track = 'A1';
        tooltipT = item.startTime;
        tooltipLabel = `${item.track} • ${formatTimecode(item.startTime)}`;
      } else if (op.mode === 'trim-left') {
        const maxShift = (op.origTrimEnd - op.origTrimStart) / speed - 0.15;
        const shift = clamp(dt, -op.origTrimStart / speed, maxShift);
        item.trimStart = Math.max(0, op.origTrimStart + shift * speed);
        item.startTime = Math.max(0, op.origStartTime + shift);
        tooltipT = item.startTime;
        tooltipLabel = `Dur ${store.getClipDuration(item).toFixed(2)}s`;
      } else if (op.mode === 'trim-right') {
        item.trimEnd = clamp(op.origTrimEnd + dt * speed, item.trimStart + 0.15 * speed, item.sourceDuration);
        const dur = store.getClipDuration(item);
        tooltipT = item.startTime + dur;
        tooltipLabel = `Dur ${dur.toFixed(2)}s`;
      }
    }

    this.syncClipPositionsInPlace();
    if (tooltipT != null) this._showTooltip(tooltipT, tooltipLabel);
    store.emit('timeline-drag');
  }

  _bindEvents() {
    // 1. Scrubbing on Ruler OR Playhead Handle (smooth on both desktop & mobile touch!)
    const startScrub = (e) => {
      if (this._pinch) return;
      e.preventDefault();
      e.stopPropagation();
      this._scrubbing = true;
      this._lastPointerClientX = e.clientX;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
      const t = this._clientXToTime(e.clientX);
      this.onSeek(t);
      this._showTooltip(t);
      this._startEdgeAutoScroll();
    };

    const moveScrub = (e) => {
      if (!this._scrubbing) return;
      e.preventDefault();
      this._lastPointerClientX = e.clientX;
      const t = this._clientXToTime(e.clientX);
      this.onSeek(t);
      this._showTooltip(t);
    };

    const endScrub = () => {
      if (!this._scrubbing) return;
      this._scrubbing = false;
      this._stopEdgeAutoScroll();
      this._showTooltip(null);
    };

    this.rulerCanvas.addEventListener('pointerdown', startScrub);
    this.rulerCanvas.addEventListener('pointermove', moveScrub);
    this.rulerCanvas.addEventListener('pointerup', endScrub);
    this.rulerCanvas.addEventListener('pointercancel', endScrub);

    if (this.playheadHandle) {
      this.playheadHandle.addEventListener('pointerdown', startScrub);
      this.playheadHandle.addEventListener('pointermove', moveScrub);
      this.playheadHandle.addEventListener('pointerup', endScrub);
      this.playheadHandle.addEventListener('pointercancel', endScrub);
    }

    // 2. Two-Finger Pinch-to-Zoom + Touch Scroll Lock during active Touch Move/Trim
    this.scrollEl.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        this._clearTouchHold();
        this._dragOp = null;
        this._scrubbing = false;
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dist = Math.max(10, Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY));
        const midX = (t1.clientX + t2.clientX) / 2;
        const rect = this.scrollEl.getBoundingClientRect();
        const midTime = this._clientXToTime(midX);
        this._pinch = {
          startDist: dist,
          startZoom: store.ui.zoom || 70,
          midTime,
          midOffsetInView: midX - rect.left,
        };
      }
    }, { passive: true });

    this.scrollEl.addEventListener('touchmove', (e) => {
      if (this._pinch && e.touches.length === 2) {
        e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dist = Math.max(10, Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY));
        const scale = dist / this._pinch.startDist;
        const nextZoom = clamp(Math.round(this._pinch.startZoom * scale), 20, 240);
        if (nextZoom !== store.ui.zoom) {
          store.ui.zoom = nextZoom;
          const slider = document.getElementById('inputTimelineZoom');
          if (slider) slider.value = String(nextZoom);
          this.render();
          // Keep pinch midpoint anchored under fingers
          this.scrollEl.scrollLeft = Math.max(0, this.timeToPx(this._pinch.midTime) - this._pinch.midOffsetInView);
        }
        return;
      }

      // Prevent browser horizontal scroll while actively trimming or long-press moving on touch!
      if (this._dragOp && this._dragOp.pointerType === 'touch') {
        e.preventDefault();
      }
    }, { passive: false });

    this.scrollEl.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) this._pinch = null;
    }, { passive: true });
    this.scrollEl.addEventListener('touchcancel', () => {
      this._pinch = null;
    }, { passive: true });

    // 3. Clip Selection, Trim Handles & Move/Reorder (Touch-Smart + Desktop-Native)
    this.trackArea.addEventListener('pointerdown', (e) => {
      if (this._pinch) return;
      if (e.target === this.rulerCanvas || e.target.closest('#playheadHandle')) return;

      const isTouch = e.pointerType === 'touch';
      const handleEl = e.target.closest('.tl-handle');
      const clipEl = e.target.closest('.tl-clip');

      // Empty lane tap
      if (!clipEl) {
        if (!isTouch) {
          this.onSeek(this._clientXToTime(e.clientX));
        } else {
          // On touch: track tap vs swipe-scroll so swiping empty space scrolls smoothly!
          this._touchHold = {
            kind: 'empty-tap',
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            timer: null,
          };
        }
        return;
      }

      const type = clipEl.dataset.type;
      const id = clipEl.dataset.id;
      const alreadySelected = store.ui.selected?.type === type && store.ui.selected?.id === id;

      // Case A: Trim Handle Drag (works immediately on both Mouse & Touch!)
      if (handleEl && (!isTouch || alreadySelected)) {
        e.preventDefault();
        if (!alreadySelected) {
          // Update selected class in-place without rebuilding DOM before capture
          this.trackArea.querySelectorAll('.tl-clip.selected').forEach(n => n.classList.remove('selected'));
          clipEl.classList.add('selected');
          store.ui.selected = { type, id };
        }
        const item = store.getSelectedItem();
        if (!item) return;

        const mode = handleEl.dataset.handle === 'left' ? 'trim-left' : 'trim-right';
        this._dragOp = this._beginDragOp(mode, type, id, item, e.clientX, e.clientY, clipEl, e.pointerType);
        this._lastPointerClientX = e.clientX;
        try { this.trackArea.setPointerCapture(e.pointerId); } catch (_) {}
        this._startEdgeAutoScroll();
        return;
      }

      // Case B: Mouse click on clip body -> Instant select + drag-to-move
      if (!isTouch) {
        if (!alreadySelected) {
          this.trackArea.querySelectorAll('.tl-clip.selected').forEach(n => n.classList.remove('selected'));
          clipEl.classList.add('selected');
          store.ui.selected = { type, id };
        }
        const item = store.getSelectedItem();
        if (!item) return;
        this._dragOp = this._beginDragOp('move', type, id, item, e.clientX, e.clientY, clipEl, 'mouse');
        this._lastPointerClientX = e.clientX;
        try { this.trackArea.setPointerCapture(e.pointerId); } catch (_) {}
        return;
      }

      // Case C: Touch on clip body ->
      // - Swipe horizontally right away = Native smooth timeline scroll!
      // - Tap quickly = Selects clip (reveals big external Trim Grips!)
      // - Hold ~260ms = Engages Move/Reorder mode with haptic buzz!
      this._clearTouchHold();
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      this._touchHold = {
        kind: 'clip',
        type,
        id,
        clipEl,
        pointerId,
        startX,
        startY,
        moved: false,
        timer: setTimeout(() => {
          if (!this._touchHold || this._touchHold.moved || this._pinch) return;
          // Activate Long-Press Move Mode!
          this.trackArea.querySelectorAll('.tl-clip.selected').forEach(n => n.classList.remove('selected'));
          clipEl.classList.add('selected', 'dragging-mobile');
          store.ui.selected = { type, id };
          const item = store.getSelectedItem();
          if (!item) return;
          if (navigator.vibrate) try { navigator.vibrate(18); } catch (_) {}
          this._dragOp = this._beginDragOp('move', type, id, item, startX, startY, clipEl, 'touch');
          this._dragOp.started = true;
          store.pushHistory();
          this._lastPointerClientX = startX;
          try { this.trackArea.setPointerCapture(pointerId); } catch (_) {}
          this._showTooltip(item.startTime, 'Drag to move');
          this._startEdgeAutoScroll();
          this._touchHold = null;
        }, 260),
      };
    });

    this.trackArea.addEventListener('pointermove', (e) => {
      // Cancel pending tap/hold if user started swiping to scroll the timeline
      if (this._touchHold) {
        if (Math.hypot(e.clientX - this._touchHold.startX, e.clientY - this._touchHold.startY) > 9) {
          this._touchHold.moved = true;
          this._clearTouchHold();
        }
        return;
      }

      if (!this._dragOp) return;
      const op = this._dragOp;
      if (!op.started) {
        if (Math.abs(e.clientX - op.startX) < 4 && Math.abs(e.clientY - op.startY) < 4) return;
        op.started = true;
        store.pushHistory();
      }
      this._lastPointerClientX = e.clientX;
      this._applyDragDelta(op, e.clientX, e.clientY);
    });

    const endInteraction = (e) => {
      // Handle clean tap on touch (select clip OR seek on empty space)
      if (this._touchHold) {
        const th = this._touchHold;
        this._clearTouchHold();
        if (!th.moved && e.type === 'pointerup') {
          if (th.kind === 'clip') {
            store.select(th.type, th.id);
          } else if (th.kind === 'empty-tap') {
            this.onSeek(this._clientXToTime(e.clientX));
          }
        }
      }

      if (!this._dragOp) return;
      const op = this._dragOp;
      const didMove = op.started;
      if (op.clipEl) op.clipEl.classList.remove('dragging-mobile');
      this._dragOp = null;
      this._stopEdgeAutoScroll();
      this._showSnapGuide(null);
      this._showTooltip(null);

      if (didMove) {
        store.emit('timeline-change');
      } else {
        // Click/tap without moving -> ensure inspector syncs with selection
        store.emit('selection');
      }
    };

    this.trackArea.addEventListener('pointerup', endInteraction);
    this.trackArea.addEventListener('pointercancel', endInteraction);
  }
}
