// js/canvas-stage.js — Shared WYSIWYG Canvas Compositor + Interactive Overlay/Crop Stage
import { store, clamp } from './state.js';
import { seekVideoElement } from './media-loader.js';

const ARABIC_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export function detectTextDirection(text, mode = 'auto') {
  if (mode === 'rtl' || mode === 'ltr') return mode;
  return ARABIC_REGEX.test(text || '') ? 'rtl' : 'ltr';
}

export function resolveFontFamily(key) {
  if (key === 'impact') return 'Impact, "Anton", "Arial Black", sans-serif';
  if (key === 'cairo') return '"Cairo", "Segoe UI", Tahoma, sans-serif';
  return '"Inter", system-ui, -apple-system, sans-serif';
}

export function buildFilterString(filters) {
  if (!filters) return 'none';
  const parts = [];
  if (filters.brightness != null && filters.brightness !== 100) parts.push(`brightness(${filters.brightness}%)`);
  if (filters.contrast != null && filters.contrast !== 100) parts.push(`contrast(${filters.contrast}%)`);
  if (filters.saturation != null && filters.saturation !== 100) parts.push(`saturate(${filters.saturation}%)`);
  if (filters.grayscale) parts.push(`grayscale(${filters.grayscale}%)`);
  if (filters.sepia) parts.push(`sepia(${filters.sepia}%)`);
  if (filters.hueRotate) parts.push(`hue-rotate(${filters.hueRotate}deg)`);
  if (filters.invert) parts.push(`invert(${filters.invert}%)`);
  if (filters.blur) parts.push(`blur(${filters.blur}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

function hexToRgb(hex = '#00ff00') {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const n = parseInt(full, 16) || 0x00ff00;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Reusable scratch canvas for Chroma Key & Pixelate (works in Window and Worker-safe fallback)
let _chromaCanvas = null;
let _chromaCtx = null;
let _pixelCanvas = null;
let _pixelCtx = null;

function getScratch(kind, w, h) {
  const cw = Math.max(2, Math.min(960, Math.round(w)));
  const ch = Math.max(2, Math.min(960, Math.round(h)));
  if (kind === 'chroma') {
    if (!_chromaCanvas) {
      _chromaCanvas = document.createElement('canvas');
      _chromaCtx = _chromaCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (_chromaCanvas.width !== cw || _chromaCanvas.height !== ch) {
      _chromaCanvas.width = cw;
      _chromaCanvas.height = ch;
    }
    return { canvas: _chromaCanvas, ctx: _chromaCtx, w: cw, h: ch };
  }
  if (!_pixelCanvas) {
    _pixelCanvas = document.createElement('canvas');
    _pixelCtx = _pixelCanvas.getContext('2d');
  }
  if (_pixelCanvas.width !== cw || _pixelCanvas.height !== ch) {
    _pixelCanvas.width = cw;
    _pixelCanvas.height = ch;
  }
  return { canvas: _pixelCanvas, ctx: _pixelCtx, w: cw, h: ch };
}

function getDrawableSize(src) {
  if (!src) return { w: 0, h: 0 };
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth || 0, h: src.videoHeight || 0 };
  if (src instanceof HTMLImageElement) return { w: src.naturalWidth || src.width || 0, h: src.naturalHeight || src.height || 0 };
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) {
    return { w: src.displayWidth || src.codedWidth || 0, h: src.displayHeight || src.codedHeight || 0 };
  }
  return { w: src.width || 0, h: src.height || 0 };
}

function wrapTextLines(ctx, text, maxWidth) {
  const paragraphs = String(text || '').split('\n');
  const lines = [];
  for (const para of paragraphs) {
    if (!para.trim()) {
      lines.push('');
      continue;
    }
    const words = para.split(/\s+/);
    let current = words[0] || '';
    for (let i = 1; i < words.length; i++) {
      const test = `${current} ${words[i]}`;
      if (ctx.measureText(test).width <= maxWidth) {
        current = test;
      } else {
        lines.push(current);
        current = words[i];
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * Draws a single V1 clip into the designated media rect (rx, ry, rw, rh).
 */
function drawV1Clip(ctx, clip, src, W, H, rx, ry, rw, rh, project, alpha = 1) {
  const { w: sw, h: sh } = getDrawableSize(src);
  if (!sw || !sh) return;

  const crop = clip.crop || { x: 0, y: 0, w: 1, h: 1 };
  const sx = clamp(crop.x, 0, 0.98) * sw;
  const sy = clamp(crop.y, 0, 0.98) * sh;
  const cw = Math.max(2, clamp(crop.w, 0.02, 1 - crop.x) * sw);
  const ch = Math.max(2, clamp(crop.h, 0.02, 1 - crop.y) * sh);

  const tr = clip.transform || { rotation: 0, flipH: false, flipV: false, scale: 1, panX: 0, panY: 0 };
  const rotDeg = ((tr.rotation || 0) % 360 + 360) % 360;
  const swapped = rotDeg === 90 || rotDeg === 270;
  const effW = swapped ? ch : cw;
  const effH = swapped ? cw : ch;

  const filterStr = buildFilterString(clip.filters);

  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);

  // Clip to media viewport rect
  ctx.beginPath();
  ctx.rect(rx, ry, rw, rh);
  ctx.clip();

  // 1. Background Mode
  if (project.bgMode === 'blur') {
    const coverScale = Math.max(rw / effW, rh / effH) * 1.12;
    const bw = cw * coverScale;
    const bh = ch * coverScale;
    ctx.save();
    ctx.filter = `blur(${Math.round(Math.max(W, H) * 0.024)}px) brightness(0.58) saturate(1.15)`;
    ctx.translate(rx + rw / 2, ry + rh / 2);
    ctx.rotate((rotDeg * Math.PI) / 180);
    ctx.scale(tr.flipH ? -1 : 1, tr.flipV ? -1 : 1);
    ctx.drawImage(src, sx, sy, cw, ch, -bw / 2, -bh / 2, bw, bh);
    ctx.restore();
  } else if (project.bgMode === 'solid') {
    ctx.fillStyle = project.bgColor || '#000000';
    ctx.fillRect(rx, ry, rw, rh);
  } else if (project.bgMode === 'meme-bar') {
    ctx.fillStyle = project.memeBar?.theme === 'dark' ? '#111827' : '#ffffff';
    ctx.fillRect(rx, ry, rw, rh);
  }

  // 2. Main Foreground Video/Image
  const fitScale = project.bgMode === 'fill'
    ? Math.max(rw / effW, rh / effH)
    : Math.min(rw / effW, rh / effH);

  const finalScale = fitScale * (tr.scale || 1);
  const drawW = cw * finalScale;
  const drawH = ch * finalScale;
  const cx = rx + rw / 2 + (tr.panX || 0) * rw;
  const cy = ry + rh / 2 + (tr.panY || 0) * rh;

  ctx.save();
  ctx.filter = filterStr;
  ctx.translate(cx, cy);
  ctx.rotate((rotDeg * Math.PI) / 180);
  ctx.scale(tr.flipH ? -1 : 1, tr.flipV ? -1 : 1);
  ctx.drawImage(src, sx, sy, cw, ch, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  ctx.restore();
}

/**
 * Draws the Classic Meme Top Bar header above the video with auto-fitted RTL/LTR caption.
 */
function drawMemeTopBar(ctx, W, H, memeBar) {
  const barH = Math.round(H * clamp((memeBar?.heightPct ?? 22) / 100, 0.1, 0.45));
  const isDark = memeBar?.theme === 'dark';

  ctx.save();
  ctx.fillStyle = isDark ? '#111827' : '#ffffff';
  ctx.fillRect(0, 0, W, barH);

  const text = (memeBar?.caption || '').trim();
  if (text) {
    const scaleFactor = W / 720;
    const fontSize = Math.max(16, Math.round((memeBar?.fontSize || 36) * scaleFactor));
    const fontFamily = resolveFontFamily(memeBar?.font || 'cairo');
    const dir = detectTextDirection(text, memeBar?.dir || 'auto');

    ctx.direction = dir;
    ctx.font = `800 ${fontSize}px ${fontFamily}`;
    ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxTextW = W * 0.9;
    const lines = wrapTextLines(ctx, text, maxTextW);
    const lineH = fontSize * 1.24;
    const totalTextH = lines.length * lineH;
    const startY = barH / 2 - totalTextH / 2 + lineH / 2;

    lines.forEach((line, i) => {
      ctx.fillText(line, W / 2, startY + i * lineH, maxTextW);
    });
  }
  ctx.restore();
  return barH;
}

/**
 * Draws a single timed V2 overlay item.
 */
function drawOverlay(ctx, ov, W, H, timeSec, mediaProvider) {
  if (timeSec < ov.startTime || timeSec > ov.endTime) return;
  const dur = Math.max(0.05, ov.endTime - ov.startTime);
  const relT = timeSec - ov.startTime;

  let alpha = clamp(ov.opacity ?? 1, 0, 1);
  if (ov.fadeIn > 0 && relT < ov.fadeIn) {
    alpha *= clamp(relT / ov.fadeIn, 0, 1);
  }
  if (ov.fadeOut > 0 && dur - relT < ov.fadeOut) {
    alpha *= clamp((dur - relT) / ov.fadeOut, 0, 1);
  }
  if (alpha <= 0.005) return;

  const cx = ov.x * W;
  const cy = ov.y * H;
  const bw = Math.max(12, ov.w * W);
  const bh = Math.max(12, ov.h * H);
  const rotRad = ((ov.rotation || 0) * Math.PI) / 180;

  ctx.save();
  ctx.globalAlpha = alpha;

  // Special handling for censor/blur box (reads existing canvas pixels before transform)
  if (ov.type === 'censor') {
    const x0 = clamp(Math.round(cx - bw / 2), 0, W - 2);
    const y0 = clamp(Math.round(cy - bh / 2), 0, H - 2);
    const cw = clamp(Math.round(bw), 2, W - x0);
    const ch = clamp(Math.round(bh), 2, H - y0);

    if (ov.censorMode === 'solid') {
      ctx.translate(cx, cy);
      ctx.rotate(rotRad);
      ctx.fillStyle = ov.color || '#000000';
      ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
    } else if (ov.censorMode === 'blur') {
      const scratch = getScratch('pixel', cw, ch);
      scratch.ctx.clearRect(0, 0, cw, ch);
      scratch.ctx.drawImage(ctx.canvas, x0, y0, cw, ch, 0, 0, cw, ch);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, cw, ch);
      ctx.clip();
      ctx.filter = `blur(${Math.max(4, Math.round((ov.strength || 14) * (W / 720)))}px)`;
      ctx.drawImage(scratch.canvas, 0, 0, cw, ch, x0 - 8, y0 - 8, cw + 16, ch + 16);
      ctx.restore();
    } else {
      // Pixelate
      const block = Math.max(4, Math.round((ov.strength || 14) * (W / 720)));
      const pw = Math.max(2, Math.round(cw / block));
      const ph = Math.max(2, Math.round(ch / block));
      const scratch = getScratch('pixel', pw, ph);
      scratch.ctx.imageSmoothingEnabled = true;
      scratch.ctx.clearRect(0, 0, pw, ph);
      scratch.ctx.drawImage(ctx.canvas, x0, y0, cw, ch, 0, 0, pw, ph);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(scratch.canvas, 0, 0, pw, ph, x0, y0, cw, ch);
      ctx.imageSmoothingEnabled = true;
    }
    ctx.restore();
    return;
  }

  ctx.translate(cx, cy);
  ctx.rotate(rotRad);

  if (ov.type === 'text') {
    const rawText = ov.uppercase ? String(ov.text || '').toUpperCase() : String(ov.text || '');
    const scaleFactor = W / 720;
    const fontSize = Math.max(12, Math.round((ov.fontSize || 54) * scaleFactor));
    const fontFamily = resolveFontFamily(ov.font || 'impact');
    const dir = detectTextDirection(rawText, ov.dir || 'auto');

    ctx.direction = dir;
    ctx.font = `800 ${fontSize}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxW = Math.max(40, bw);
    const lines = wrapTextLines(ctx, rawText, maxW);
    const lineH = fontSize * 1.18;
    const totalH = lines.length * lineH;

    // Optional rounded background pill/box
    if (ov.bgPill && rawText.trim()) {
      let maxLineW = 0;
      for (const l of lines) maxLineW = Math.max(maxLineW, ctx.measureText(l).width);
      const padX = fontSize * 0.48;
      const padY = fontSize * 0.28;
      const pillW = Math.min(maxW + padX * 2, maxLineW + padX * 2);
      const pillH = totalH + padY * 2;
      const rad = Math.min(18 * scaleFactor, pillH / 2);

      ctx.save();
      ctx.fillStyle = ov.bgColor || '#000000';
      ctx.globalAlpha = alpha * 0.78;
      roundRectPath(ctx, -pillW / 2, -pillH / 2, pillW, pillH, rad);
      ctx.fill();
      ctx.restore();
    }

    if (ov.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = Math.max(4, fontSize * 0.16);
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = Math.max(2, fontSize * 0.06);
    }

    const strokeW = Math.max(0, (ov.strokeWidth || 0) * scaleFactor);
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    const startY = -totalH / 2 + lineH / 2;
    lines.forEach((line, i) => {
      const ly = startY + i * lineH;
      if (strokeW > 0) {
        ctx.strokeStyle = ov.strokeColor || '#000000';
        ctx.lineWidth = strokeW * 2;
        ctx.strokeText(line, 0, ly);
      }
      ctx.fillStyle = ov.color || '#ffffff';
      ctx.fillText(line, 0, ly);
    });
  } else if (ov.type === 'emoji') {
    const size = Math.min(bw, bh) * 0.9;
    ctx.font = `${Math.round(size)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ov.emoji || '😂', 0, 0);
  } else if (ov.type === 'image') {
    const img = mediaProvider.getOverlayMedia(ov, timeSec);
    if (img) {
      const { w: iw, h: ih } = getDrawableSize(img);
      if (iw && ih) {
        const s = Math.min(bw / iw, bh / ih);
        ctx.drawImage(img, -(iw * s) / 2, -(ih * s) / 2, iw * s, ih * s);
      }
    }
  } else if (ov.type === 'pip') {
    const pipSrc = mediaProvider.getOverlayMedia(ov, timeSec);
    if (pipSrc) {
      const { w: pw, h: ph } = getDrawableSize(pipSrc);
      if (pw && ph) {
        const s = Math.min(bw / pw, bh / ph);
        const dw = pw * s;
        const dh = ph * s;
        if (ov.chromaKey?.enabled) {
          const keyed = applyChromaKey(pipSrc, pw, ph, ov.chromaKey);
          ctx.drawImage(keyed, -dw / 2, -dh / 2, dw, dh);
        } else {
          ctx.drawImage(pipSrc, -dw / 2, -dh / 2, dw, dh);
        }
      }
    }
  }

  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Fast pixel-level Green Screen / Chroma Key removal on scratch canvas.
 */
function applyChromaKey(src, sw, sh, cfg) {
  const maxDim = 480;
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const kw = Math.max(2, Math.round(sw * scale));
  const kh = Math.max(2, Math.round(sh * scale));
  const { canvas, ctx } = getScratch('chroma', kw, kh);

  ctx.clearRect(0, 0, kw, kh);
  ctx.drawImage(src, 0, 0, kw, kh);
  const imgData = ctx.getImageData(0, 0, kw, kh);
  const data = imgData.data;

  const key = hexToRgb(cfg.color || '#00ff00');
  // Convert key color to Cb/Cr chroma coordinates for lighting-invariant green screen keying
  const keyCb = 128 - 0.168736 * key.r - 0.331264 * key.g + 0.5 * key.b;
  const keyCr = 128 + 0.5 * key.r - 0.418688 * key.g - 0.081312 * key.b;

  const tol = clamp(cfg.tolerance ?? 48, 4, 140);
  const smooth = Math.max(1, clamp(cfg.smooth ?? 14, 1, 60));

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    const dist = Math.hypot(cb - keyCb, cr - keyCr);

    if (dist < tol) {
      data[i + 3] = 0;
    } else if (dist < tol + smooth) {
      const f = (dist - tol) / smooth;
      data[i + 3] = Math.round(data[i + 3] * f);
      // Light green spill suppression on semi-transparent edge pixels
      if (key.g > key.r && key.g > key.b && g > Math.max(r, b)) {
        data[i + 1] = Math.round(g * f + Math.max(r, b) * (1 - f));
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/**
 * Shared WYSIWYG Frame Compositor — called identically by Preview & Export!
 */
/**
 * Returns active V1 clips at timeline timeSec using strict half-open intervals [start, end)
 * so adjacent split clips never collide, while preserving intentional crossfades.
 */
export function getActiveV1ClipsAt(timeSec, v1Clips) {
  if (!v1Clips || !v1Clips.length) return [];
  const active = [];
  const lastIdx = v1Clips.length - 1;
  const eps = 0.0005;

  for (let i = 0; i < v1Clips.length; i++) {
    const clip = v1Clips[i];
    const dur = store.getClipDuration(clip);
    const start = clip.startTime || 0;
    const end = start + dur;
    const isLast = i === lastIdx;
    const inRange = isLast
      ? (timeSec >= start - eps && timeSec <= end + eps)
      : (timeSec >= start - eps && timeSec < end - eps);

    if (inRange) {
      active.push({ clip, dur, relT: clamp(timeSec - start, 0, dur) });
    }
  }

  // Edge fallback if timeSec sits right on a cut boundary
  if (!active.length) {
    for (let i = v1Clips.length - 1; i >= 0; i--) {
      const clip = v1Clips[i];
      const dur = store.getClipDuration(clip);
      const start = clip.startTime || 0;
      if (timeSec >= start - 0.015 && timeSec <= start + dur + 0.015) {
        active.push({ clip, dur, relT: clamp(timeSec - start, 0, dur) });
        break;
      }
    }
  }

  return active;
}

export function renderCompositeFrame(ctx, W, H, timeSec, project, mediaProvider) {
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = project.bgMode === 'solid' ? (project.bgColor || '#000000') : '#000000';
  ctx.fillRect(0, 0, W, H);

  // Determine media viewport rect (accounting for Meme Top Bar if active)
  let rx = 0, ry = 0, rw = W, rh = H;
  if (project.bgMode === 'meme-bar') {
    const barH = drawMemeTopBar(ctx, W, H, project.memeBar);
    ry = barH;
    rh = Math.max(16, H - barH);
  }

  // Find active V1 clips at timeSec using strict half-open intervals [start, end)
  const activeV1 = getActiveV1ClipsAt(timeSec, project.v1Clips);

  // Draw active V1 clip(s)
  for (let idx = 0; idx < activeV1.length; idx++) {
    const { clip, dur, relT } = activeV1[idx];
    const src = mediaProvider.getV1Media(clip, timeSec);
    if (!src) continue;

    let alpha = 1;
    // Crossfade blend when a second clip overlaps the first
    if (idx > 0 && clip.crossfade > 0 && relT < clip.crossfade) {
      alpha = clamp(relT / clip.crossfade, 0, 1);
    }

    drawV1Clip(ctx, clip, src, W, H, rx, ry, rw, rh, project, alpha);

    // Fade In / Fade Out to black
    let blackFade = 0;
    if (clip.fadeIn > 0 && relT < clip.fadeIn) {
      blackFade = Math.max(blackFade, 1 - clamp(relT / clip.fadeIn, 0, 1));
    }
    if (clip.fadeOut > 0 && dur - relT < clip.fadeOut) {
      blackFade = Math.max(blackFade, 1 - clamp((dur - relT) / clip.fadeOut, 0, 1));
    }
    if (blackFade > 0.005) {
      ctx.save();
      ctx.fillStyle = `rgba(0,0,0,${blackFade.toFixed(3)})`;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.restore();
    }
  }

  // Re-draw Meme Top Bar on top if needed so text stays crisp over any edge bleed
  if (project.bgMode === 'meme-bar') {
    drawMemeTopBar(ctx, W, H, project.memeBar);
  }

  // Draw timed V2 Overlays
  for (const ov of project.v2Overlays) {
    drawOverlay(ctx, ov, W, H, timeSec, mediaProvider);
  }

  ctx.restore();
}

/**
 * Interactive Preview Stage Controller
 */
export class CanvasStage {
  constructor(canvasEl, audioEngine) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.audioEngine = audioEngine;

    /** @type {Map<string, HTMLVideoElement>} Keyed by warm asset-slot (`v1_<assetId>_0/1`) or PiP overlayId */
    this.videoPool = new Map();
    /** @type {Map<string, string>} Maps active clipId -> poolKey */
    this._activeSlotByClip = new Map();
    /** Last-good-frame hold buffer per assetId so seeking across a split/cut NEVER flashes black */
    this._lastFrameByAsset = new Map();
    this._dragState = null;
    this._snapX = false;
    this._snapY = false;

    this._bindCanvasPointerEvents();
  }

  getOrCreateVideo(poolKey, asset) {
    if (!asset || asset.kind !== 'video') return null;
    let vid = this.videoPool.get(poolKey);
    if (!vid || vid.dataset.assetId !== asset.id) {
      vid = document.createElement('video');
      vid.dataset.assetId = asset.id;
      vid.dataset.poolKey = poolKey;
      vid.playsInline = true;
      vid.setAttribute('playsinline', '');
      vid.setAttribute('webkit-playsinline', '');
      vid.preload = 'auto';
      vid.crossOrigin = 'anonymous';
      vid.muted = true;
      vid._desiredTime = null;

      const applyPending = () => {
        if (vid._desiredTime != null && vid.readyState >= 1) {
          const target = clamp(vid._desiredTime, 0, Math.max(0, (vid.duration || asset.duration || 0) - 0.02));
          if (Math.abs(vid.currentTime - target) > 0.03) {
            try { vid.currentTime = target; } catch (_) {}
          }
          vid._desiredTime = null;
        }
        this.render(store.ui.currentTime);
      };

      vid.addEventListener('loadedmetadata', applyPending);
      vid.addEventListener('loadeddata', applyPending);
      vid.addEventListener('seeked', () => this.render(store.ui.currentTime));

      vid.src = asset.objectUrl;
      vid.load();
      this.videoPool.set(poolKey, vid);
    }
    return vid;
  }

  _getV1PoolKey(clip, slotIndex = 0) {
    return `v1_${clip.assetId}_${slotIndex}`;
  }

  _seekVideoSafe(vid, targetTime, threshold = 0.03) {
    if (!vid) return;
    const maxDur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : targetTime + 1;
    const clamped = clamp(targetTime, 0, Math.max(0, maxDur - 0.02));
    if (vid.readyState < 1) {
      vid._desiredTime = clamped;
      return;
    }
    vid._desiredTime = null;
    if (!vid.seeking && Math.abs(vid.currentTime - clamped) > threshold) {
      try { vid.currentTime = clamped; } catch (_) {}
    } else if (vid.seeking && Math.abs(vid.currentTime - clamped) > Math.max(0.25, threshold * 2)) {
      try { vid.currentTime = clamped; } catch (_) {}
    }
  }

  _captureLastGoodFrame(assetId, vid) {
    if (!vid || vid.readyState < 2 || !vid.videoWidth || !vid.videoHeight) return;
    let c = this._lastFrameByAsset.get(assetId);
    const scale = Math.min(1, 720 / Math.max(vid.videoWidth, vid.videoHeight));
    const w = Math.max(2, Math.round(vid.videoWidth * scale));
    const h = Math.max(2, Math.round(vid.videoHeight * scale));
    if (!c) {
      c = document.createElement('canvas');
      this._lastFrameByAsset.set(assetId, c);
    }
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    try {
      c.getContext('2d').drawImage(vid, 0, 0, w, h);
    } catch (_) {}
  }

  cleanupUnusedVideos() {
    const usedAssets = new Set(store.project.v1Clips.filter(c => c.kind === 'video').map(c => c.assetId));
    const activePips = new Set(store.project.v2Overlays.filter(o => o.type === 'pip').map(o => o.id));

    for (const [key, vid] of this.videoPool.entries()) {
      const keep = key.startsWith('v1_')
        ? usedAssets.has(vid.dataset.assetId)
        : activePips.has(key);
      if (!keep) {
        try { vid.pause(); vid.removeAttribute('src'); vid.load(); } catch (_) {}
        this.videoPool.delete(key);
      }
    }
    for (const assetId of this._lastFrameByAsset.keys()) {
      if (!usedAssets.has(assetId)) this._lastFrameByAsset.delete(assetId);
    }
  }

  pauseAllVideos() {
    for (const vid of this.videoPool.values()) {
      if (!vid.paused) vid.pause();
    }
  }

  /** Called synchronously inside user Play gesture so mobile Chrome/Safari unlocks playback immediately */
  unlockAndPlay(timeSec) {
    this.syncVideos(timeSec, true);
    for (const poolKey of this._activeSlotByClip.values()) {
      const vid = this.videoPool.get(poolKey);
      if (vid && vid.paused) {
        vid.play().catch(() => {});
      }
    }
  }

  /** True when active V1 video is mid-seek across a cut boundary */
  isActiveVideoBuffering(timeSec) {
    const activeV1 = getActiveV1ClipsAt(timeSec, store.project.v1Clips);
    for (const { clip } of activeV1) {
      if (clip.kind !== 'video') continue;
      const poolKey = this._activeSlotByClip.get(clip.id) || this._getV1PoolKey(clip, 0);
      const vid = this.videoPool.get(poolKey);
      if (vid && (vid.seeking || vid.readyState < 2)) return true;
    }
    return false;
  }

  /** Syncs all active video elements to timeline time t (reuses warm asset videos across splits!) */
  syncVideos(timeSec, isPlaying) {
    this.cleanupUnusedVideos();

    const activeV1 = getActiveV1ClipsAt(timeSec, store.project.v1Clips);
    const activePoolKeys = new Set();
    const assetSlotUsage = new Map();
    this._activeSlotByClip.clear();

    for (const { clip, dur, relT } of activeV1) {
      if (clip.kind !== 'video') continue;
      const asset = store.getAsset(clip.assetId);
      if (!asset) continue;

      const slotIdx = assetSlotUsage.get(asset.id) || 0;
      assetSlotUsage.set(asset.id, slotIdx + 1);
      const poolKey = this._getV1PoolKey(clip, slotIdx);
      const vid = this.getOrCreateVideo(poolKey, asset);
      if (!vid) continue;

      activePoolKeys.add(poolKey);
      this._activeSlotByClip.set(clip.id, poolKey);

      const srcTime = clamp((clip.trimStart || 0) + relT * (clip.speed || 1), 0, Math.max(0, (asset.duration || dur) - 0.02));
      vid.playbackRate = clamp(clip.speed || 1, 0.25, 4);

      const shouldMute = clip.muted || clip.audioDetached || !isPlaying;
      let gainVal = shouldMute ? 0 : (clip.volume ?? 1);
      if (!shouldMute) {
        if (clip.audioFadeIn > 0 && relT < clip.audioFadeIn) {
          gainVal *= clamp(relT / clip.audioFadeIn, 0, 1);
        }
        if (clip.audioFadeOut > 0 && dur - relT < clip.audioFadeOut) {
          gainVal *= clamp((dur - relT) / clip.audioFadeOut, 0, 1);
        }
      }

      if (this.audioEngine) {
        this.audioEngine.attachMediaElement(poolKey, vid);
        vid.muted = false;
        this.audioEngine.setElementGain(poolKey, gainVal);
      } else {
        vid.muted = shouldMute;
        vid.volume = clamp(gainVal, 0, 1);
      }

      if (isPlaying) {
        this._seekVideoSafe(vid, srcTime, 0.22);
        if (vid.paused) {
          vid.play().catch(() => {});
        }
      } else {
        if (!vid.paused) vid.pause();
        this._seekVideoSafe(vid, srcTime, 0.025);
      }
    }

    // Pause inactive V1 pool videos
    for (const [key, vid] of this.videoPool.entries()) {
      if (key.startsWith('v1_') && !activePoolKeys.has(key)) {
        if (!vid.paused) vid.pause();
        if (this.audioEngine) this.audioEngine.setElementGain(key, 0);
        else vid.muted = true;
      }
    }

    // Sync V2 PiP overlays
    for (const ov of store.project.v2Overlays) {
      if (ov.type !== 'pip') continue;
      const asset = store.getAsset(ov.assetId);
      const vid = this.getOrCreateVideo(ov.id, asset);
      if (!vid) continue;

      const isActive = timeSec >= ov.startTime && timeSec < ov.endTime;
      if (!isActive) {
        if (!vid.paused) vid.pause();
        if (this.audioEngine) this.audioEngine.setElementGain(ov.id, 0);
        continue;
      }

      const relT = clamp(timeSec - ov.startTime, 0, ov.endTime - ov.startTime);
      const srcTime = (ov.trimStart || 0) + (relT % Math.max(0.1, asset.duration || 5));

      if (this.audioEngine) {
        this.audioEngine.attachMediaElement(ov.id, vid);
        vid.muted = false;
        this.audioEngine.setElementGain(ov.id, isPlaying ? (ov.volume ?? 1) : 0);
      } else {
        vid.muted = !isPlaying;
        vid.volume = clamp(ov.volume ?? 1, 0, 1);
      }

      if (isPlaying) {
        this._seekVideoSafe(vid, srcTime, 0.22);
        if (vid.paused) vid.play().catch(() => {});
      } else {
        if (!vid.paused) vid.pause();
        this._seekVideoSafe(vid, srcTime, 0.025);
      }
    }
  }

  /** Capture current video frame at playhead as PNG Blob for Freeze Frame */
  async captureFreezeFrameBlob(clip, timeSec) {
    const asset = store.getAsset(clip.assetId);
    if (!asset) return null;
    let src = null;
    if (clip.kind === 'image' || clip.kind === 'freeze') {
      src = asset.imageEl;
    } else {
      const poolKey = this._activeSlotByClip.get(clip.id) || this._getV1PoolKey(clip, 0);
      const vid = this.getOrCreateVideo(poolKey, asset);
      const dur = store.getClipDuration(clip);
      const relT = clamp(timeSec - clip.startTime, 0, dur);
      const srcTime = clamp((clip.trimStart || 0) + relT * (clip.speed || 1), 0, Math.max(0, (asset.duration || dur) - 0.02));
      await seekVideoElement(vid, srcTime, 1500);
      src = vid;
    }
    const { w, h } = getDrawableSize(src);
    if (!w || !h) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }

  /** Renders preview canvas + interactive gizmos (selection handles, center snap guides, crop box) */
  render(timeSec = store.ui.currentTime) {
    const dims = store.getCanvasDimensions();
    const previewScale = Math.min(1, 960 / Math.max(dims.width, dims.height));
    const W = Math.max(2, Math.round(dims.width * previewScale));
    const H = Math.max(2, Math.round(dims.height * previewScale));

    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }

    const mediaProvider = {
      getV1Media: (clip) => {
        const asset = store.getAsset(clip.assetId);
        if (!asset) return null;
        if (clip.kind === 'image' || clip.kind === 'freeze') return asset.imageEl;
        const poolKey = this._activeSlotByClip.get(clip.id) || this._getV1PoolKey(clip, 0);
        const vid = this.getOrCreateVideo(poolKey, asset);
        if (vid && vid.readyState >= 2 && !vid.seeking) {
          this._captureLastGoodFrame(asset.id, vid);
          return vid;
        }
        // Hold last decoded frame while seeking across a cut instead of flashing black!
        const cached = this._lastFrameByAsset.get(asset.id);
        if (cached) return cached;
        return vid && vid.readyState >= 2 ? vid : null;
      },
      getOverlayMedia: (ov) => {
        const asset = store.getAsset(ov.assetId);
        if (!asset) return null;
        if (ov.type === 'image') return asset.imageEl;
        if (ov.type === 'pip') {
          const vid = this.getOrCreateVideo(ov.id, asset);
          return vid && vid.readyState >= 2 ? vid : null;
        }
        return null;
      },
    };

    renderCompositeFrame(this.ctx, W, H, timeSec, store.project, mediaProvider);

    // Draw interactive Crop Gizmo if Crop Mode is active
    if (store.ui.cropMode && store.ui.selected?.type === 'v1') {
      const clip = store.getSelectedItem();
      if (clip) this._drawCropGizmo(this.ctx, W, H, clip);
      return;
    }

    // Draw interactive Overlay Gizmo + Snap Guides if V2 overlay is selected & visible
    if (store.ui.selected?.type === 'v2') {
      const ov = store.getSelectedItem();
      if (ov && timeSec >= ov.startTime && timeSec <= ov.endTime) {
        this._drawOverlayGizmo(this.ctx, W, H, ov);
      }
    }
  }

  _drawOverlayGizmo(ctx, W, H, ov) {
    const cx = ov.x * W;
    const cy = ov.y * H;
    const bw = ov.w * W;
    const bh = ov.h * H;
    const rotRad = ((ov.rotation || 0) * Math.PI) / 180;

    ctx.save();
    // Center snap guides
    if (this._snapX) {
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(W / 2, 0);
      ctx.lineTo(W / 2, H);
      ctx.stroke();
    }
    if (this._snapY) {
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.translate(cx, cy);
    ctx.rotate(rotRad);

    // Selection border
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2;
    ctx.strokeRect(-bw / 2, -bh / 2, bw, bh);

    // Rotation stem & handle
    ctx.beginPath();
    ctx.moveTo(0, -bh / 2);
    ctx.lineTo(0, -bh / 2 - 22);
    ctx.stroke();
    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.arc(0, -bh / 2 - 24, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#0b1120';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 4 Corner resize handles
    const corners = [
      [-bw / 2, -bh / 2],
      [bw / 2, -bh / 2],
      [bw / 2, bh / 2],
      [-bw / 2, bh / 2],
    ];
    for (const [hx, hy] of corners) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2;
      ctx.fillRect(hx - 5, hy - 5, 10, 10);
      ctx.strokeRect(hx - 5, hy - 5, 10, 10);
    }
    ctx.restore();
  }

  _drawCropGizmo(ctx, W, H, clip) {
    const c = clip.crop || { x: 0, y: 0, w: 1, h: 1 };
    const x = c.x * W;
    const y = c.y * H;
    const w = c.w * W;
    const h = c.h * H;

    ctx.save();
    // Dim outside area
    ctx.fillStyle = 'rgba(2, 6, 23, 0.65)';
    ctx.fillRect(0, 0, W, y);
    ctx.fillRect(0, y + h, W, H - (y + h));
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, W - (x + w), h);

    // Rule-of-thirds grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + w / 3, y); ctx.lineTo(x + w / 3, y + h);
    ctx.moveTo(x + (2 * w) / 3, y); ctx.lineTo(x + (2 * w) / 3, y + h);
    ctx.moveTo(x, y + h / 3); ctx.lineTo(x + w, y + h / 3);
    ctx.moveTo(x, y + (2 * h) / 3); ctx.lineTo(x + w, y + (2 * h) / 3);
    ctx.stroke();

    // Crop border
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x, y, w, h);

    // 8 Handles (4 corners + 4 edges)
    const pts = [
      [x, y], [x + w / 2, y], [x + w, y],
      [x + w, y + h / 2], [x + w, y + h],
      [x + w / 2, y + h], [x, y + h], [x, y + h / 2],
    ];
    for (const [hx, hy] of pts) {
      ctx.fillStyle = '#22d3ee';
      ctx.strokeStyle = '#0b1120';
      ctx.lineWidth = 2;
      ctx.fillRect(hx - 6, hy - 6, 12, 12);
      ctx.strokeRect(hx - 6, hy - 6, 12, 12);
    }
    ctx.restore();
  }

  _clientToCanvas(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / Math.max(1, rect.width);
    const scaleY = this.canvas.height / Math.max(1, rect.height);
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
      W: this.canvas.width,
      H: this.canvas.height,
    };
  }

  _bindCanvasPointerEvents() {
    this.canvas.addEventListener('pointerdown', (e) => {
      const pt = this._clientToCanvas(e);
      const isTouch = e.pointerType === 'touch';
      if (store.ui.cropMode && store.ui.selected?.type === 'v1') {
        const clip = store.getSelectedItem();
        if (!clip) return;
        const handle = this._hitTestCrop(pt, clip, isTouch);
        if (handle) {
          store.pushHistory();
          this._dragState = {
            kind: 'crop',
            handle,
            clip,
            startPt: pt,
            origCrop: { ...clip.crop },
          };
          this.canvas.setPointerCapture(e.pointerId);
        }
        return;
      }

      // Check V2 overlays top-down
      const t = store.ui.currentTime;
      const visible = store.project.v2Overlays.filter(o => t >= o.startTime && t <= o.endTime);

      // First check handles on currently selected overlay
      if (store.ui.selected?.type === 'v2') {
        const selOv = visible.find(o => o.id === store.ui.selected.id);
        if (selOv) {
          const hit = this._hitTestOverlay(pt, selOv, isTouch);
          if (hit) {
            store.pushHistory();
            this._dragState = {
              kind: 'overlay',
              mode: hit, // 'move' | 'resize' | 'rotate'
              ov: selOv,
              startPt: pt,
              orig: { x: selOv.x, y: selOv.y, w: selOv.w, h: selOv.h, rotation: selOv.rotation || 0 },
            };
            this.canvas.setPointerCapture(e.pointerId);
            return;
          }
        }
      }

      // Otherwise hit-test any visible overlay (topmost first)
      for (let i = visible.length - 1; i >= 0; i--) {
        const ov = visible[i];
        const hit = this._hitTestOverlay(pt, ov, isTouch);
        if (hit) {
          store.select('v2', ov.id);
          store.pushHistory();
          this._dragState = {
            kind: 'overlay',
            mode: 'move',
            ov,
            startPt: pt,
            orig: { x: ov.x, y: ov.y, w: ov.w, h: ov.h, rotation: ov.rotation || 0 },
          };
          this.canvas.setPointerCapture(e.pointerId);
          this.render();
          return;
        }
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this._dragState) return;
      const pt = this._clientToCanvas(e);
      const ds = this._dragState;

      if (ds.kind === 'crop') {
        this._updateCropDrag(ds, pt);
        this.render();
        store.emit('crop');
        return;
      }

      if (ds.kind === 'overlay') {
        const { ov, orig, startPt } = ds;
        if (ds.mode === 'move') {
          let nx = clamp(orig.x + (pt.x - startPt.x) / pt.W, 0.02, 0.98);
          let ny = clamp(orig.y + (pt.y - startPt.y) / pt.H, 0.02, 0.98);
          // Snap-to-center guides
          this._snapX = Math.abs(nx - 0.5) < 0.022;
          this._snapY = Math.abs(ny - 0.5) < 0.022;
          if (this._snapX) nx = 0.5;
          if (this._snapY) ny = 0.5;
          ov.x = nx;
          ov.y = ny;
        } else if (ds.mode === 'resize') {
          const cx = orig.x * pt.W;
          const cy = orig.y * pt.H;
          const startDist = Math.max(10, Math.hypot(startPt.x - cx, startPt.y - cy));
          const currDist = Math.max(10, Math.hypot(pt.x - cx, pt.y - cy));
          const ratio = currDist / startDist;
          ov.w = clamp(orig.w * ratio, 0.06, 1.4);
          ov.h = clamp(orig.h * ratio, 0.05, 1.4);
        } else if (ds.mode === 'rotate') {
          const cx = orig.x * pt.W;
          const cy = orig.y * pt.H;
          const angle = Math.atan2(pt.y - cy, pt.x - cx) * (180 / Math.PI) + 90;
          // Snap near 0, 90, -90, 180
          let deg = Math.round(angle);
          for (const snap of [0, 90, -90, 180, -180]) {
            if (Math.abs(deg - snap) < 5) deg = snap;
          }
          ov.rotation = clamp(((deg + 180) % 360 + 360) % 360 - 180, -180, 180);
        }
        this.render();
        store.emit('overlay-transform');
      }
    });

    const endDrag = () => {
      if (!this._dragState) return;
      this._dragState = null;
      this._snapX = false;
      this._snapY = false;
      this.render();
    };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);
  }

  _hitTestOverlay(pt, ov, isTouch = false) {
    const cx = ov.x * pt.W;
    const cy = ov.y * pt.H;
    const bw = ov.w * pt.W;
    const bh = ov.h * pt.H;
    const rad = -((ov.rotation || 0) * Math.PI) / 180;
    const dx = pt.x - cx;
    const dy = pt.y - cy;
    // Transform into local unrotated box coords
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
    const handleRad = isTouch ? 28 : 14;
    const pad = isTouch ? 10 : 0;

    // Rotation handle
    if (Math.hypot(lx, ly - (-bh / 2 - 24)) <= handleRad) return 'rotate';

    // Corner resize handles
    const corners = [
      [-bw / 2, -bh / 2], [bw / 2, -bh / 2],
      [bw / 2, bh / 2], [-bw / 2, bh / 2],
    ];
    for (const [hx, hy] of corners) {
      if (Math.hypot(lx - hx, ly - hy) <= handleRad) return 'resize';
    }

    if (Math.abs(lx) <= bw / 2 + pad && Math.abs(ly) <= bh / 2 + pad) return 'move';
    return null;
  }

  _hitTestCrop(pt, clip, isTouch = false) {
    const c = clip.crop || { x: 0, y: 0, w: 1, h: 1 };
    const x1 = c.x * pt.W;
    const y1 = c.y * pt.H;
    const x2 = (c.x + c.w) * pt.W;
    const y2 = (c.y + c.h) * pt.H;
    const tol = isTouch ? 30 : 16;

    const nearL = Math.abs(pt.x - x1) <= tol;
    const nearR = Math.abs(pt.x - x2) <= tol;
    const nearT = Math.abs(pt.y - y1) <= tol;
    const nearB = Math.abs(pt.y - y2) <= tol;

    if (nearL && nearT) return 'nw';
    if (nearR && nearT) return 'ne';
    if (nearR && nearB) return 'se';
    if (nearL && nearB) return 'sw';
    if (nearT && pt.x > x1 && pt.x < x2) return 'n';
    if (nearB && pt.x > x1 && pt.x < x2) return 's';
    if (nearL && pt.y > y1 && pt.y < y2) return 'w';
    if (nearR && pt.y > y1 && pt.y < y2) return 'e';
    if (pt.x > x1 && pt.x < x2 && pt.y > y1 && pt.y < y2) return 'move';
    return null;
  }

  _updateCropDrag(ds, pt) {
    const { origCrop: o, handle, startPt, clip } = ds;
    const dx = (pt.x - startPt.x) / pt.W;
    const dy = (pt.y - startPt.y) / pt.H;
    let x = o.x, y = o.y, w = o.w, h = o.h;
    const minSize = 0.08;

    if (handle === 'move') {
      x = clamp(o.x + dx, 0, 1 - o.w);
      y = clamp(o.y + dy, 0, 1 - o.h);
    } else {
      if (handle.includes('w')) {
        const nx = clamp(o.x + dx, 0, o.x + o.w - minSize);
        w = o.w + (o.x - nx);
        x = nx;
      }
      if (handle.includes('e')) {
        w = clamp(o.w + dx, minSize, 1 - o.x);
      }
      if (handle.includes('n')) {
        const ny = clamp(o.y + dy, 0, o.y + o.h - minSize);
        h = o.h + (o.y - ny);
        y = ny;
      }
      if (handle.includes('s')) {
        h = clamp(o.h + dy, minSize, 1 - o.y);
      }

      // Enforce crop aspect preset if locked
      const preset = store.ui.cropAspect;
      if (preset && preset !== 'free') {
        const ratioMap = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };
        let targetAR = ratioMap[preset];
        if (preset === 'original') {
          const asset = store.getAsset(clip.assetId);
          targetAR = asset ? asset.width / Math.max(1, asset.height) : pt.W / pt.H;
        }
        if (targetAR) {
          const canvasAR = pt.W / Math.max(1, pt.H);
          const normRatio = targetAR / canvasAR;
          h = clamp(w / normRatio, minSize, 1 - y);
          w = clamp(h * normRatio, minSize, 1 - x);
        }
      }
    }

    clip.crop = { x, y, w, h };
  }
}
