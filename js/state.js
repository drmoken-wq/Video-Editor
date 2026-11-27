// js/state.js — Reactive central store with Undo/Redo & Smart Bitrate Calculator

let _idCounter = 1;
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${(_idCounter++).toString(36)}`;
}

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export function evenDim(v) {
  const n = Math.max(2, Math.floor(v));
  return n - (n % 2);
}

export function formatTimecode(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  const s = Math.floor(rem);
  const cs = Math.floor((rem - s) * 100);
  return `${String(mins).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx === 0 ? 0 : idx === 1 ? 1 : 2)} ${units[idx]}`;
}

export const FILTER_PRESETS = {
  normal:    { brightness: 100, contrast: 100, saturation: 100, grayscale: 0, sepia: 0, hueRotate: 0, invert: 0, blur: 0 },
  bw:        { brightness: 100, contrast: 118, saturation: 0,   grayscale: 100, sepia: 0, hueRotate: 0, invert: 0, blur: 0 },
  deepfried: { brightness: 112, contrast: 225, saturation: 280, grayscale: 0, sepia: 0, hueRotate: 0, invert: 0, blur: 0 },
  warm:      { brightness: 106, contrast: 105, saturation: 135, grayscale: 0, sepia: 32, hueRotate: -6, invert: 0, blur: 0 },
  cool:      { brightness: 100, contrast: 110, saturation: 112, grayscale: 0, sepia: 0, hueRotate: 22, invert: 0, blur: 0 },
  invert:    { brightness: 100, contrast: 100, saturation: 100, grayscale: 0, sepia: 0, hueRotate: 0, invert: 100, blur: 0 },
  blur:      { brightness: 100, contrast: 100, saturation: 100, grayscale: 0, sepia: 0, hueRotate: 0, invert: 0, blur: 6 },
};

export const COMPRESSION_PRESETS = {
  lossless: { bppFactor: 0.16,  maxShortSide: null, floorHD: 2_200_000, floorNormal: 1_400_000, floorSmall: 900_000, ceilingRatio: 1.00 },
  balanced: { bppFactor: 0.10,  maxShortSide: 720,  floorHD: 1_600_000, floorNormal: 1_050_000, floorSmall: 650_000, ceilingRatio: 0.85 },
  smallest: { bppFactor: 0.065, maxShortSide: 480,  floorHD: 900_000,   floorNormal: 650_000,   floorSmall: 480_000, ceilingRatio: 0.75 },
};

export function createDefaultExportSettings() {
  return {
    mode: 'video',          // 'video' | 'audio'
    preset: 'balanced',     // 'lossless' | 'balanced' | 'smallest'
    resolution: '720',      // 'original' | '1080' | '720' | '480'
    container: 'mp4',       // 'mp4' | 'webm' | 'mkv'
    videoAudioCodec: 'opus',// 'opus' | 'aac'
    gpuAcceleration: true,
    audioOnlyFormat: 'opus',// 'opus' | 'ogg' | 'mp3' | 'm4a' | 'wav'
    opus: {
      profile: 'audio',     // 'audio' | 'voip' | 'lowdelay'
      bitrate: 48,          // kbps (16..320)
      bitrateMode: 'constant', // 'constant' (CBR) | 'variable' (VBR)
      sampleRate: 48000,    // 8000|12000|16000|24000|48000
      channels: 2,          // 2 (Stereo) | 1 (Mono)
    },
    filename: 'pulsecut-export',
  };
}

export function createInitialProject() {
  return {
    aspectRatio: 'original', // 'original' | '9:16' | '16:9' | '1:1' | '4:5'
    bgMode: 'blur',          // 'blur' | 'solid' | 'fill' | 'meme-bar'
    bgColor: '#000000',
    memeBar: {
      caption: '',
      theme: 'light',        // 'light' | 'dark'
      heightPct: 22,
      fontSize: 36,
      font: 'cairo',         // 'cairo' | 'sans' | 'impact'
      dir: 'auto',           // 'auto' | 'ltr' | 'rtl'
    },
    v1Clips: [],
    v2Overlays: [],
    audioClips: [],          // track: 'A1' | 'A2'
  };
}

class Store {
  constructor() {
    /** @type {Map<string, object>} Non-serialized runtime media assets (File, ObjectURL, thumbnails, waveform, metadata) */
    this.assets = new Map();
    this.project = createInitialProject();
    this.exportSettings = createDefaultExportSettings();

    // Ephemeral UI/playback state (not stored in undo history)
    this.ui = {
      currentTime: 0,
      isPlaying: false,
      zoom: 70, // px per second
      ripple: true,
      snap: true,
      cropMode: false,
      cropAspect: 'free',
      freezeDuration: 2.0,
      activeTab: 'canvas',
      selected: null, // { type: 'v1' | 'v2' | 'audio', id: string } | null
    };

    this._undoStack = [];
    this._redoStack = [];
    this._maxHistory = 50;
    this._listeners = new Set();
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit(reason = 'update') {
    for (const fn of this._listeners) {
      try { fn(reason, this); } catch (err) { console.error('[Store listener error]', err); }
    }
  }

  _snapshot() {
    return JSON.stringify(this.project);
  }

  pushHistory() {
    this._undoStack.push(this._snapshot());
    if (this._undoStack.length > this._maxHistory) this._undoStack.shift();
    this._redoStack.length = 0;
  }

  canUndo() { return this._undoStack.length > 0; }
  canRedo() { return this._redoStack.length > 0; }

  undo() {
    if (!this.canUndo()) return false;
    this._redoStack.push(this._snapshot());
    this.project = JSON.parse(this._undoStack.pop());
    this._validateSelection();
    this.emit('history');
    return true;
  }

  redo() {
    if (!this.canRedo()) return false;
    this._undoStack.push(this._snapshot());
    this.project = JSON.parse(this._redoStack.pop());
    this._validateSelection();
    this.emit('history');
    return true;
  }

  _validateSelection() {
    const sel = this.ui.selected;
    if (!sel) return;
    if (sel.type === 'v1' && !this.project.v1Clips.some(c => c.id === sel.id)) this.ui.selected = null;
    if (sel.type === 'v2' && !this.project.v2Overlays.some(o => o.id === sel.id)) this.ui.selected = null;
    if (sel.type === 'audio' && !this.project.audioClips.some(a => a.id === sel.id)) this.ui.selected = null;
  }

  registerAsset(asset) {
    this.assets.set(asset.id, asset);
    this.emit('assets');
  }

  getAsset(assetId) {
    return this.assets.get(assetId) || null;
  }

  getSelectedItem() {
    const sel = this.ui.selected;
    if (!sel) return null;
    if (sel.type === 'v1') return this.project.v1Clips.find(c => c.id === sel.id) || null;
    if (sel.type === 'v2') return this.project.v2Overlays.find(o => o.id === sel.id) || null;
    if (sel.type === 'audio') return this.project.audioClips.find(a => a.id === sel.id) || null;
    return null;
  }

  select(type, id) {
    if (!type || !id) {
      this.ui.selected = null;
      this.ui.cropMode = false;
    } else {
      this.ui.selected = { type, id };
      if (type !== 'v1') this.ui.cropMode = false;
    }
    this.emit('selection');
  }

  getClipDuration(clip) {
    if (!clip) return 0;
    if (clip.kind === 'image' || clip.kind === 'freeze') {
      return Math.max(0.2, clip.duration || 3);
    }
    const raw = Math.max(0.1, (clip.trimEnd ?? clip.sourceDuration ?? 3) - (clip.trimStart ?? 0));
    return raw / Math.max(0.25, clip.speed || 1);
  }

  /** Recompute sequential startTime on V1 when Ripple is active or clips are reordered */
  repackV1(closeGaps = true) {
    if (!closeGaps) return;
    let cursor = 0;
    for (const clip of this.project.v1Clips) {
      const cf = Math.min(clip.crossfade || 0, cursor > 0 ? cursor * 0.45 : 0);
      clip.startTime = Math.max(0, cursor - cf);
      cursor = clip.startTime + this.getClipDuration(clip);
    }
  }

  getTotalDuration() {
    let maxT = 0;
    for (const c of this.project.v1Clips) {
      maxT = Math.max(maxT, (c.startTime || 0) + this.getClipDuration(c));
    }
    for (const o of this.project.v2Overlays) {
      maxT = Math.max(maxT, o.endTime || 0);
    }
    for (const a of this.project.audioClips) {
      maxT = Math.max(maxT, (a.startTime || 0) + this.getClipDuration(a));
    }
    return maxT;
  }

  getPrimaryVideoAsset() {
    for (const clip of this.project.v1Clips) {
      const asset = this.assets.get(clip.assetId);
      if (asset && (asset.kind === 'video' || asset.kind === 'image')) return asset;
    }
    return null;
  }

  getPrimaryVideoClip() {
    return this.project.v1Clips[0] || null;
  }

  /**
   * Computes exact base canvas resolution (always even pixels) based on project Aspect Ratio
   * and primary source media dimensions.
   */
  getCanvasDimensions() {
    const primary = this.getPrimaryVideoAsset();
    const primaryClip = this.getPrimaryVideoClip();
    let srcW = primary?.width || 1280;
    let srcH = primary?.height || 720;

    // Account for 90/270 deg rotation & crop of primary clip if aspectRatio === 'original'
    if (primaryClip && this.project.aspectRatio === 'original') {
      const rot = ((primaryClip.transform?.rotation || 0) % 360 + 360) % 360;
      if (rot === 90 || rot === 270) {
        [srcW, srcH] = [srcH, srcW];
      }
      if (primaryClip.crop) {
        srcW = Math.max(16, Math.round(srcW * primaryClip.crop.w));
        srcH = Math.max(16, Math.round(srcH * primaryClip.crop.h));
      }
      return { width: evenDim(srcW), height: evenDim(srcH) };
    }

    const baseLong = Math.max(srcW, srcH, 1080);
    const cappedLong = Math.min(baseLong, 1920);
    const ratioMap = {
      '9:16': [9, 16],
      '16:9': [16, 9],
      '1:1':  [1, 1],
      '4:5':  [4, 5],
    };
    const pair = ratioMap[this.project.aspectRatio];
    if (!pair) return { width: evenDim(srcW), height: evenDim(srcH) };
    const [rw, rh] = pair;
    if (rw >= rh) {
      const w = Math.min(1920, Math.max(720, cappedLong));
      const h = (w * rh) / rw;
      return { width: evenDim(w), height: evenDim(h) };
    } else {
      const h = Math.min(1920, Math.max(720, cappedLong));
      const w = (h * rw) / rh;
      return { width: evenDim(w), height: evenDim(h) };
    }
  }

  /**
   * Anti-Bloat Smart Bitrate & Resolution Calculator (Section 4B)
   */
  computeExportPlan() {
    const s = this.exportSettings;
    const duration = Math.max(0.1, this.getTotalDuration());
    const baseDims = this.getCanvasDimensions();
    const primaryAsset = this.getPrimaryVideoAsset();

    // Determine effective short-side cap (never upscales!)
    const presetCfg = COMPRESSION_PRESETS[s.preset] || COMPRESSION_PRESETS.balanced;
    let resCap = s.resolution === 'original' ? null : parseInt(s.resolution, 10);
    // Preset may also suggest a cap when user selected that preset, respected via exportSettings.resolution
    const shortSide = Math.min(baseDims.width, baseDims.height);
    let scale = 1;
    if (resCap && shortSide > resCap) {
      scale = resCap / shortSide;
    }
    const outW = evenDim(baseDims.width * scale);
    const outH = evenDim(baseDims.height * scale);
    const outShort = Math.min(outW, outH);

    // FPS from primary video (clamped 24..60, default 30)
    const fps = primaryAsset?.fps ? clamp(Math.round(primaryAsset.fps), 24, 60) : 30;

    // Smart BPP Bitrate with resolution-aware visual quality floor
    let targetVideoBps = outW * outH * fps * presetCfg.bppFactor;
    const floor = outShort <= 480
      ? presetCfg.floorSmall
      : (outShort >= 1000 ? presetCfg.floorHD : presetCfg.floorNormal);
    targetVideoBps = Math.max(floor, targetVideoBps);

    // Anti-Bloat Ceiling for high-bitrate camera sources, while protecting already-small
    // social videos from being crushed into blocky low-bitrate mush on mobile GPU encoders.
    const origW = primaryAsset?.width || outW;
    const origH = primaryAsset?.height || outH;
    const origBitrate = primaryAsset?.videoBitrate || primaryAsset?.bitrate || 0;
    if (origBitrate > 0) {
      const areaRatio = (outW * outH) / Math.max(1, origW * origH);
      const ceiling = origBitrate * areaRatio * (presetCfg.ceilingRatio ?? 0.85);
      const safeCeiling = Math.max(floor, ceiling);
      targetVideoBps = Math.min(targetVideoBps, safeCeiling);
    }

    // Hard clamp [450 kbps, 20 Mbps]
    targetVideoBps = clamp(Math.round(targetVideoBps), 450_000, 20_000_000);

    // Audio bitrate calculation
    let audioBps = 48_000;
    let audioLabel = '';
    if (s.mode === 'audio') {
      if (s.audioOnlyFormat === 'wav') {
        audioBps = s.opus.sampleRate * s.opus.channels * 16;
        audioLabel = `PCM 16-bit ${(s.opus.sampleRate / 1000).toFixed(0)}kHz ${s.opus.channels === 2 ? 'Stereo' : 'Mono'}`;
      } else if (s.audioOnlyFormat === 'mp3') {
        audioBps = 128_000;
        audioLabel = `MP3 128k ${s.opus.channels === 2 ? 'Stereo' : 'Mono'}`;
      } else if (s.audioOnlyFormat === 'm4a') {
        audioBps = 128_000;
        audioLabel = `AAC 128k ${s.opus.channels === 2 ? 'Stereo' : 'Mono'}`;
      } else {
        audioBps = s.opus.bitrate * 1000;
        audioLabel = `Opus ${s.opus.bitrate}k ${s.opus.bitrateMode === 'constant' ? 'CBR' : 'VBR'}`;
      }
    } else {
      const codec = s.container === 'webm' ? 'opus' : s.videoAudioCodec;
      if (codec === 'aac') {
        audioBps = 128_000;
        audioLabel = 'AAC 128k Stereo';
      } else {
        audioBps = s.opus.bitrate * 1000;
        audioLabel = `Opus ${s.opus.bitrate}k ${s.opus.bitrateMode === 'constant' ? 'CBR' : 'VBR'}`;
      }
    }

    const totalBps = s.mode === 'audio' ? audioBps : (targetVideoBps + audioBps);
    const estBytes = Math.round((totalBps / 8) * duration * 1.03); // ~3% container overhead

    // Sum original unique source sizes used in timeline
    const usedIds = new Set([
      ...this.project.v1Clips.map(c => c.assetId),
      ...this.project.v2Overlays.filter(o => o.assetId).map(o => o.assetId),
      ...this.project.audioClips.map(a => a.assetId),
    ]);
    let origTotalBytes = 0;
    for (const id of usedIds) {
      const asset = this.assets.get(id);
      if (asset?.size) origTotalBytes += asset.size;
    }

    return {
      mode: s.mode,
      outW,
      outH,
      fps,
      duration,
      targetVideoBps,
      audioBps,
      audioLabel,
      estBytes,
      origTotalBytes,
      container: s.container,
      videoAudioCodec: s.container === 'webm' ? 'opus' : s.videoAudioCodec,
      audioOnlyFormat: s.audioOnlyFormat,
      gpuAcceleration: s.gpuAcceleration,
      opus: { ...s.opus },
    };
  }

  resetProject() {
    // Revoke object URLs safely
    for (const asset of this.assets.values()) {
      if (asset.objectUrl) {
        try { URL.revokeObjectURL(asset.objectUrl); } catch (_) {}
      }
    }
    this.assets.clear();
    this.project = createInitialProject();
    this.ui.currentTime = 0;
    this.ui.isPlaying = false;
    this.ui.selected = null;
    this.ui.cropMode = false;
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this.emit('reset');
  }
}

export const store = new Store();

// Helper factory for new V1 video/image clip
export function createV1Clip(asset, startTime = 0) {
  const isImage = asset.kind === 'image';
  return {
    id: uid('v1'),
    assetId: asset.id,
    name: asset.name,
    kind: isImage ? 'image' : 'video',
    startTime,
    sourceDuration: isImage ? 3 : Math.max(0.2, asset.duration || 5),
    duration: isImage ? 3 : undefined,
    trimStart: 0,
    trimEnd: isImage ? 3 : Math.max(0.2, asset.duration || 5),
    speed: 1,
    volume: 1,
    muted: false,
    audioDetached: false,
    audioFadeIn: 0,
    audioFadeOut: 0,
    fadeIn: 0,
    fadeOut: 0,
    crossfade: 0,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    transform: { rotation: 0, flipH: false, flipV: false, scale: 1, panX: 0, panY: 0 },
    filterPreset: 'normal',
    filters: { ...FILTER_PRESETS.normal },
  };
}

// Helper factory for V2 overlays
export function createV2Overlay(type, startTime, duration = 3, extra = {}) {
  const base = {
    id: uid('v2'),
    type, // 'text' | 'image' | 'emoji' | 'pip' | 'censor'
    name: extra.name || (type === 'text' ? 'Caption' : type === 'censor' ? 'Blur Box' : type === 'pip' ? 'PiP Video' : 'Sticker'),
    startTime: Math.max(0, startTime),
    endTime: Math.max(0.4, startTime + duration),
    x: 0.5,
    y: type === 'text' ? 0.82 : 0.5,
    w: type === 'text' ? 0.82 : type === 'censor' ? 0.28 : 0.32,
    h: type === 'text' ? 0.16 : type === 'censor' ? 0.14 : 0.32,
    rotation: 0,
    opacity: 1,
    fadeIn: 0,
    fadeOut: 0,
  };

  if (type === 'text') {
    return {
      ...base,
      text: extra.text || 'TOP TEXT / نص هنا',
      font: 'impact', // 'impact' | 'sans' | 'cairo'
      dir: 'auto',    // 'auto' | 'ltr' | 'rtl'
      fontSize: 54,
      color: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 6,
      shadow: true,
      bgPill: false,
      bgColor: '#000000',
      uppercase: false,
    };
  }
  if (type === 'emoji') {
    return {
      ...base,
      emoji: extra.emoji || '😂',
      w: 0.22,
      h: 0.22,
      name: `Sticker ${extra.emoji || '😂'}`,
    };
  }
  if (type === 'image') {
    return {
      ...base,
      assetId: extra.assetId,
      aspect: extra.aspect || 1,
    };
  }
  if (type === 'pip') {
    return {
      ...base,
      assetId: extra.assetId,
      trimStart: 0,
      sourceDuration: extra.duration || duration,
      volume: 1,
      chromaKey: { enabled: false, color: '#00ff00', tolerance: 48, smooth: 14 },
    };
  }
  if (type === 'censor') {
    return {
      ...base,
      censorMode: 'pixelate', // 'pixelate' | 'blur' | 'solid'
      strength: 14,
      color: '#000000',
    };
  }
  return base;
}

// Helper factory for A1 / A2 audio clips
export function createAudioClip(asset, track = 'A1', startTime = 0, overrides = {}) {
  const dur = Math.max(0.2, asset.duration || 5);
  return {
    id: uid('aud'),
    assetId: asset.id,
    name: asset.name,
    track, // 'A1' | 'A2'
    startTime: Math.max(0, startTime),
    sourceDuration: dur,
    trimStart: 0,
    trimEnd: dur,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    ...overrides,
  };
}
