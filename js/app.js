// js/app.js — Event Wiring, Playback Loop, Shortcuts, Inspector Sync & Smart Export Controller
import {
  store,
  uid,
  clamp,
  formatTimecode,
  formatBytes,
  FILTER_PRESETS,
  COMPRESSION_PRESETS,
  createV1Clip,
  createV2Overlay,
  createAudioClip,
} from './state.js';
import { loadMediaFile, loadImageElement } from './media-loader.js';
import { CanvasStage } from './canvas-stage.js';
import { TimelineController } from './timeline.js';
import { AudioEngine } from './audio-engine.js';
import { ExportEngine, transcodeExoticMedia } from './export-engine.js';

const $ = (id) => document.getElementById(id);

const audioEngine = new AudioEngine();
const stage = new CanvasStage($('previewCanvas'), audioEngine);
const exportEngine = new ExportEngine();

let lastExportBlob = null;
let lastExportUrl = null;
let lastExportFilename = 'pulsecut-export.mp4';
let pendingAudioTargetTrack = 'A1';
let pendingAudioReplaceMode = false;

const timeline = new TimelineController({
  onSeek: (t) => seekTo(t),
});

/* ============================================================================
 * Toast Helper
 * ============================================================================ */
function toast(msg, type = 'info', ms = 2800) {
  const container = $('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* ============================================================================
 * Playback Engine (requestAnimationFrame loop)
 * ============================================================================ */
let _rafId = null;
let _lastTickMs = 0;

function startPlaybackLoop() {
  if (_rafId) return;
  _lastTickMs = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.1, (now - _lastTickMs) / 1000);
    _lastTickMs = now;

    if (store.ui.isPlaying) {
      const total = store.getTotalDuration();
      if (total <= 0) {
        setPlaying(false);
      } else {
        store.ui.currentTime += dt;
        if (store.ui.currentTime >= total) {
          store.ui.currentTime = total;
          setPlaying(false);
        }
        stage.syncVideos(store.ui.currentTime, store.ui.isPlaying);
        audioEngine.syncAudioTracks(store.ui.currentTime, store.ui.isPlaying);
        updateTimecodeDisplay();
        timeline.updatePlayhead();
      }
    }

    stage.render(store.ui.currentTime);
    _rafId = requestAnimationFrame(loop);
  };
  _rafId = requestAnimationFrame(loop);
}

function setPlaying(flag) {
  const total = store.getTotalDuration();
  if (flag && total <= 0) return;
  if (flag && store.ui.currentTime >= total - 0.02) {
    store.ui.currentTime = 0;
  }
  store.ui.isPlaying = flag;
  if (flag) {
    audioEngine.resume();
    stage.syncVideos(store.ui.currentTime, true);
    audioEngine.syncAudioTracks(store.ui.currentTime, true);
  } else {
    stage.pauseAllVideos();
    audioEngine.pauseAllAudio();
    stage.syncVideos(store.ui.currentTime, false);
  }
  $('iconPlay').classList.toggle('hidden', flag);
  $('iconPause').classList.toggle('hidden', !flag);
}

function seekTo(t) {
  const total = Math.max(0, store.getTotalDuration());
  store.ui.currentTime = clamp(t, 0, Math.max(total, 0.001));
  stage.syncVideos(store.ui.currentTime, store.ui.isPlaying);
  audioEngine.syncAudioTracks(store.ui.currentTime, store.ui.isPlaying);
  stage.render(store.ui.currentTime);
  timeline.updatePlayhead();
  updateTimecodeDisplay();
}

function stepFrames(delta) {
  setPlaying(false);
  const primary = store.getPrimaryVideoAsset();
  const fps = primary?.fps ? clamp(Math.round(primary.fps), 24, 60) : 30;
  seekTo(store.ui.currentTime + delta / fps);
}

function updateTimecodeDisplay() {
  const cur = formatTimecode(store.ui.currentTime);
  const tot = formatTimecode(store.getTotalDuration());
  $('timecodeCurrent').textContent = cur;
  $('timecodeTotal').textContent = tot;
  $('projectTelemetry').textContent = tot;

  const dims = store.getCanvasDimensions();
  const hasMedia = store.project.v1Clips.length > 0 || store.project.audioClips.length > 0;
  $('stageDimensionsMeta').textContent = hasMedia ? `${dims.width}×${dims.height}` : '—';
}

/* ============================================================================
 * Media Import (Unrestricted + Automatic Exotic FFmpeg.wasm Handling)
 * ============================================================================ */
async function handleImportFiles(files, mode = 'auto') {
  if (!files || !files.length) return;
  for (const rawFile of Array.from(files)) {
    try {
      toast(`Loading ${rawFile.name}...`, 'info', 2000);
      let asset = await loadMediaFile(rawFile);

      // If exotic container (AVI, FLV, WMV, TS, VOB, WMA, AMR, AC3, etc.), normalize via FFmpeg.wasm WORKERFS
      if (asset.needsFfmpeg) {
        toast(`Converting exotic format (${asset.ext.toUpperCase()}) via FFmpeg.wasm...`, 'info', 4000);
        try {
          const normalizedFile = await transcodeExoticMedia(rawFile, asset.kind === 'audio' ? 'audio' : 'video');
          const oldUrl = asset.objectUrl;
          asset = await loadMediaFile(normalizedFile);
          try { URL.revokeObjectURL(oldUrl); } catch (_) {}
          toast(`Converted ${rawFile.name} ready for editing`, 'success');
        } catch (convErr) {
          console.warn('[Exotic transcode fallback]', convErr);
          toast(`Loaded ${rawFile.name} (FFmpeg export mode)`, 'info');
        }
      }

      store.registerAsset(asset);
      store.pushHistory();

      if (mode === 'overlay-image') {
        const dur = Math.min(4, Math.max(1.5, store.getTotalDuration() || 3));
        const ov = createV2Overlay('image', store.ui.currentTime, dur, {
          assetId: asset.id,
          name: asset.name,
          aspect: asset.width / Math.max(1, asset.height),
        });
        store.project.v2Overlays.push(ov);
        store.select('v2', ov.id);
        switchTab('overlays');
      } else if (mode === 'overlay-pip') {
        const dur = Math.min(asset.duration || 4, Math.max(2, store.getTotalDuration() || asset.duration || 4));
        const ov = createV2Overlay('pip', store.ui.currentTime, dur, {
          assetId: asset.id,
          name: asset.name,
          duration: asset.duration || dur,
        });
        store.project.v2Overlays.push(ov);
        store.select('v2', ov.id);
        switchTab('overlays');
      } else if (mode === 'audio' || asset.kind === 'audio') {
        if (pendingAudioReplaceMode) {
          for (const c of store.project.v1Clips) c.muted = true;
          pendingAudioReplaceMode = false;
        }
        const startT = mode === 'audio' && pendingAudioTargetTrack === 'A2' ? store.ui.currentTime : 0;
        const ac = createAudioClip(asset, pendingAudioTargetTrack, startT);
        store.project.audioClips.push(ac);
        store.select('audio', ac.id);
        switchTab('audio');
      } else {
        // Append sequentially to V1
        const startT = store.project.v1Clips.reduce((m, c) => Math.max(m, c.startTime + store.getClipDuration(c)), 0);
        const clip = createV1Clip(asset, startT);
        store.project.v1Clips.push(clip);
        store.repackV1(store.ui.ripple);
        store.select('v1', clip.id);
      }

      store.emit('import');
      stage.syncVideos(store.ui.currentTime, false);
      toast(`Added ${asset.name}`, 'success', 1800);
    } catch (err) {
      console.error('[Import failed]', err);
      toast(`Could not load ${rawFile.name}: ${err.message}`, 'error', 4000);
    }
  }
}

/* ============================================================================
 * Core Editing Operations (Split, Freeze Frame, Duplicate, Detach, Delete)
 * ============================================================================ */
function splitAtPlayhead() {
  const t = store.ui.currentTime;
  const sel = store.ui.selected;

  // Determine target item: selected item under playhead, or any V1 clip under playhead
  let targetType = sel?.type || 'v1';
  let item = store.getSelectedItem();

  if (targetType === 'v1' || !item) {
    const clip = (item && targetType === 'v1' && t > item.startTime + 0.08 && t < item.startTime + store.getClipDuration(item) - 0.08)
      ? item
      : store.project.v1Clips.find(c => t > c.startTime + 0.08 && t < c.startTime + store.getClipDuration(c) - 0.08);
    if (!clip) { toast('Move playhead inside a clip to split', 'info'); return; }

    store.pushHistory();
    const idx = store.project.v1Clips.findIndex(c => c.id === clip.id);
    const relT = t - clip.startTime;
    const dur = store.getClipDuration(clip);

    if (clip.kind === 'image' || clip.kind === 'freeze') {
      const right = JSON.parse(JSON.stringify(clip));
      right.id = uid('v1');
      clip.duration = Math.max(0.15, relT);
      right.duration = Math.max(0.15, dur - relT);
      right.startTime = t;
      right.fadeIn = 0;
      right.crossfade = 0;
      store.project.v1Clips.splice(idx + 1, 0, right);
      store.select('v1', right.id);
    } else {
      const splitSrc = (clip.trimStart || 0) + relT * (clip.speed || 1);
      const right = JSON.parse(JSON.stringify(clip));
      right.id = uid('v1');
      right.trimStart = splitSrc;
      right.startTime = t;
      right.fadeIn = 0;
      right.crossfade = 0;
      clip.trimEnd = splitSrc;
      clip.fadeOut = 0;
      store.project.v1Clips.splice(idx + 1, 0, right);
      store.select('v1', right.id);
    }
    store.repackV1(store.ui.ripple);
    store.emit('split');
    toast('Split clip', 'success', 1400);
    return;
  }

  if (targetType === 'v2') {
    if (t <= item.startTime + 0.1 || t >= item.endTime - 0.1) {
      toast('Move playhead inside the overlay to split', 'info');
      return;
    }
    store.pushHistory();
    const right = JSON.parse(JSON.stringify(item));
    right.id = uid('v2');
    right.startTime = t;
    item.endTime = t;
    store.project.v2Overlays.push(right);
    store.select('v2', right.id);
    store.emit('split');
    toast('Split overlay', 'success', 1400);
    return;
  }

  if (targetType === 'audio') {
    const dur = store.getClipDuration(item);
    if (t <= item.startTime + 0.1 || t >= item.startTime + dur - 0.1) {
      toast('Move playhead inside the audio clip to split', 'info');
      return;
    }
    store.pushHistory();
    const relT = t - item.startTime;
    const splitSrc = (item.trimStart || 0) + relT * (item.speed || 1);
    const right = JSON.parse(JSON.stringify(item));
    right.id = uid('aud');
    right.trimStart = splitSrc;
    right.startTime = t;
    item.trimEnd = splitSrc;
    store.project.audioClips.push(right);
    store.select('audio', right.id);
    store.emit('split');
    toast('Split audio clip', 'success', 1400);
  }
}

async function insertFreezeFrame() {
  setPlaying(false);
  const t = store.ui.currentTime;
  const clip = store.project.v1Clips.find(c => t >= c.startTime && t <= c.startTime + store.getClipDuration(c));
  if (!clip) {
    toast('Position playhead over a V1 video clip for Freeze Frame', 'info');
    return;
  }

  const blob = await stage.captureFreezeFrameBlob(clip, t);
  if (!blob) {
    toast('Frame not ready yet — scrub slightly and try again', 'error');
    return;
  }

  const url = URL.createObjectURL(blob);
  const img = await loadImageElement(url);
  const freezeAsset = {
    id: uid('freeze'),
    file: new File([blob], 'freeze-frame.png', { type: 'image/png' }),
    name: `Freeze @ ${formatTimecode(t)}`,
    size: blob.size,
    mime: 'image/png',
    ext: 'png',
    kind: 'image',
    objectUrl: url,
    width: img.naturalWidth,
    height: img.naturalHeight,
    duration: store.ui.freezeDuration || 2.0,
    hasAudio: false,
    hasVideo: false,
    thumbnails: [url],
    imageEl: img,
  };
  store.registerAsset(freezeAsset);
  store.pushHistory();

  const holdDur = store.ui.freezeDuration || 2.0;
  const freezeClip = {
    ...createV1Clip(freezeAsset, t),
    kind: 'freeze',
    duration: holdDur,
    crop: JSON.parse(JSON.stringify(clip.crop || { x: 0, y: 0, w: 1, h: 1 })),
    transform: JSON.parse(JSON.stringify(clip.transform || { rotation: 0, flipH: false, flipV: false, scale: 1, panX: 0, panY: 0 })),
    filterPreset: clip.filterPreset,
    filters: JSON.parse(JSON.stringify(clip.filters || FILTER_PRESETS.normal)),
  };

  const idx = store.project.v1Clips.findIndex(c => c.id === clip.id);
  const dur = store.getClipDuration(clip);
  const relT = t - clip.startTime;

  if (relT > 0.12 && relT < dur - 0.12) {
    // Split clip and insert freeze hold right in between!
    const right = JSON.parse(JSON.stringify(clip));
    right.id = uid('v1');
    if (clip.kind === 'image' || clip.kind === 'freeze') {
      clip.duration = relT;
      right.duration = dur - relT;
    } else {
      const splitSrc = (clip.trimStart || 0) + relT * (clip.speed || 1);
      clip.trimEnd = splitSrc;
      right.trimStart = splitSrc;
    }
    right.fadeIn = 0;
    right.crossfade = 0;
    store.project.v1Clips.splice(idx + 1, 0, freezeClip, right);
  } else {
    store.project.v1Clips.splice(idx + 1, 0, freezeClip);
  }

  store.repackV1(true);
  store.select('v1', freezeClip.id);
  store.emit('freeze');
  toast(`Inserted ${holdDur.toFixed(1)}s Freeze Frame`, 'success');
}

function duplicateSelected() {
  const sel = store.ui.selected;
  const item = store.getSelectedItem();
  if (!sel || !item) return;

  store.pushHistory();
  const clone = JSON.parse(JSON.stringify(item));

  if (sel.type === 'v1') {
    clone.id = uid('v1');
    const idx = store.project.v1Clips.findIndex(c => c.id === item.id);
    clone.startTime = item.startTime + store.getClipDuration(item);
    store.project.v1Clips.splice(idx + 1, 0, clone);
    store.repackV1(store.ui.ripple);
    store.select('v1', clone.id);
  } else if (sel.type === 'v2') {
    clone.id = uid('v2');
    const d = item.endTime - item.startTime;
    clone.startTime = item.endTime;
    clone.endTime = clone.startTime + d;
    clone.x = clamp(item.x + 0.04, 0.1, 0.9);
    clone.y = clamp(item.y + 0.04, 0.1, 0.9);
    store.project.v2Overlays.push(clone);
    store.select('v2', clone.id);
  } else if (sel.type === 'audio') {
    clone.id = uid('aud');
    clone.startTime = item.startTime + store.getClipDuration(item);
    store.project.audioClips.push(clone);
    store.select('audio', clone.id);
  }

  store.emit('duplicate');
  toast('Duplicated item', 'success', 1200);
}

function detachAudioFromClip(clip) {
  if (!clip || clip.kind !== 'video') {
    toast('Select a V1 video clip to detach audio', 'info');
    return;
  }
  const asset = store.getAsset(clip.assetId);
  if (!asset || !asset.hasAudio) {
    toast('Selected video has no audio track', 'info');
    return;
  }
  if (clip.audioDetached) {
    toast('Audio is already detached for this clip', 'info');
    return;
  }

  store.pushHistory();
  clip.audioDetached = true;
  const ac = createAudioClip(asset, 'A1', clip.startTime, {
    name: `${clip.name} (Audio)`,
    trimStart: clip.trimStart,
    trimEnd: clip.trimEnd,
    speed: clip.speed,
    volume: clip.volume,
    fadeIn: clip.audioFadeIn || 0,
    fadeOut: clip.audioFadeOut || 0,
  });
  store.project.audioClips.push(ac);
  store.select('audio', ac.id);
  switchTab('audio');
  store.emit('detach-audio');
  toast('Audio detached onto track A1', 'success');
}

function deleteSelected() {
  const sel = store.ui.selected;
  if (!sel) return;
  store.pushHistory();

  if (sel.type === 'v1') {
    store.project.v1Clips = store.project.v1Clips.filter(c => c.id !== sel.id);
    if (store.ui.ripple) store.repackV1(true);
  } else if (sel.type === 'v2') {
    store.project.v2Overlays = store.project.v2Overlays.filter(o => o.id !== sel.id);
  } else if (sel.type === 'audio') {
    store.project.audioClips = store.project.audioClips.filter(a => a.id !== sel.id);
  }

  store.select(null, null);
  store.emit('delete');
}

/* ============================================================================
 * UI Sync (Inspector, Media Bin, Buttons)
 * ============================================================================ */
const TAB_TITLES = {
  canvas: 'Canvas & Layout',
  clip: 'Clip & Transform',
  overlays: 'Overlays & Captions',
  audio: 'Audio & SFX',
  filters: 'Filters & Presets',
};

function isMobileLayout() {
  return window.innerWidth <= 768;
}

function setMobileDrawer(open) {
  const panel = $('inspectorPanel');
  if (!panel) return;
  panel.classList.toggle('mobile-open', !!open && isMobileLayout());
}

function switchTab(tabName, { openDrawer = false } = {}) {
  store.ui.activeTab = tabName;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `pane-${tabName}`);
  });
  const titleEl = $('mobileDrawerTitle');
  if (titleEl) titleEl.textContent = TAB_TITLES[tabName] || tabName;
  if (openDrawer && isMobileLayout()) setMobileDrawer(true);
}

function syncUI(reason) {
  const hasAny = store.project.v1Clips.length > 0 || store.project.audioClips.length > 0;
  $('stageEmpty').classList.toggle('hidden', hasAny);
  $('btnOpenExport').disabled = !hasAny;
  $('btnUndo').disabled = !store.canUndo();
  $('btnRedo').disabled = !store.canRedo();
  $('cropModeBar').classList.toggle('hidden', !store.ui.cropMode);

  // Canvas tab state
  document.querySelectorAll('#aspectPresetGroup .chip').forEach(b => {
    b.classList.toggle('active', b.dataset.aspect === store.project.aspectRatio);
  });
  document.querySelectorAll('#bgModeGroup .chip').forEach(b => {
    b.classList.toggle('active', b.dataset.bg === store.project.bgMode);
  });
  $('solidBgControls').classList.toggle('hidden', store.project.bgMode !== 'solid');
  $('memeBarControls').classList.toggle('hidden', store.project.bgMode !== 'meme-bar');
  $('inputBgColor').value = store.project.bgColor;

  const mb = store.project.memeBar;
  if ($('inputMemeCaption').value !== mb.caption) $('inputMemeCaption').value = mb.caption;
  $('inputMemeBarHeight').value = mb.heightPct;
  $('valMemeBarHeight').textContent = `${mb.heightPct}%`;
  $('inputMemeFontSize').value = mb.fontSize;
  $('valMemeFontSize').textContent = `${mb.fontSize}px`;
  $('selectMemeFont').value = mb.font;
  $('selectMemeDir').value = mb.dir;
  document.querySelectorAll('#memeThemeGroup .chip').forEach(b => {
    b.classList.toggle('active', b.dataset.memeTheme === mb.theme);
  });

  syncMediaBin();
  syncSelectedInspectors();
  timeline.render();
  updateTimecodeDisplay();
  stage.render(store.ui.currentTime);

  if (reason === 'selection' && store.ui.selected) {
    if (store.ui.selected.type === 'v2') switchTab('overlays');
    else if (store.ui.selected.type === 'audio') switchTab('audio');
  }
}

function syncMediaBin() {
  const list = $('mediaBinList');
  const assets = Array.from(store.assets.values());
  if (!assets.length) {
    list.innerHTML = '<div class="empty-hint">No media imported yet.</div>';
    return;
  }
  list.innerHTML = '';
  for (const asset of assets) {
    const row = document.createElement('div');
    row.className = 'media-item';

    const thumb = document.createElement(asset.thumbnails?.[0] ? 'img' : 'div');
    thumb.className = 'media-thumb';
    if (asset.thumbnails?.[0]) thumb.src = asset.thumbnails[0];
    else thumb.textContent = asset.kind === 'audio' ? '♪' : '▶';

    const info = document.createElement('div');
    info.className = 'media-info';
    info.innerHTML = `<div class="media-name">${escapeHtml(asset.name)}</div>
      <div class="media-meta">${asset.kind.toUpperCase()} • ${asset.duration.toFixed(1)}s • ${formatBytes(asset.size)}</div>`;

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-secondary btn-xs';
    addBtn.textContent = '+';
    addBtn.title = 'Append to timeline';
    addBtn.onclick = () => {
      store.pushHistory();
      if (asset.kind === 'audio') {
        const ac = createAudioClip(asset, 'A1', store.ui.currentTime);
        store.project.audioClips.push(ac);
        store.select('audio', ac.id);
      } else {
        const startT = store.project.v1Clips.reduce((m, c) => Math.max(m, c.startTime + store.getClipDuration(c)), 0);
        const c = createV1Clip(asset, startT);
        store.project.v1Clips.push(c);
        store.repackV1(store.ui.ripple);
        store.select('v1', c.id);
      }
      store.emit('append-bin');
    };

    row.append(thumb, info, addBtn);
    list.appendChild(row);
  }
}

function syncSelectedInspectors() {
  const sel = store.ui.selected;
  const item = store.getSelectedItem();

  // --- CLIP (V1) & FILTERS ---
  const isV1 = sel?.type === 'v1' && !!item;
  $('noClipSelectedHint').classList.toggle('hidden', isV1);
  $('clipInspectorContent').classList.toggle('hidden', !isV1);
  $('noFilterClipHint').classList.toggle('hidden', isV1);
  $('filterInspectorContent').classList.toggle('hidden', !isV1);

  if (isV1) {
    $('clipSelectedName').textContent = item.name;
    const isStatic = item.kind === 'image' || item.kind === 'freeze';
    $('imageDurationGroup').style.display = isStatic ? 'block' : 'none';
    $('clipSpeedGroup').style.display = isStatic ? 'none' : 'block';
    if (isStatic) {
      $('inputImageDuration').value = item.duration || 3;
      $('valImageDuration').textContent = `${(item.duration || 3).toFixed(1)}s`;
    }
    document.querySelectorAll('#speedPresetGroup .chip').forEach(b => {
      b.classList.toggle('active', parseFloat(b.dataset.speed) === (item.speed || 1));
    });
    $('btnToggleCropMode').textContent = store.ui.cropMode ? 'Exit Crop' : 'Edit Crop';

    const tr = item.transform || { scale: 1, panX: 0, panY: 0 };
    $('inputClipScale').value = tr.scale ?? 1;
    $('valClipScale').textContent = `${Math.round((tr.scale ?? 1) * 100)}%`;
    $('inputClipPanX').value = tr.panX ?? 0;
    $('valClipPanX').textContent = `${Math.round((tr.panX ?? 0) * 100)}%`;
    $('inputClipPanY').value = tr.panY ?? 0;
    $('valClipPanY').textContent = `${Math.round((tr.panY ?? 0) * 100)}%`;

    $('inputClipFadeIn').value = item.fadeIn || 0;
    $('valClipFadeIn').textContent = `${(item.fadeIn || 0).toFixed(1)}s`;
    $('inputClipFadeOut').value = item.fadeOut || 0;
    $('valClipFadeOut').textContent = `${(item.fadeOut || 0).toFixed(1)}s`;
    $('inputClipCrossfade').value = item.crossfade || 0;
    $('valClipCrossfade').textContent = `${(item.crossfade || 0).toFixed(1)}s`;

    // Filters tab
    document.querySelectorAll('#filterPresetGroup .chip').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === (item.filterPreset || 'normal'));
    });
    const fl = item.filters || FILTER_PRESETS.normal;
    $('inputFilterBrightness').value = fl.brightness ?? 100;
    $('valFilterBrightness').textContent = `${fl.brightness ?? 100}%`;
    $('inputFilterContrast').value = fl.contrast ?? 100;
    $('valFilterContrast').textContent = `${fl.contrast ?? 100}%`;
    $('inputFilterSaturation').value = fl.saturation ?? 100;
    $('valFilterSaturation').textContent = `${fl.saturation ?? 100}%`;
  }

  // --- OVERLAYS (V2) ---
  const isV2 = sel?.type === 'v2' && !!item;
  $('noOverlaySelectedHint').classList.toggle('hidden', isV2);
  $('overlayInspectorContent').classList.toggle('hidden', !isV2);

  if (isV2) {
    $('overlaySelectedName').textContent = item.name || item.type;
    $('overlayTextControls').classList.toggle('hidden', item.type !== 'text');
    $('overlayPipControls').classList.toggle('hidden', item.type !== 'pip');
    $('overlayCensorControls').classList.toggle('hidden', item.type !== 'censor');

    if (item.type === 'text') {
      if ($('inputOverlayText').value !== item.text) $('inputOverlayText').value = item.text || '';
      $('selectOverlayFont').value = item.font || 'impact';
      $('selectOverlayDir').value = item.dir || 'auto';
      $('inputOverlayFontSize').value = item.fontSize || 54;
      $('valOverlayFontSize').textContent = `${item.fontSize || 54}px`;
      $('inputOverlayColor').value = item.color || '#ffffff';
      $('inputOverlayStrokeColor').value = item.strokeColor || '#000000';
      $('inputOverlayStrokeWidth').value = item.strokeWidth ?? 6;
      $('valOverlayStrokeWidth').textContent = `${item.strokeWidth ?? 6}px`;
      $('inputOverlayBgColor').value = item.bgColor || '#000000';
      $('chkOverlayShadow').checked = !!item.shadow;
      $('chkOverlayBgPill').checked = !!item.bgPill;
      $('chkOverlayUppercase').checked = !!item.uppercase;
    } else if (item.type === 'pip') {
      const ck = item.chromaKey || { enabled: false, color: '#00ff00', tolerance: 48, smooth: 14 };
      $('chkChromaEnabled').checked = !!ck.enabled;
      $('inputChromaColor').value = ck.color || '#00ff00';
      $('inputChromaTolerance').value = ck.tolerance ?? 48;
      $('valChromaTolerance').textContent = `${ck.tolerance ?? 48}`;
      $('inputChromaSmooth').value = ck.smooth ?? 14;
      $('valChromaSmooth').textContent = `${ck.smooth ?? 14}`;
      $('inputPipVolume').value = Math.round((item.volume ?? 1) * 100);
      $('valPipVolume').textContent = `${Math.round((item.volume ?? 1) * 100)}%`;
    } else if (item.type === 'censor') {
      document.querySelectorAll('#censorModeGroup .chip').forEach(b => {
        b.classList.toggle('active', b.dataset.censor === (item.censorMode || 'pixelate'));
      });
      $('inputCensorStrength').value = item.strength ?? 14;
      $('valCensorStrength').textContent = `${item.strength ?? 14}`;
      $('inputCensorColor').value = item.color || '#000000';
    }

    $('inputOverlayOpacity').value = Math.round((item.opacity ?? 1) * 100);
    $('valOverlayOpacity').textContent = `${Math.round((item.opacity ?? 1) * 100)}%`;
    $('inputOverlayRotation').value = Math.round(item.rotation || 0);
    $('valOverlayRotation').textContent = `${Math.round(item.rotation || 0)}°`;
    $('inputOverlayFadeIn').value = item.fadeIn || 0;
    $('valOverlayFadeIn').textContent = `${(item.fadeIn || 0).toFixed(1)}s`;
    $('inputOverlayFadeOut').value = item.fadeOut || 0;
    $('valOverlayFadeOut').textContent = `${(item.fadeOut || 0).toFixed(1)}s`;
  }

  // --- AUDIO (A1/A2 or V1 clip audio) ---
  const hasAudioTarget = (sel?.type === 'audio' || (sel?.type === 'v1' && item?.kind === 'video')) && !!item;
  $('noAudioSelectedHint').classList.toggle('hidden', hasAudioTarget);
  $('audioInspectorContent').classList.toggle('hidden', !hasAudioTarget);

  if (hasAudioTarget) {
    const isAudioClip = sel.type === 'audio';
    $('audioSelectedName').textContent = isAudioClip ? `${item.track}: ${item.name}` : `V1 Audio: ${item.name}`;
    $('chkAudioMuted').checked = !!item.muted || (!isAudioClip && !!item.audioDetached);
    $('btnAudioDetachFromPanel').classList.toggle('hidden', isAudioClip || !!item.audioDetached);
    $('inputAudioVolume').value = Math.round((item.volume ?? 1) * 100);
    $('valAudioVolume').textContent = `${Math.round((item.volume ?? 1) * 100)}%`;

    const fi = isAudioClip ? (item.fadeIn || 0) : (item.audioFadeIn || 0);
    const fo = isAudioClip ? (item.fadeOut || 0) : (item.audioFadeOut || 0);
    $('inputAudioFadeIn').value = fi;
    $('valAudioFadeIn').textContent = `${fi.toFixed(1)}s`;
    $('inputAudioFadeOut').value = fo;
    $('valAudioFadeOut').textContent = `${fo.toFixed(1)}s`;

    $('audioTrackRow').style.display = isAudioClip ? 'grid' : 'none';
    if (isAudioClip) {
      document.querySelectorAll('#audioTrackSwitch .chip').forEach(b => {
        b.classList.toggle('active', b.dataset.track === item.track);
      });
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ============================================================================
 * Smart Export Modal Controller (Section 4)
 * ============================================================================ */
function openExportModal() {
  setPlaying(false);
  setMobileDrawer(false);
  $('exportModal').classList.remove('hidden');
  $('exportConfigView').classList.remove('hidden');
  $('exportProgressView').classList.add('hidden');
  $('exportResultView').classList.add('hidden');
  syncExportModalUI();
}

function closeExportModal() {
  $('exportModal').classList.add('hidden');
  const vp = $('resultVideoPlayer');
  const ap = $('resultAudioPlayer');
  if (vp) vp.pause();
  if (ap) ap.pause();
}

function syncExportModalUI() {
  const s = store.exportSettings;
  const isAudioMode = s.mode === 'audio';

  document.querySelectorAll('#exportModeSwitch .mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === s.mode);
  });
  $('videoExportOptions').classList.toggle('hidden', isAudioMode);
  $('audioOnlyOptions').classList.toggle('hidden', !isAudioMode);

  // Auto-disable AAC when container is WebM
  const isWebm = s.container === 'webm';
  $('btnCodecAac').disabled = isWebm;
  if (isWebm && s.videoAudioCodec === 'aac') s.videoAudioCodec = 'opus';

  // Show Opus panel when Opus is active
  const showOpus = isAudioMode
    ? (s.audioOnlyFormat === 'opus' || s.audioOnlyFormat === 'ogg')
    : (s.videoAudioCodec === 'opus');
  $('opusSettingsPanel').classList.toggle('hidden', !showOpus);

  document.querySelectorAll('#compressionPresetGroup .preset-card').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === s.preset);
  });
  document.querySelectorAll('#exportResGroup .chip').forEach(b => {
    b.classList.toggle('active', b.dataset.res === s.resolution);
  });
  document.querySelectorAll('#exportContainerGroup .chip').forEach(b => {
    b.classList.toggle('active', b.dataset.container === s.container);
  });
  document.querySelectorAll('#exportVideoAudioCodecGroup .chip').forEach(b => {
    b.classList.toggle('active', b.dataset.acodec === s.videoAudioCodec);
  });
  document.querySelectorAll('#audioOnlyFormatGroup .chip').forEach(b => {
    b.classList.toggle('active', b.dataset.aformat === s.audioOnlyFormat);
  });
  document.querySelectorAll('#opusModeGroup .chip').forEach(b => {
    b.classList.toggle('active', b.dataset.opusMode === s.opus.bitrateMode);
  });
  document.querySelectorAll('#opusChannelsGroup .chip').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.channels) === s.opus.channels);
  });

  $('chkGpuAccel').checked = s.gpuAcceleration;
  $('selectOpusProfile').value = s.opus.profile;
  $('inputOpusBitrate').value = s.opus.bitrate;
  $('valOpusBitrate').textContent = `${s.opus.bitrate} kbps`;
  $('selectOpusSampleRate').value = String(s.opus.sampleRate);

  // Live Pre-Export Summary Strip
  const plan = store.computeExportPlan();
  if (isAudioMode) {
    $('sumResolution').textContent = `${(plan.opus.sampleRate / 1000).toFixed(0)}kHz • ${plan.opus.channels === 2 ? 'Stereo' : 'Mono'}`;
    $('sumBitrate').textContent = 'Audio Only';
    $('sumAudio').textContent = plan.audioLabel;
    $('sumFormat').textContent = `.${plan.audioOnlyFormat.toUpperCase()}`;
  } else {
    $('sumResolution').textContent = `${plan.outW}×${plan.outH} • ${plan.fps}fps`;
    $('sumBitrate').textContent = `${(plan.targetVideoBps / 1_000_000).toFixed(2)} Mbps`;
    $('sumAudio').textContent = plan.audioLabel;
    $('sumFormat').textContent = plan.container === 'webm' ? 'WebM (VP9)' : plan.container === 'mkv' ? 'MKV (H.264)' : 'MP4 (H.264)';
  }

  let estText = `~${formatBytes(plan.estBytes)}`;
  if (plan.origTotalBytes > 0) {
    const savedPct = Math.round((1 - plan.estBytes / plan.origTotalBytes) * 100);
    estText += savedPct > 0 ? ` (-${savedPct}%)` : ` (orig ${formatBytes(plan.origTotalBytes)})`;
  }
  $('sumEstSize').textContent = estText;
}

async function runExport() {
  const plan = store.computeExportPlan();
  const baseName = ($('inputExportFilename').value || 'pulsecut-export').trim().replace(/[^a-zA-Z0-9_\-\u0600-\u06FF ]/g, '') || 'pulsecut-export';

  $('exportConfigView').classList.add('hidden');
  $('exportResultView').classList.add('hidden');
  $('exportProgressView').classList.remove('hidden');
  $('renderPercent').textContent = '0%';
  $('renderProgressBar').style.width = '0%';
  $('renderStatusText').textContent = 'Starting render pipeline...';
  $('renderTelemetry').textContent = 'Initializing...';

  try {
    const res = await exportEngine.exportProject(plan, ({ pct, status, telemetry }) => {
      $('renderPercent').textContent = `${clamp(pct, 0, 100)}%`;
      $('renderProgressBar').style.width = `${clamp(pct, 0, 100)}%`;
      if (status) $('renderStatusText').textContent = status;
      if (telemetry) $('renderTelemetry').textContent = telemetry;
    });

    if (lastExportUrl) {
      try { URL.revokeObjectURL(lastExportUrl); } catch (_) {}
    }
    lastExportBlob = res.blob;
    lastExportUrl = URL.createObjectURL(res.blob);
    lastExportFilename = `${baseName}.${res.ext}`;

    // Populate Post-Export Verification Screen
    const origBytes = plan.origTotalBytes;
    const outBytes = res.blob.size;
    $('resOrigSize').textContent = origBytes > 0 ? formatBytes(origBytes) : '—';
    $('resOutSize').textContent = formatBytes(outBytes);
    if (origBytes > 0) {
      const saved = ((1 - outBytes / origBytes) * 100).toFixed(1);
      $('resSavedPct').textContent = Number(saved) >= 0 ? `${saved}%` : `+${Math.abs(Number(saved))}%`;
    } else {
      $('resSavedPct').textContent = '—';
    }
    $('resSpeedBadge').textContent = `${res.speedMultiplier.toFixed(1)}x • ${res.engineLabel}`;

    const vp = $('resultVideoPlayer');
    const ap = $('resultAudioPlayer');
    if (plan.mode === 'audio') {
      vp.classList.add('hidden');
      vp.removeAttribute('src');
      ap.classList.remove('hidden');
      ap.src = lastExportUrl;
    } else {
      ap.classList.add('hidden');
      ap.removeAttribute('src');
      vp.classList.remove('hidden');
      vp.src = lastExportUrl;
    }

    $('exportProgressView').classList.add('hidden');
    $('exportResultView').classList.remove('hidden');
    toast('Export completed', 'success');
  } catch (err) {
    console.error('[Export failed]', err);
    $('exportProgressView').classList.add('hidden');
    $('exportConfigView').classList.remove('hidden');
    if (err.message !== 'Export cancelled') {
      toast(`Export error: ${err.message}`, 'error', 5000);
    } else {
      toast('Export cancelled', 'info');
    }
  }
}

/* ============================================================================
 * Event Wiring
 * ============================================================================ */
function wireEvents() {
  store.subscribe((reason) => syncUI(reason));

  // Tabs (Desktop switch / Mobile Bottom Sheet toggle)
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      if (isMobileLayout()) {
        const panel = $('inspectorPanel');
        const isOpen = panel.classList.contains('mobile-open');
        if (isOpen && store.ui.activeTab === targetTab) {
          setMobileDrawer(false);
        } else {
          switchTab(targetTab, { openDrawer: true });
        }
      } else {
        switchTab(targetTab);
      }
    });
  });

  $('btnCloseMobileDrawer').addEventListener('click', () => setMobileDrawer(false));

  // Top Bar
  $('btnImportMedia').addEventListener('click', () => $('fileInputMedia').click());
  $('btnAddMediaBin').addEventListener('click', () => $('fileInputMedia').click());
  $('btnStageDropClick').addEventListener('click', () => $('fileInputMedia').click());
  $('fileInputMedia').addEventListener('change', (e) => {
    handleImportFiles(e.target.files, 'auto');
    e.target.value = '';
  });

  $('btnNewProject').addEventListener('click', () => {
    if (store.project.v1Clips.length === 0 && store.project.audioClips.length === 0) return;
    if (confirm('Clear current project and start fresh?')) {
      setPlaying(false);
      store.resetProject();
      toast('Started new project', 'info');
    }
  });

  $('btnUndo').addEventListener('click', () => store.undo());
  $('btnRedo').addEventListener('click', () => store.redo());
  $('btnOpenExport').addEventListener('click', openExportModal);

  // Drag & Drop on Stage
  const dz = $('stageDropZone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', (e) => { if (e.target === dz) dz.classList.remove('drag-over'); });
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) handleImportFiles(e.dataTransfer.files, 'auto');
  });

  // Playback Controls
  $('btnPlayPause').addEventListener('click', () => setPlaying(!store.ui.isPlaying));
  $('btnStepBack').addEventListener('click', () => stepFrames(-1));
  $('btnStepForward').addEventListener('click', () => stepFrames(1));
  $('btnJumpStart').addEventListener('click', () => { setPlaying(false); seekTo(0); });
  $('btnJumpEnd').addEventListener('click', () => { setPlaying(false); seekTo(store.getTotalDuration()); });

  // Canvas & Meme Top Bar Controls
  $('aspectPresetGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    store.pushHistory();
    store.project.aspectRatio = btn.dataset.aspect;
    store.emit('canvas');
  });

  $('bgModeGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    store.pushHistory();
    store.project.bgMode = btn.dataset.bg;
    store.emit('canvas');
  });

  document.querySelectorAll('#solidBgControls .swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      store.pushHistory();
      store.project.bgColor = sw.dataset.color;
      store.emit('canvas');
    });
  });
  $('inputBgColor').addEventListener('input', (e) => {
    store.project.bgColor = e.target.value;
    store.emit('canvas');
  });

  $('inputMemeCaption').addEventListener('input', (e) => {
    store.project.memeBar.caption = e.target.value;
    stage.render();
  });
  $('memeThemeGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    store.pushHistory();
    store.project.memeBar.theme = btn.dataset.memeTheme;
    store.emit('canvas');
  });
  $('inputMemeBarHeight').addEventListener('input', (e) => {
    store.project.memeBar.heightPct = Number(e.target.value);
    $('valMemeBarHeight').textContent = `${e.target.value}%`;
    stage.render();
  });
  $('inputMemeFontSize').addEventListener('input', (e) => {
    store.project.memeBar.fontSize = Number(e.target.value);
    $('valMemeFontSize').textContent = `${e.target.value}px`;
    stage.render();
  });
  $('selectMemeFont').addEventListener('change', (e) => {
    store.project.memeBar.font = e.target.value;
    stage.render();
  });
  $('selectMemeDir').addEventListener('change', (e) => {
    store.project.memeBar.dir = e.target.value;
    stage.render();
  });

  // Clip (V1) Controls
  $('btnClipSplit').addEventListener('click', splitAtPlayhead);
  $('btnClipFreeze').addEventListener('click', insertFreezeFrame);
  $('btnClipDuplicate').addEventListener('click', duplicateSelected);
  $('btnClipDetachAudio').addEventListener('click', () => {
    if (store.ui.selected?.type === 'v1') detachAudioFromClip(store.getSelectedItem());
  });
  $('inputFreezeDuration').addEventListener('input', (e) => {
    store.ui.freezeDuration = parseFloat(e.target.value);
    $('valFreezeDuration').textContent = `${store.ui.freezeDuration.toFixed(1)}s`;
  });
  $('inputImageDuration').addEventListener('input', (e) => {
    const item = store.getSelectedItem();
    if (store.ui.selected?.type !== 'v1' || !item) return;
    item.duration = parseFloat(e.target.value);
    store.repackV1(store.ui.ripple);
    store.emit('clip-duration');
  });

  $('speedPresetGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    const item = store.getSelectedItem();
    if (!btn || store.ui.selected?.type !== 'v1' || !item) return;
    store.pushHistory();
    item.speed = parseFloat(btn.dataset.speed);
    store.repackV1(store.ui.ripple);
    store.emit('clip-speed');
  });

  $('btnToggleCropMode').addEventListener('click', () => {
    if (store.ui.selected?.type !== 'v1') return;
    store.ui.cropMode = !store.ui.cropMode;
    if (store.ui.cropMode && isMobileLayout()) setMobileDrawer(false);
    store.emit('crop-mode');
  });
  $('btnDoneCrop').addEventListener('click', () => {
    store.ui.cropMode = false;
    store.emit('crop-mode');
  });
  $('cropAspectGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    store.ui.cropAspect = btn.dataset.cropAspect;
    document.querySelectorAll('#cropAspectGroup .chip').forEach(b => b.classList.toggle('active', b === btn));
    const item = store.getSelectedItem();
    if (store.ui.selected?.type === 'v1' && item && store.ui.cropAspect !== 'free') {
      store.pushHistory();
      applyCropAspectPreset(item, store.ui.cropAspect);
      store.emit('crop');
    }
  });
  $('btnResetCrop').addEventListener('click', () => {
    const item = store.getSelectedItem();
    if (store.ui.selected?.type !== 'v1' || !item) return;
    store.pushHistory();
    item.crop = { x: 0, y: 0, w: 1, h: 1 };
    store.emit('crop');
  });

  $('btnRotateCCW').addEventListener('click', () => mutateV1Transform(tr => { tr.rotation = ((tr.rotation || 0) - 90 + 360) % 360; }));
  $('btnRotateCW').addEventListener('click', () => mutateV1Transform(tr => { tr.rotation = ((tr.rotation || 0) + 90) % 360; }));
  $('btnFlipH').addEventListener('click', () => mutateV1Transform(tr => { tr.flipH = !tr.flipH; }));
  $('btnFlipV').addEventListener('click', () => mutateV1Transform(tr => { tr.flipV = !tr.flipV; }));

  $('inputClipScale').addEventListener('input', (e) => mutateV1Transform(tr => { tr.scale = parseFloat(e.target.value); }, false));
  $('inputClipPanX').addEventListener('input', (e) => mutateV1Transform(tr => { tr.panX = parseFloat(e.target.value); }, false));
  $('inputClipPanY').addEventListener('input', (e) => mutateV1Transform(tr => { tr.panY = parseFloat(e.target.value); }, false));

  $('inputClipFadeIn').addEventListener('input', (e) => {
    const item = store.getSelectedItem();
    if (store.ui.selected?.type !== 'v1' || !item) return;
    item.fadeIn = parseFloat(e.target.value);
    store.emit('clip-transition');
  });
  $('inputClipFadeOut').addEventListener('input', (e) => {
    const item = store.getSelectedItem();
    if (store.ui.selected?.type !== 'v1' || !item) return;
    item.fadeOut = parseFloat(e.target.value);
    store.emit('clip-transition');
  });
  $('inputClipCrossfade').addEventListener('input', (e) => {
    const item = store.getSelectedItem();
    if (store.ui.selected?.type !== 'v1' || !item) return;
    item.crossfade = parseFloat(e.target.value);
    store.repackV1(true);
    store.emit('clip-transition');
  });

  // Filters Controls
  $('filterPresetGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    const item = store.getSelectedItem();
    if (!btn || store.ui.selected?.type !== 'v1' || !item) return;
    store.pushHistory();
    const key = btn.dataset.filter;
    item.filterPreset = key;
    item.filters = { ...FILTER_PRESETS[key] };
    store.emit('filter');
  });
  ['Brightness', 'Contrast', 'Saturation'].forEach(prop => {
    const key = prop.toLowerCase();
    $(`inputFilter${prop}`).addEventListener('input', (e) => {
      const item = store.getSelectedItem();
      if (store.ui.selected?.type !== 'v1' || !item) return;
      item.filters[key] = Number(e.target.value);
      $(`valFilter${prop}`).textContent = `${e.target.value}%`;
      stage.render();
    });
  });
  $('btnResetFilters').addEventListener('click', () => {
    const item = store.getSelectedItem();
    if (store.ui.selected?.type !== 'v1' || !item) return;
    store.pushHistory();
    item.filterPreset = 'normal';
    item.filters = { ...FILTER_PRESETS.normal };
    store.emit('filter');
  });

  // Overlays (V2) Controls
  $('btnAddTextOverlay').addEventListener('click', () => {
    store.pushHistory();
    const dur = Math.min(3.5, Math.max(1.5, store.getTotalDuration() - store.ui.currentTime || 3));
    const ov = createV2Overlay('text', store.ui.currentTime, dur);
    store.project.v2Overlays.push(ov);
    store.select('v2', ov.id);
    store.emit('add-overlay');
  });
  $('btnAddImageOverlay').addEventListener('click', () => $('fileInputOverlayImage').click());
  $('fileInputOverlayImage').addEventListener('change', (e) => {
    handleImportFiles(e.target.files, 'overlay-image');
    e.target.value = '';
  });
  $('btnAddPipOverlay').addEventListener('click', () => $('fileInputOverlayVideo').click());
  $('fileInputOverlayVideo').addEventListener('change', (e) => {
    handleImportFiles(e.target.files, 'overlay-pip');
    e.target.value = '';
  });
  $('btnAddCensorOverlay').addEventListener('click', () => {
    store.pushHistory();
    const dur = Math.min(3.5, Math.max(1.5, store.getTotalDuration() - store.ui.currentTime || 3));
    const ov = createV2Overlay('censor', store.ui.currentTime, dur);
    store.project.v2Overlays.push(ov);
    store.select('v2', ov.id);
    store.emit('add-overlay');
  });

  $('emojiPickerGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.emoji-btn');
    if (!btn) return;
    store.pushHistory();
    const dur = Math.min(3, Math.max(1.5, store.getTotalDuration() - store.ui.currentTime || 3));
    const ov = createV2Overlay('emoji', store.ui.currentTime, dur, { emoji: btn.dataset.emoji });
    store.project.v2Overlays.push(ov);
    store.select('v2', ov.id);
    store.emit('add-overlay');
  });

  const bindOv = (id, ev, fn) => {
    $(id).addEventListener(ev, (e) => {
      const ov = store.getSelectedItem();
      if (store.ui.selected?.type !== 'v2' || !ov) return;
      fn(ov, e);
      stage.render();
      timeline.render();
    });
  };
  bindOv('inputOverlayText', 'input', (ov, e) => { ov.text = e.target.value; });
  bindOv('selectOverlayFont', 'change', (ov, e) => { ov.font = e.target.value; });
  bindOv('selectOverlayDir', 'change', (ov, e) => { ov.dir = e.target.value; });
  bindOv('inputOverlayFontSize', 'input', (ov, e) => { ov.fontSize = Number(e.target.value); $('valOverlayFontSize').textContent = `${ov.fontSize}px`; });
  bindOv('inputOverlayColor', 'input', (ov, e) => { ov.color = e.target.value; });
  bindOv('inputOverlayStrokeColor', 'input', (ov, e) => { ov.strokeColor = e.target.value; });
  bindOv('inputOverlayStrokeWidth', 'input', (ov, e) => { ov.strokeWidth = Number(e.target.value); $('valOverlayStrokeWidth').textContent = `${ov.strokeWidth}px`; });
  bindOv('inputOverlayBgColor', 'input', (ov, e) => { ov.bgColor = e.target.value; });
  bindOv('chkOverlayShadow', 'change', (ov, e) => { ov.shadow = e.target.checked; });
  bindOv('chkOverlayBgPill', 'change', (ov, e) => { ov.bgPill = e.target.checked; });
  bindOv('chkOverlayUppercase', 'change', (ov, e) => { ov.uppercase = e.target.checked; });

  bindOv('chkChromaEnabled', 'change', (ov, e) => { ov.chromaKey.enabled = e.target.checked; });
  bindOv('inputChromaColor', 'input', (ov, e) => { ov.chromaKey.color = e.target.value; });
  bindOv('inputChromaTolerance', 'input', (ov, e) => { ov.chromaKey.tolerance = Number(e.target.value); $('valChromaTolerance').textContent = `${ov.chromaKey.tolerance}`; });
  bindOv('inputChromaSmooth', 'input', (ov, e) => { ov.chromaKey.smooth = Number(e.target.value); $('valChromaSmooth').textContent = `${ov.chromaKey.smooth}`; });
  bindOv('inputPipVolume', 'input', (ov, e) => { ov.volume = Number(e.target.value) / 100; $('valPipVolume').textContent = `${e.target.value}%`; });

  $('censorModeGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    const ov = store.getSelectedItem();
    if (!btn || store.ui.selected?.type !== 'v2' || !ov) return;
    ov.censorMode = btn.dataset.censor;
    store.emit('censor');
  });
  bindOv('inputCensorStrength', 'input', (ov, e) => { ov.strength = Number(e.target.value); $('valCensorStrength').textContent = `${ov.strength}`; });
  bindOv('inputCensorColor', 'input', (ov, e) => { ov.color = e.target.value; });

  bindOv('inputOverlayOpacity', 'input', (ov, e) => { ov.opacity = Number(e.target.value) / 100; $('valOverlayOpacity').textContent = `${e.target.value}%`; });
  bindOv('inputOverlayRotation', 'input', (ov, e) => { ov.rotation = Number(e.target.value); $('valOverlayRotation').textContent = `${e.target.value}°`; });
  bindOv('inputOverlayFadeIn', 'input', (ov, e) => { ov.fadeIn = parseFloat(e.target.value); $('valOverlayFadeIn').textContent = `${ov.fadeIn.toFixed(1)}s`; });
  bindOv('inputOverlayFadeOut', 'input', (ov, e) => { ov.fadeOut = parseFloat(e.target.value); $('valOverlayFadeOut').textContent = `${ov.fadeOut.toFixed(1)}s`; });

  $('btnOverlayCenter').addEventListener('click', () => {
    const ov = store.getSelectedItem();
    if (store.ui.selected?.type !== 'v2' || !ov) return;
    store.pushHistory();
    ov.x = 0.5;
    ov.y = 0.5;
    ov.rotation = 0;
    store.emit('overlay-center');
  });
  $('btnOverlayDelete').addEventListener('click', deleteSelected);

  // Audio Controls
  $('btnAddAudioA1').addEventListener('click', () => { pendingAudioTargetTrack = 'A1'; pendingAudioReplaceMode = false; $('fileInputAudio').click(); });
  $('btnAddAudioA2').addEventListener('click', () => { pendingAudioTargetTrack = 'A2'; pendingAudioReplaceMode = false; $('fileInputAudio').click(); });
  $('btnReplaceMainAudio').addEventListener('click', () => { pendingAudioTargetTrack = 'A1'; pendingAudioReplaceMode = true; $('fileInputAudio').click(); });
  $('fileInputAudio').addEventListener('change', (e) => {
    handleImportFiles(e.target.files, 'audio');
    e.target.value = '';
  });

  $('chkAudioMuted').addEventListener('change', (e) => {
    const item = store.getSelectedItem();
    if (!item) return;
    store.pushHistory();
    item.muted = e.target.checked;
    store.emit('audio-mute');
  });
  $('btnAudioDetachFromPanel').addEventListener('click', () => {
    if (store.ui.selected?.type === 'v1') detachAudioFromClip(store.getSelectedItem());
  });
  $('inputAudioVolume').addEventListener('input', (e) => {
    const item = store.getSelectedItem();
    if (!item) return;
    item.volume = Number(e.target.value) / 100;
    $('valAudioVolume').textContent = `${e.target.value}%`;
    timeline.render();
  });
  $('inputAudioFadeIn').addEventListener('input', (e) => {
    const item = store.getSelectedItem();
    if (!item) return;
    const v = parseFloat(e.target.value);
    if (store.ui.selected?.type === 'audio') item.fadeIn = v;
    else item.audioFadeIn = v;
    $('valAudioFadeIn').textContent = `${v.toFixed(1)}s`;
    timeline.render();
  });
  $('inputAudioFadeOut').addEventListener('input', (e) => {
    const item = store.getSelectedItem();
    if (!item) return;
    const v = parseFloat(e.target.value);
    if (store.ui.selected?.type === 'audio') item.fadeOut = v;
    else item.audioFadeOut = v;
    $('valAudioFadeOut').textContent = `${v.toFixed(1)}s`;
    timeline.render();
  });
  $('audioTrackSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    const item = store.getSelectedItem();
    if (!btn || store.ui.selected?.type !== 'audio' || !item) return;
    store.pushHistory();
    item.track = btn.dataset.track;
    store.emit('audio-track');
  });

  // Timeline Toolbar
  $('btnTlSplit').addEventListener('click', splitAtPlayhead);
  $('btnTlFreeze').addEventListener('click', insertFreezeFrame);
  $('btnTlDuplicate').addEventListener('click', duplicateSelected);
  $('btnTlDetach').addEventListener('click', () => {
    const clip = store.ui.selected?.type === 'v1'
      ? store.getSelectedItem()
      : store.project.v1Clips.find(c => store.ui.currentTime >= c.startTime && store.ui.currentTime <= c.startTime + store.getClipDuration(c));
    detachAudioFromClip(clip);
  });
  $('btnTlDelete').addEventListener('click', deleteSelected);
  $('chkRipple').addEventListener('change', (e) => { store.ui.ripple = e.target.checked; });
  $('chkSnap').addEventListener('change', (e) => { store.ui.snap = e.target.checked; });

  $('inputTimelineZoom').addEventListener('input', (e) => {
    store.ui.zoom = Number(e.target.value);
    timeline.render();
  });
  $('btnZoomOut').addEventListener('click', () => {
    store.ui.zoom = clamp(store.ui.zoom - 20, 20, 240);
    $('inputTimelineZoom').value = store.ui.zoom;
    timeline.render();
  });
  $('btnZoomIn').addEventListener('click', () => {
    store.ui.zoom = clamp(store.ui.zoom + 20, 20, 240);
    $('inputTimelineZoom').value = store.ui.zoom;
    timeline.render();
  });
  $('btnZoomFit').addEventListener('click', () => {
    const total = Math.max(2, store.getTotalDuration());
    const availW = Math.max(300, $('timelineScroll').clientWidth - 40);
    store.ui.zoom = clamp(Math.round(availW / total), 20, 240);
    $('inputTimelineZoom').value = store.ui.zoom;
    timeline.render();
  });

  // Export Modal Wiring
  $('btnCloseExport').addEventListener('click', closeExportModal);
  $('exportModeSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    store.exportSettings.mode = btn.dataset.mode;
    syncExportModalUI();
  });
  $('compressionPresetGroup').addEventListener('click', (e) => {
    const card = e.target.closest('.preset-card');
    if (!card) return;
    const preset = card.dataset.preset;
    store.exportSettings.preset = preset;
    // Apply preset's recommended short-side cap automatically
    const cfg = COMPRESSION_PRESETS[preset];
    if (cfg.maxShortSide === 720) store.exportSettings.resolution = '720';
    else if (cfg.maxShortSide === 480) store.exportSettings.resolution = '480';
    else store.exportSettings.resolution = 'original';
    syncExportModalUI();
  });
  $('exportResGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    store.exportSettings.resolution = btn.dataset.res;
    syncExportModalUI();
  });
  $('exportContainerGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    store.exportSettings.container = btn.dataset.container;
    syncExportModalUI();
  });
  $('exportVideoAudioCodecGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn || btn.disabled) return;
    store.exportSettings.videoAudioCodec = btn.dataset.acodec;
    syncExportModalUI();
  });
  $('chkGpuAccel').addEventListener('change', (e) => {
    store.exportSettings.gpuAcceleration = e.target.checked;
    syncExportModalUI();
  });
  $('audioOnlyFormatGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    store.exportSettings.audioOnlyFormat = btn.dataset.aformat;
    syncExportModalUI();
  });
  $('selectOpusProfile').addEventListener('change', (e) => {
    store.exportSettings.opus.profile = e.target.value;
    syncExportModalUI();
  });
  $('opusModeGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    store.exportSettings.opus.bitrateMode = btn.dataset.opusMode;
    syncExportModalUI();
  });
  $('opusChannelsGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    store.exportSettings.opus.channels = Number(btn.dataset.channels);
    syncExportModalUI();
  });
  $('inputOpusBitrate').addEventListener('input', (e) => {
    store.exportSettings.opus.bitrate = Number(e.target.value);
    syncExportModalUI();
  });
  $('selectOpusSampleRate').addEventListener('change', (e) => {
    store.exportSettings.opus.sampleRate = Number(e.target.value);
    syncExportModalUI();
  });

  $('btnStartRender').addEventListener('click', runExport);
  $('btnCancelRender').addEventListener('click', () => exportEngine.cancel());
  $('btnDownloadResult').addEventListener('click', () => {
    if (!lastExportUrl) return;
    const a = document.createElement('a');
    a.href = lastExportUrl;
    a.download = lastExportFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  $('btnBackToEditor').addEventListener('click', closeExportModal);
  $('btnResultNewProject').addEventListener('click', () => {
    closeExportModal();
    store.resetProject();
    toast('Ready for a new project', 'info');
  });

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
    if (!$('exportModal').classList.contains('hidden')) {
      if (e.key === 'Escape') closeExportModal();
      return;
    }

    if (e.code === 'Space') {
      e.preventDefault();
      setPlaying(!store.ui.isPlaying);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepFrames(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepFrames(1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setPlaying(false);
      seekTo(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setPlaying(false);
      seekTo(store.getTotalDuration());
    } else if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      splitAtPlayhead();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      duplicateSelected();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      store.redo();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelected();
    }
  });

  window.addEventListener('resize', () => {
    if (!isMobileLayout()) setMobileDrawer(false);
    timeline.render();
    stage.render();
  });
}

function mutateV1Transform(fn, pushHist = true) {
  const item = store.getSelectedItem();
  if (store.ui.selected?.type !== 'v1' || !item) return;
  if (pushHist) store.pushHistory();
  if (!item.transform) item.transform = { rotation: 0, flipH: false, flipV: false, scale: 1, panX: 0, panY: 0 };
  fn(item.transform);
  store.emit('clip-transform');
}

function applyCropAspectPreset(clip, preset) {
  const asset = store.getAsset(clip.assetId);
  const srcAR = asset ? asset.width / Math.max(1, asset.height) : 16 / 9;
  const ratioMap = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, original: srcAR };
  const targetAR = ratioMap[preset];
  if (!targetAR) return;
  const rel = targetAR / srcAR;
  let w = 1, h = 1;
  if (rel > 1) {
    h = clamp(1 / rel, 0.1, 1);
  } else {
    w = clamp(rel, 0.1, 1);
  }
  clip.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/* ============================================================================
 * Bootstrap
 * ============================================================================ */
wireEvents();
syncUI('init');
startPlaybackLoop();
