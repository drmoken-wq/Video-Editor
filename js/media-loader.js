// js/media-loader.js — Unrestricted file loader, Mediabunny streaming probe & exotic format detector
import { uid } from './state.js';

let _mediabunnyPromise = null;

/** Lazy-loads Mediabunny ESM (zero build) with CDN mirror fallback */
export async function getMediabunny() {
  if (!_mediabunnyPromise) {
    _mediabunnyPromise = (async () => {
      const mirrors = [
        'https://cdn.jsdelivr.net/npm/mediabunny@1/+esm',
        'https://esm.sh/mediabunny@1',
      ];
      for (const url of mirrors) {
        try {
          const mod = await import(url);
          if (mod && mod.Input && mod.BlobSource) return mod;
        } catch (err) {
          console.warn(`[Mediabunny] CDN mirror failed (${url}):`, err?.message || err);
        }
      }
      return null;
    })();
  }
  return _mediabunnyPromise;
}

const EXOTIC_EXTENSIONS = new Set([
  'avi', 'flv', 'wmv', 'ts', 'm2ts', 'mts', 'vob', 'mpg', 'mpeg', 'rm', 'rmvb',
  '3gp', '3g2', 'asf', 'divx', 'f4v', 'ogv', 'mxf',
  'wma', 'amr', 'ac3', 'dts', 'aiff', 'aif', 'alac', 'ape', 'mpc', 'wv',
]);

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg', 'ico',
]);

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'm4a', 'ogg', 'opus', 'flac', 'aac', 'weba',
  'wma', 'amr', 'ac3', 'dts', 'aiff', 'aif', 'oga',
]);

export function getExtension(filename = '') {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : '';
}

export function classifyFile(file) {
  const mime = (file.type || '').toLowerCase();
  const ext = getExtension(file.name);
  if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'video';
}

export function isExoticFormat(file) {
  const ext = getExtension(file.name);
  return EXOTIC_EXTENSIONS.has(ext);
}

/**
 * Probes any file using streaming BlobSource (Mediabunny) + native browser fallback.
 * NEVER calls file.arrayBuffer() on video files (prevents NotFoundError / RAM crash).
 */
export async function loadMediaFile(file) {
  const kind = classifyFile(file);
  const objectUrl = URL.createObjectURL(file);
  const exotic = isExoticFormat(file);

  const asset = {
    id: uid('asset'),
    file,
    name: file.name || 'media',
    size: file.size || 0,
    mime: file.type || '',
    ext: getExtension(file.name),
    kind, // 'video' | 'image' | 'audio'
    objectUrl,
    width: 0,
    height: 0,
    duration: kind === 'image' ? 3 : 0,
    fps: 30,
    bitrate: 0,
    videoBitrate: 0,
    audioBitrate: 0,
    hasAudio: kind === 'audio',
    hasVideo: kind === 'video',
    codec: '',
    needsFfmpeg: exotic,
    canWebCodecsDecode: false,
    thumbnails: [],
    waveform: null,
    imageEl: null,
  };

  if (kind === 'image') {
    const img = await loadImageElement(objectUrl);
    asset.width = img.naturalWidth || 1080;
    asset.height = img.naturalHeight || 1080;
    asset.imageEl = img;
    asset.thumbnails = [objectUrl];
    return asset;
  }

  // 1. Streaming metadata probe via Mediabunny (reads tiny byte slices via BlobSource)
  if (!exotic) {
    try {
      const mb = await getMediabunny();
      if (mb) {
        const input = new mb.Input({
          source: new mb.BlobSource(file),
          formats: mb.ALL_FORMATS,
        });
        try {
          const dur = await input.computeDuration();
          if (Number.isFinite(dur) && dur > 0) asset.duration = dur;

          const vTrack = await input.getPrimaryVideoTrack();
          if (vTrack) {
            asset.hasVideo = true;
            asset.kind = 'video';
            asset.width = vTrack.displayWidth || vTrack.codedWidth || 0;
            asset.height = vTrack.displayHeight || vTrack.codedHeight || 0;
            asset.codec = vTrack.codec || '';
            try {
              asset.canWebCodecsDecode = await vTrack.canDecode();
            } catch (_) {
              asset.canWebCodecsDecode = false;
            }
            try {
              const stats = await vTrack.computePacketStats(120);
              if (stats?.averageBitrate > 0) asset.videoBitrate = stats.averageBitrate;
              if (stats?.averagePacketRate > 1 && stats.averagePacketRate <= 240) {
                asset.fps = stats.averagePacketRate;
              }
            } catch (_) {}
          }

          const aTrack = await input.getPrimaryAudioTrack();
          if (aTrack) {
            asset.hasAudio = true;
            if (!vTrack) asset.kind = 'audio';
            try {
              const aStats = await aTrack.computePacketStats(60);
              if (aStats?.averageBitrate > 0) asset.audioBitrate = aStats.averageBitrate;
            } catch (_) {}
          }
        } finally {
          try { input.dispose?.(); } catch (_) {}
        }
      }
    } catch (err) {
      console.warn('[MediaLoader] Mediabunny probe fallback:', err?.message || err);
    }
  }

  // 2. Native HTMLMediaElement probe fallback (streaming via ObjectURL)
  if (asset.kind === 'video') {
    const nativeMeta = await probeNativeVideo(objectUrl);
    if (nativeMeta) {
      if (!asset.width) asset.width = nativeMeta.width;
      if (!asset.height) asset.height = nativeMeta.height;
      if (!asset.duration || asset.duration <= 0) asset.duration = nativeMeta.duration;
      asset.thumbnails = nativeMeta.thumbnails;
    } else {
      // Browser cannot natively play this container/codec -> flag for FFmpeg.wasm
      asset.needsFfmpeg = true;
      if (!asset.width) asset.width = 1280;
      if (!asset.height) asset.height = 720;
      if (!asset.duration) asset.duration = 5;
    }
  } else if (asset.kind === 'audio') {
    const nativeAudio = await probeNativeAudio(objectUrl);
    if (nativeAudio) {
      if (!asset.duration || asset.duration <= 0) asset.duration = nativeAudio.duration;
    } else {
      asset.needsFfmpeg = true;
      if (!asset.duration) asset.duration = 5;
    }
    // Lightweight waveform extraction (streaming via Mediabunny or small audio file)
    asset.waveform = await extractWaveformPeaks(file, asset.duration);
  }

  // Compute overall bitrate estimate from file size & duration if Mediabunny didn't provide exact videoBitrate
  if (asset.duration > 0 && asset.size > 0) {
    asset.bitrate = Math.round((asset.size * 8) / asset.duration);
    if (!asset.videoBitrate && asset.kind === 'video') {
      asset.videoBitrate = Math.max(250_000, asset.bitrate - (asset.audioBitrate || 128_000));
    }
  }

  return asset;
}

export function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

function probeNativeVideo(objectUrl) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    let settled = false;

    const finish = (res) => {
      if (settled) return;
      settled = true;
      video.removeAttribute('src');
      video.load();
      resolve(res);
    };

    const timer = setTimeout(() => finish(null), 6000);

    video.onloadeddata = async () => {
      clearTimeout(timer);
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 5;

      // Capture lightweight timeline strip thumbnails (up to 6 frames)
      const thumbs = [];
      try {
        const count = Math.min(6, Math.max(2, Math.ceil(duration / 4)));
        const c = document.createElement('canvas');
        c.width = 96;
        c.height = Math.max(36, Math.round((96 * height) / Math.max(1, width)));
        const ctx = c.getContext('2d');
        for (let i = 0; i < count; i++) {
          const t = Math.min(Math.max(0, duration - 0.05), (i + 0.2) * (duration / count));
          await seekVideoElement(video, t, 1200);
          ctx.drawImage(video, 0, 0, c.width, c.height);
          thumbs.push(c.toDataURL('image/jpeg', 0.55));
        }
      } catch (_) {}

      finish({ width, height, duration, thumbnails: thumbs });
    };

    video.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };

    video.src = objectUrl;
  });
}

function probeNativeAudio(objectUrl) {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      audio.removeAttribute('src');
      audio.load();
      resolve(res);
    };
    const timer = setTimeout(() => finish(null), 5000);
    audio.onloadedmetadata = () => {
      clearTimeout(timer);
      finish({ duration: Number.isFinite(audio.duration) ? audio.duration : 5 });
    };
    audio.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };
    audio.src = objectUrl;
  });
}

export function seekVideoElement(video, timeSec, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!video || video.readyState < 1) { resolve(); return; }
    const target = Math.max(0, Math.min(timeSec, Math.max(0, (video.duration || timeSec) - 0.01)));
    if (Math.abs(video.currentTime - target) < 0.015) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    video.addEventListener('seeked', () => { clearTimeout(timer); finish(); }, { once: true });
    try {
      video.currentTime = target;
    } catch (_) {
      clearTimeout(timer);
      finish();
    }
  });
}

/**
 * Generates normalized peak array (0..1) for waveform display on A1/A2 without crashing RAM.
 */
export async function extractWaveformPeaks(file, duration = 5, bars = 120) {
  // Never call file.arrayBuffer() on huge files (> 45 MB)
  if (!file || file.size > 45 * 1024 * 1024) {
    return generateFallbackWaveform(bars);
  }
  try {
    const mb = await getMediabunny();
    if (mb) {
      const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      try {
        const aTrack = await input.getPrimaryAudioTrack();
        if (aTrack && await aTrack.canDecode()) {
          const sink = new mb.AudioBufferSink(aTrack);
          const peaks = new Float32Array(bars);
          const dur = Math.max(0.1, duration || (await input.computeDuration()) || 5);
          for await (const item of sink.buffers(0, Math.min(dur, 180))) {
            const buf = item.buffer;
            const ch = buf.getChannelData(0);
            const t0 = item.timestamp;
            const bDur = buf.duration;
            const startBar = Math.floor((t0 / dur) * bars);
            const endBar = Math.min(bars - 1, Math.floor(((t0 + bDur) / dur) * bars));
            for (let b = Math.max(0, startBar); b <= endBar; b++) {
              const frac = (b - startBar) / Math.max(1, endBar - startBar + 1);
              const idx = Math.floor(frac * ch.length);
              const step = Math.max(1, Math.floor(ch.length / Math.max(1, (endBar - startBar + 1) * 8)));
              let maxAbs = peaks[b];
              for (let i = idx; i < Math.min(ch.length, idx + step * 8); i += step) {
                const v = Math.abs(ch[i]);
                if (v > maxAbs) maxAbs = v;
              }
              peaks[b] = maxAbs;
            }
          }
          const maxVal = Math.max(0.05, ...peaks);
          return Array.from(peaks, v => Math.min(1, v / maxVal));
        }
      } finally {
        try { input.dispose?.(); } catch (_) {}
      }
    }
  } catch (_) {}

  // Fallback for small standalone audio files only
  if (classifyFile(file) === 'audio' && file.size <= 25 * 1024 * 1024) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      try {
        const ab = await file.arrayBuffer();
        const decoded = await ctx.decodeAudioData(ab);
        const data = decoded.getChannelData(0);
        const blockSize = Math.max(1, Math.floor(data.length / bars));
        const peaks = [];
        for (let i = 0; i < bars; i++) {
          let max = 0;
          const base = i * blockSize;
          const stride = Math.max(1, Math.floor(blockSize / 64));
          for (let j = 0; j < blockSize; j += stride) {
            const v = Math.abs(data[base + j] || 0);
            if (v > max) max = v;
          }
          peaks.push(max);
        }
        const m = Math.max(0.05, ...peaks);
        return peaks.map(v => Math.min(1, v / m));
      } finally {
        ctx.close().catch(() => {});
      }
    } catch (_) {}
  }

  return generateFallbackWaveform(bars);
}

function generateFallbackWaveform(bars = 120) {
  const out = [];
  for (let i = 0; i < bars; i++) {
    out.push(0.25 + 0.55 * Math.abs(Math.sin(i * 0.45) * Math.cos(i * 0.17)));
  }
  return out;
}
