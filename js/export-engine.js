// js/export-engine.js — High-Speed Sequential GPU WebCodecs (Mediabunny) + Single-Threaded FFmpeg.wasm (Blob Worker + WORKERFS)
import { store, clamp } from './state.js';
import { getMediabunny, seekVideoElement } from './media-loader.js';
import { renderCompositeFrame, getActiveV1ClipsAt } from './canvas-stage.js';
import {
  renderOfflineAudioMix,
  encodeAudioBufferToOpusPackets,
  muxOggOpus,
  encodeAudioBufferToWav,
} from './audio-engine.js';

/* ============================================================================
 * Inline Blob Web Worker for Single-Threaded @ffmpeg/core (Zero COOP/COEP)
 * Uses WORKERFS zero-copy mount with 4 MB chunked FS.write fallback.
 * ============================================================================ */

const FFMPEG_WORKER_SOURCE = `
let core = null;

async function ensureCore(onLog) {
  if (core) return core;
  const bases = [
    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
    'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
  ];
  let lastErr = null;
  for (const base of bases) {
    try {
      importScripts(base + '/ffmpeg-core.js');
      if (typeof createFFmpegCore === 'function') {
        core = await createFFmpegCore({
          locateFile: (path) => base + '/' + path,
          print: (msg) => onLog && onLog(msg),
          printErr: (msg) => onLog && onLog(msg),
        });
        return core;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Failed to load @ffmpeg/core');
}

async function writeChunkedFallback(FS, file, destPath) {
  const CHUNK = 4 * 1024 * 1024;
  const stream = FS.open(destPath, 'w+');
  try {
    let offset = 0;
    while (offset < file.size) {
      const slice = file.slice(offset, Math.min(file.size, offset + CHUNK));
      const buf = new Uint8Array(await slice.arrayBuffer());
      FS.write(stream, buf, 0, buf.length, offset);
      offset += buf.length;
    }
  } finally {
    FS.close(stream);
  }
}

self.onmessage = async (e) => {
  const { id, files, args, outputName, duration } = e.data;
  try {
    const ffmpeg = await ensureCore((line) => {
      if (duration > 0 && typeof line === 'string') {
        const m = line.match(/time=(\\d+):(\\d+):(\\d+\\.\\d+)/);
        if (m) {
          const sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
          const pct = Math.max(0, Math.min(0.99, sec / duration));
          self.postMessage({ id, event: 'progress', progress: pct });
        }
      }
    });

    const FS = ffmpeg.FS;
    const mountDir = '/work_' + id;
    const tmpDir = '/tmp_' + id;
    try { FS.mkdir(mountDir); } catch (_) {}
    try { FS.mkdir(tmpDir); } catch (_) {}

    let usedWorkerFs = false;
    const mountedPaths = [];

    if (files && files.length > 0) {
      try {
        if (FS.filesystems && FS.filesystems.WORKERFS) {
          const blobs = files.map(f => ({ name: f.name, data: f.file }));
          FS.mount(FS.filesystems.WORKERFS, { blobs }, mountDir);
          usedWorkerFs = true;
          for (const f of files) mountedPaths.push({ alias: f.name, path: mountDir + '/' + f.name });
        }
      } catch (_) {
        usedWorkerFs = false;
      }

      if (!usedWorkerFs) {
        for (const f of files) {
          const p = tmpDir + '/' + f.name;
          await writeChunkedFallback(FS, f.file, p);
          mountedPaths.push({ alias: f.name, path: p });
        }
      }
    }

    const outPath = tmpDir + '/' + outputName;
    const resolvedArgs = args.map((a) => {
      if (a === '__OUT__') return outPath;
      for (const mp of mountedPaths) {
        if (a === '__IN:' + mp.alias + '__') return mp.path;
      }
      return a;
    });

    const exitCode = ffmpeg.exec(...resolvedArgs);
    if (exitCode !== 0) {
      throw new Error('FFmpeg exited with code ' + exitCode);
    }

    const data = FS.readFile(outPath);

    try { FS.unlink(outPath); } catch (_) {}
    if (usedWorkerFs) {
      try { FS.unmount(mountDir); } catch (_) {}
    } else {
      for (const mp of mountedPaths) {
        try { FS.unlink(mp.path); } catch (_) {}
      }
    }
    try { FS.rmdir(mountDir); } catch (_) {}
    try { FS.rmdir(tmpDir); } catch (_) {}

    const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    self.postMessage({ id, event: 'done', buffer: copy, usedWorkerFs }, [copy]);
  } catch (err) {
    self.postMessage({ id, event: 'error', error: err?.message || String(err) });
  }
};
`;

class FfmpegWorkerClient {
  constructor() {
    this.worker = null;
    this.blobUrl = null;
    this._seq = 1;
    this._pending = new Map();
  }

  _ensureWorker() {
    if (this.worker) return this.worker;
    const blob = new Blob([FFMPEG_WORKER_SOURCE], { type: 'application/javascript' });
    this.blobUrl = URL.createObjectURL(blob);
    this.worker = new Worker(this.blobUrl);
    this.worker.onmessage = (e) => {
      const msg = e.data;
      const entry = this._pending.get(msg.id);
      if (!entry) return;
      if (msg.event === 'progress') {
        entry.onProgress?.(msg.progress);
      } else if (msg.event === 'done') {
        this._pending.delete(msg.id);
        entry.resolve({ buffer: msg.buffer, usedWorkerFs: msg.usedWorkerFs });
      } else if (msg.event === 'error') {
        this._pending.delete(msg.id);
        entry.reject(new Error(msg.error));
      }
    };
    this.worker.onerror = (err) => {
      for (const [, entry] of this._pending.entries()) {
        entry.reject(new Error(err.message || 'FFmpeg worker crashed'));
      }
      this._pending.clear();
      this.terminate();
    };
    return this.worker;
  }

  run({ files = [], args = [], outputName = 'out.mp4', duration = 0, onProgress = null }) {
    const worker = this._ensureWorker();
    const id = this._seq++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, files, args, outputName, duration });
    });
  }

  terminate() {
    if (this.worker) {
      try { this.worker.terminate(); } catch (_) {}
      this.worker = null;
    }
    if (this.blobUrl) {
      try { URL.revokeObjectURL(this.blobUrl); } catch (_) {}
      this.blobUrl = null;
    }
    this._pending.clear();
  }
}

export const ffmpegWorker = new FfmpegWorkerClient();

/**
 * Transcodes exotic containers (AVI, FLV, WMV, TS, VOB, WMA, AMR, AC3, etc.)
 * into browser-compatible MP4/M4A via WORKERFS zero-copy mount.
 */
export async function transcodeExoticMedia(file, kind = 'video', onProgress = null) {
  const safeInName = 'input_' + Date.now() + '.' + ((file.name.split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, ''));
  if (kind === 'audio') {
    const { buffer } = await ffmpegWorker.run({
      files: [{ name: safeInName, file }],
      args: ['-i', `__IN:${safeInName}__`, '-c:a', 'aac', '-b:a', '128k', '-y', '__OUT__'],
      outputName: 'normalized.m4a',
      onProgress,
    });
    return new File([buffer], file.name.replace(/\.[^.]+$/, '') + '.m4a', { type: 'audio/mp4' });
  }
  const { buffer } = await ffmpegWorker.run({
    files: [{ name: safeInName, file }],
    args: [
      '-i', `__IN:${safeInName}__`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
      '-y', '__OUT__',
    ],
    outputName: 'normalized.mp4',
    onProgress,
  });
  return new File([buffer], file.name.replace(/\.[^.]+$/, '') + '.mp4', { type: 'video/mp4' });
}

/* ============================================================================
 * Single-Pass Sequential WebCodecs Sample Reader (Fixes 0.1x Mobile Speed!)
 * Decodes each source frame AT MOST ONCE in monotonic order instead of
 * random-seeking from keyframe on every single frame.
 * ============================================================================ */

class SequentialSampleReader {
  constructor(input, sink, startSrcTime, endSrcTime) {
    this.input = input;
    this.sink = sink;
    this.startSrcTime = Math.max(0, startSrcTime - 0.04);
    this.endSrcTime = Math.max(this.startSrcTime + 0.08, endSrcTime + 0.08);
    this.iterator = null;
    this.prev = null; // { sample, vf, ts }
    this.next = null; // { sample, vf, ts }
    this.done = false;
    this.lastSrcTime = -1;
  }

  _disposeEntry(entry) {
    if (!entry) return;
    if (entry.vf && entry.vf !== entry.sample) {
      try { entry.vf.close(); } catch (_) {}
    }
    try { entry.sample?.close?.(); } catch (_) {}
  }

  async _pullOne() {
    if (this.done) return null;
    if (!this.iterator) {
      const iterable = this.sink.samples(this.startSrcTime, this.endSrcTime);
      this.iterator = iterable[Symbol.asyncIterator]();
    }
    const step = await this.iterator.next();
    if (step.done || !step.value) {
      this.done = true;
      return null;
    }
    const sample = step.value;
    const ts = Number.isFinite(sample.timestamp) ? sample.timestamp : 0;
    const vf = sample.toVideoFrame ? sample.toVideoFrame() : sample;
    return { sample, vf, ts };
  }

  /**
   * Returns a drawable VideoFrame closest to monotonic `srcTime`.
   * Never closes the returned VideoFrame until superseded by a later timestamp or `close()`.
   */
  async getDrawableAt(srcTime) {
    // If PiP looped backwards, cleanly restart the sequential iterator
    if (this.lastSrcTime >= 0 && srcTime < this.lastSrcTime - 0.05) {
      await this._resetIterator(srcTime);
    }
    this.lastSrcTime = srcTime;

    if (!this.prev && !this.done) {
      this.prev = await this._pullOne();
    }
    if (!this.next && !this.done) {
      this.next = await this._pullOne();
    }

    // Advance sequentially until `next.ts >= srcTime`
    while (this.next && this.next.ts <= srcTime + 0.002) {
      this._disposeEntry(this.prev);
      this.prev = this.next;
      this.next = await this._pullOne();
    }

    if (this.prev && this.next) {
      const dPrev = Math.abs(srcTime - this.prev.ts);
      const dNext = Math.abs(this.next.ts - srcTime);
      return dNext < dPrev ? this.next.vf : this.prev.vf;
    }
    return this.prev ? this.prev.vf : (this.next ? this.next.vf : null);
  }

  async _resetIterator(newStart) {
    this._disposeEntry(this.prev);
    this._disposeEntry(this.next);
    this.prev = null;
    this.next = null;
    if (this.iterator?.return) {
      try { await this.iterator.return(); } catch (_) {}
    }
    this.iterator = null;
    this.done = false;
    this.startSrcTime = Math.max(0, newStart - 0.04);
  }

  async close() {
    this._disposeEntry(this.prev);
    this._disposeEntry(this.next);
    this.prev = null;
    this.next = null;
    if (this.iterator?.return) {
      try { await this.iterator.return(); } catch (_) {}
    }
    this.iterator = null;
    try { this.input?.dispose?.(); } catch (_) {}
    this.input = null;
  }
}

/**
 * Guaranteed-ready HTMLVideoElement fallback seeker (never skips seeking on cold videos).
 */
async function openVideoElementFallback(asset, initialTime = 0) {
  const vid = document.createElement('video');
  vid.muted = true;
  vid.playsInline = true;
  vid.preload = 'auto';
  vid.crossOrigin = 'anonymous';
  vid.src = asset.objectUrl;
  vid.load();

  await new Promise((resolve) => {
    if (vid.readyState >= 2) { resolve(); return; }
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    vid.addEventListener('loadeddata', done, { once: true });
    vid.addEventListener('canplay', done, { once: true });
    vid.addEventListener('error', done, { once: true });
    setTimeout(done, 4000);
  });

  if (initialTime > 0.01 && vid.readyState >= 1) {
    await seekVideoElement(vid, initialTime, 2000);
  }
  return vid;
}

/* ============================================================================
 * Export Engine — GPU WebCodecs (Mediabunny) + Universal FFmpeg.wasm Fallback
 * ============================================================================ */

export class ExportEngine {
  constructor() {
    this._cancelled = false;
  }

  cancel() {
    this._cancelled = true;
    ffmpegWorker.terminate();
  }

  async exportProject(plan, onProgress) {
    this._cancelled = false;
    const tStart = performance.now();

    if (plan.mode === 'audio') {
      return this._exportAudioOnly(plan, onProgress, tStart);
    }
    return this._exportVideo(plan, onProgress, tStart);
  }

  async _exportAudioOnly(plan, onProgress, tStart) {
    const fmt = plan.audioOnlyFormat || 'opus';
    const sr = plan.opus.sampleRate || 48000;
    const ch = plan.opus.channels || 2;

    onProgress?.({ pct: 8, status: 'Mixing multi-track audio offline...', telemetry: 'Engine: OfflineAudioContext' });
    const { buffer: mixedBuf } = await renderOfflineAudioMix(store.project, store.assets, {
      sampleRate: sr,
      channels: ch,
      duration: plan.duration,
    });
    if (this._cancelled) throw new Error('Export cancelled');

    if (fmt === 'wav') {
      onProgress?.({ pct: 80, status: 'Encoding 16-bit PCM WAV...', telemetry: 'Engine: Native JS' });
      const blob = encodeAudioBufferToWav(mixedBuf);
      const elapsedSec = Math.max(0.05, (performance.now() - tStart) / 1000);
      return {
        blob,
        ext: 'wav',
        mime: 'audio/wav',
        speedMultiplier: plan.duration / elapsedSec,
        engineLabel: 'Native',
      };
    }

    if (fmt === 'opus' || fmt === 'ogg') {
      try {
        onProgress?.({ pct: 45, status: `Encoding Opus (${plan.opus.bitrate}k ${plan.opus.bitrateMode === 'constant' ? 'CBR' : 'VBR'})...`, telemetry: 'Engine: WebCodecs + Ogg Muxer' });
        const { packets } = await encodeAudioBufferToOpusPackets(mixedBuf, plan.opus);
        if (this._cancelled) throw new Error('Export cancelled');
        onProgress?.({ pct: 88, status: 'Muxing RFC 7845 Ogg Opus container...', telemetry: 'Engine: Pure-JS Ogg Muxer' });
        const blob = muxOggOpus(packets, { channels: ch, sampleRate: sr });
        const elapsedSec = Math.max(0.05, (performance.now() - tStart) / 1000);
        return {
          blob,
          ext: fmt,
          mime: 'audio/ogg; codecs=opus',
          speedMultiplier: plan.duration / elapsedSec,
          engineLabel: 'WebCodecs',
        };
      } catch (err) {
        console.warn('[ExportEngine] WebCodecs Opus fallback to FFmpeg.wasm:', err?.message || err);
      }
    }

    onProgress?.({ pct: 35, status: `Encoding .${fmt} via FFmpeg.wasm...`, telemetry: 'Engine: FFmpeg.wasm Worker' });
    const wavBlob = encodeAudioBufferToWav(mixedBuf);
    const wavFile = new File([wavBlob], 'mix.wav', { type: 'audio/wav' });

    const args = ['-i', '__IN:mix.wav__'];
    let outName = `audio.${fmt}`;
    let mime = 'audio/mpeg';

    if (fmt === 'mp3') {
      args.push('-c:a', 'libmp3lame', '-b:a', '128k', '-ac', String(ch), '-ar', String(sr));
      mime = 'audio/mpeg';
    } else if (fmt === 'm4a') {
      args.push('-c:a', 'aac', '-b:a', '128k', '-ac', String(ch), '-ar', String(sr));
      mime = 'audio/mp4';
    } else {
      const appMap = { audio: 'audio', voip: 'voip', lowdelay: 'lowdelay' };
      const vbrFlag = plan.opus.bitrateMode === 'constant' ? 'off' : 'on';
      args.push(
        '-c:a', 'libopus',
        '-b:a', `${plan.opus.bitrate}k`,
        '-vbr', vbrFlag,
        '-application', appMap[plan.opus.profile] || 'audio',
        '-ac', String(ch),
        '-ar', String(sr),
        '-f', 'ogg'
      );
      mime = 'audio/ogg; codecs=opus';
    }
    args.push('-y', '__OUT__');

    const { buffer } = await ffmpegWorker.run({
      files: [{ name: 'mix.wav', file: wavFile }],
      args,
      outputName: outName,
      duration: plan.duration,
      onProgress: (p) => onProgress?.({
        pct: Math.round(35 + p * 60),
        status: `Encoding .${fmt} via FFmpeg.wasm...`,
        telemetry: 'Engine: FFmpeg.wasm Worker',
      }),
    });

    const elapsedSec = Math.max(0.05, (performance.now() - tStart) / 1000);
    return {
      blob: new Blob([buffer], { type: mime }),
      ext: fmt,
      mime,
      speedMultiplier: plan.duration / elapsedSec,
      engineLabel: 'FFmpeg',
    };
  }

  async _exportVideo(plan, onProgress, tStart) {
    onProgress?.({ pct: 4, status: 'Mixing multi-track audio...', telemetry: 'Engine: OfflineAudioContext' });
    const audioSr = plan.videoAudioCodec === 'aac' ? 48000 : (plan.opus.sampleRate || 48000);
    const audioCh = plan.videoAudioCodec === 'aac' ? 2 : (plan.opus.channels || 2);
    const audioMix = await renderOfflineAudioMix(store.project, store.assets, {
      sampleRate: audioSr,
      channels: audioCh,
      duration: plan.duration,
    });
    if (this._cancelled) throw new Error('Export cancelled');

    const mb = await getMediabunny();
    if (mb && typeof VideoEncoder !== 'undefined') {
      const hwChain = plan.gpuAcceleration
        ? ['prefer-hardware', 'no-preference', 'prefer-software']
        : ['prefer-software', 'no-preference'];

      for (const hwPref of hwChain) {
        if (this._cancelled) throw new Error('Export cancelled');
        try {
          return await this._renderWithMediabunny(mb, plan, audioMix, hwPref, onProgress, tStart);
        } catch (err) {
          if (this._cancelled) throw err;
          console.warn(`[ExportEngine] WebCodecs (${hwPref}) fallback:`, err?.message || err);
        }
      }
    }

    return this._renderFallbackFfmpeg(plan, audioMix, onProgress, tStart);
  }

  async _openClipReader(mb, asset, startSrc, endSrc) {
    if (!asset || !asset.file) return null;
    try {
      const input = new mb.Input({ source: new mb.BlobSource(asset.file), formats: mb.ALL_FORMATS });
      const vTrack = await input.getPrimaryVideoTrack();
      if (vTrack && await vTrack.canDecode()) {
        const sink = new mb.VideoSampleSink(vTrack);
        if (typeof sink.samples === 'function') {
          return {
            kind: 'stream',
            reader: new SequentialSampleReader(input, sink, startSrc, endSrc),
          };
        }
        return { kind: 'sink', input, sink };
      }
      input.dispose?.();
    } catch (err) {
      console.warn('[ExportEngine] VideoSampleSink unavailable, using video fallback:', err?.message || err);
    }

    const vid = await openVideoElementFallback(asset, startSrc);
    return { kind: 'video', vid };
  }

  async _closeClipReader(entry) {
    if (!entry) return;
    if (entry.kind === 'stream') {
      await entry.reader.close();
    } else if (entry.kind === 'sink') {
      try { entry.input?.dispose?.(); } catch (_) {}
    } else if (entry.kind === 'video') {
      try { entry.vid.pause(); entry.vid.removeAttribute('src'); entry.vid.load(); } catch (_) {}
    }
  }

  async _renderWithMediabunny(mb, plan, audioMix, hwPref, onProgress, tStart) {
    const engineTag = hwPref === 'prefer-hardware' ? 'GPU' : hwPref === 'prefer-software' ? 'SW' : 'Auto';
    const { outW, outH, fps, duration, targetVideoBps, container, videoAudioCodec, opus } = plan;

    let format;
    let videoCodec = 'avc';
    let ext = 'mp4';
    let mime = 'video/mp4';

    if (container === 'webm') {
      format = new mb.WebMOutputFormat();
      videoCodec = 'vp9';
      ext = 'webm';
      mime = 'video/webm';
    } else if (container === 'mkv') {
      format = new mb.MkvOutputFormat();
      videoCodec = 'avc';
      ext = 'mkv';
      mime = 'video/x-matroska';
    } else {
      format = new mb.Mp4OutputFormat({ fastStart: 'in-memory' });
      videoCodec = 'avc';
      ext = 'mp4';
      mime = 'video/mp4';
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

    const output = new mb.Output({
      format,
      target: new mb.BufferTarget(),
    });

    // VBR produces dramatically cleaner visual quality at the same average bitrate on mobile GPU encoders
    const videoSource = new mb.CanvasSource(canvas, {
      codec: videoCodec,
      bitrate: targetVideoBps,
      bitrateMode: 'variable',
      hardwareAcceleration: hwPref,
      keyFrameInterval: 2,
    });
    output.addVideoTrack(videoSource, { frameRate: fps });

    // Prepare audio track
    let audioSource = null;
    let useCustomOpusPackets = false;
    let encodedOpusPackets = null;

    if (audioMix.hasAudioContent && audioMix.buffer) {
      if (videoAudioCodec === 'opus') {
        if (mb.EncodedAudioPacketSource && mb.EncodedPacket) {
          try {
            encodedOpusPackets = await encodeAudioBufferToOpusPackets(audioMix.buffer, opus);
            audioSource = new mb.EncodedAudioPacketSource('opus');
            output.addAudioTrack(audioSource);
            useCustomOpusPackets = true;
          } catch (_) {
            useCustomOpusPackets = false;
          }
        }
        if (!useCustomOpusPackets) {
          audioSource = new mb.AudioBufferSource({
            codec: 'opus',
            bitrate: clamp(opus.bitrate * 1000, 16_000, 320_000),
          });
          output.addAudioTrack(audioSource);
        }
      } else {
        audioSource = new mb.AudioBufferSource({
          codec: 'aac',
          bitrate: 128_000,
        });
        output.addAudioTrack(audioSource);
      }
    }

    /** Lazy single-active-decoder pool (prevents Android MediaCodec hardware exhaustion on split clips!) */
    const activeReaders = new Map();

    try {
      await output.start();

      // Write mixed audio track first
      if (audioSource) {
        onProgress?.({ pct: 10, status: 'Writing audio track...', telemetry: `Engine: WebCodecs (${engineTag})` });
        if (useCustomOpusPackets && encodedOpusPackets) {
          const { packets, sampleRate, channels } = encodedOpusPackets;
          const desc = buildOpusHeadBytes(channels, sampleRate);
          for (let i = 0; i < packets.length; i++) {
            const p = packets[i];
            const pkt = new mb.EncodedPacket(
              p.data,
              'key',
              p.timestamp / 1_000_000,
              (p.duration || 20000) / 1_000_000
            );
            await audioSource.add(pkt, i === 0 ? {
              decoderConfig: {
                codec: 'opus',
                sampleRate,
                numberOfChannels: channels,
                description: desc,
              },
            } : undefined);
          }
        } else {
          await audioSource.add(audioMix.buffer);
        }
        audioSource.close();
      }

      const totalFrames = Math.max(1, Math.ceil(duration * fps));
      const frameDur = 1 / fps;
      const renderStartMs = performance.now();

      for (let i = 0; i < totalFrames; i++) {
        if (this._cancelled) throw new Error('Export cancelled');
        const t = Math.min(duration, i * frameDur);

        // Determine EXACT active clips at t (strict [start, end) matching preview!)
        const activeV1 = getActiveV1ClipsAt(t, store.project.v1Clips);
        const activePips = store.project.v2Overlays.filter(
          o => o.type === 'pip' && t >= o.startTime && t < o.endTime
        );

        const neededKeys = new Set([
          ...activeV1.filter(a => a.clip.kind === 'video').map(a => a.clip.id),
          ...activePips.map(o => o.id),
        ]);

        // 1. Immediately release finished clip decoders BEFORE opening the next clip!
        for (const [key, entry] of Array.from(activeReaders.entries())) {
          if (!neededKeys.has(key)) {
            await this._closeClipReader(entry);
            activeReaders.delete(key);
          }
        }

        // 2. Fetch decoded frames sequentially for active V1 & V2 PiP clips
        const tempClosers = [];
        const v1Map = new Map();
        const ovMap = new Map();

        for (const { clip, dur, relT } of activeV1) {
          const asset = store.getAsset(clip.assetId);
          if (!asset) continue;
          if (clip.kind === 'image' || clip.kind === 'freeze') {
            v1Map.set(clip.id, asset.imageEl);
            continue;
          }

          const startSrc = clip.trimStart || 0;
          const endSrc = clip.trimEnd ?? asset.duration ?? dur;
          const srcTime = clamp(startSrc + relT * (clip.speed || 1), startSrc, Math.max(startSrc, Math.min(endSrc, (asset.duration || endSrc)) - 0.015));

          let entry = activeReaders.get(clip.id);
          if (!entry) {
            entry = await this._openClipReader(mb, asset, startSrc, endSrc);
            if (entry) activeReaders.set(clip.id, entry);
          }

          if (entry) {
            const drawable = await this._readFrame(entry, srcTime, tempClosers);
            if (drawable) v1Map.set(clip.id, drawable);
          }
        }

        for (const ov of store.project.v2Overlays) {
          if (t < ov.startTime || t >= ov.endTime) continue;
          const asset = store.getAsset(ov.assetId);
          if (!asset) continue;
          if (ov.type === 'image') {
            ovMap.set(ov.id, asset.imageEl);
          } else if (ov.type === 'pip') {
            const relT = clamp(t - ov.startTime, 0, ov.endTime - ov.startTime);
            const assetDur = Math.max(0.1, asset.duration || 5);
            const srcTime = clamp((ov.trimStart || 0) + (relT % assetDur), 0, Math.max(0, assetDur - 0.015));
            let entry = activeReaders.get(ov.id);
            if (!entry) {
              entry = await this._openClipReader(mb, asset, ov.trimStart || 0, assetDur);
              if (entry) activeReaders.set(ov.id, entry);
            }
            if (entry) {
              const drawable = await this._readFrame(entry, srcTime, tempClosers);
              if (drawable) ovMap.set(ov.id, drawable);
            }
          }
        }

        // 3. Composite WYSIWYG frame onto export canvas
        renderCompositeFrame(ctx, outW, outH, t, store.project, {
          getV1Media: (clip) => v1Map.get(clip.id) || null,
          getOverlayMedia: (ov) => ovMap.get(ov.id) || null,
        });

        for (const fn of tempClosers) {
          try { fn(); } catch (_) {}
        }

        await videoSource.add(t, frameDur);

        if (i % 5 === 0 || i === totalFrames - 1) {
          const pct = Math.round(12 + ((i + 1) / totalFrames) * 84);
          const elapsed = Math.max(0.05, (performance.now() - renderStartMs) / 1000);
          const speedX = ((i + 1) * frameDur / elapsed).toFixed(1);
          onProgress?.({
            pct,
            status: `Rendering frame ${i + 1} / ${totalFrames}`,
            telemetry: `${speedX}x • ${engineTag} • ${(targetVideoBps / 1e6).toFixed(2)} Mbps`,
          });
        }
      }

      onProgress?.({ pct: 97, status: 'Finalizing container...', telemetry: `Engine: WebCodecs (${engineTag})` });
      videoSource.close();
      await output.finalize();

      const outBuf = output.target.buffer;
      const elapsedSec = Math.max(0.05, (performance.now() - tStart) / 1000);
      return {
        blob: new Blob([outBuf], { type: mime }),
        ext,
        mime,
        speedMultiplier: duration / elapsedSec,
        engineLabel: engineTag,
      };
    } finally {
      for (const entry of activeReaders.values()) {
        await this._closeClipReader(entry);
      }
      activeReaders.clear();
    }
  }

  async _readFrame(entry, srcTime, tempClosers) {
    if (entry.kind === 'stream') {
      return entry.reader.getDrawableAt(srcTime);
    }
    if (entry.kind === 'sink') {
      try {
        const sample = await entry.sink.getSample(srcTime);
        if (sample) {
          const vf = sample.toVideoFrame ? sample.toVideoFrame() : sample;
          tempClosers.push(() => {
            if (vf !== sample) try { vf.close(); } catch (_) {}
            try { sample.close(); } catch (_) {}
          });
          return vf;
        }
      } catch (_) {}
      return null;
    }
    if (entry.kind === 'video') {
      await seekVideoElement(entry.vid, srcTime, 1500);
      return entry.vid;
    }
    return null;
  }

  /**
   * Universal Multi-Clip FFmpeg.wasm fallback renderer (honors all splits, trims, deletions & speed).
   */
  async _renderFallbackFfmpeg(plan, audioMix, onProgress, tStart) {
    const { outW, outH, fps, duration, targetVideoBps, container, videoAudioCodec, opus } = plan;
    onProgress?.({ pct: 10, status: 'Starting FFmpeg.wasm universal engine...', telemetry: 'Engine: FFmpeg.wasm' });

    const v1Clips = store.project.v1Clips.filter(c => store.getAsset(c.assetId)?.file);
    if (!v1Clips.length) {
      throw new Error('No source media available for FFmpeg fallback.');
    }

    // Deduplicate source files mounted via WORKERFS
    const assetToInputIdx = new Map();
    const files = [];
    const args = [];
    let inputIdx = 0;

    for (const clip of v1Clips) {
      const asset = store.getAsset(clip.assetId);
      if (!assetToInputIdx.has(asset.id)) {
        const alias = `in_${inputIdx}.${asset.ext || (asset.kind === 'image' ? 'png' : 'mp4')}`;
        files.push({ name: alias, file: asset.file });
        if (asset.kind === 'image') {
          args.push('-loop', '1', '-i', `__IN:${alias}__`);
        } else {
          args.push('-i', `__IN:${alias}__`);
        }
        assetToInputIdx.set(asset.id, inputIdx++);
      }
    }

    let audioInputIdx = -1;
    if (audioMix.hasAudioContent && audioMix.buffer) {
      const wavBlob = encodeAudioBufferToWav(audioMix.buffer);
      files.push({ name: 'mix.wav', file: new File([wavBlob], 'mix.wav', { type: 'audio/wav' }) });
      args.push('-i', '__IN:mix.wav__');
      audioInputIdx = inputIdx++;
    }

    // Build exact multi-clip trim + speed + scale + concat filtergraph
    const filterParts = [];
    const concatInputs = [];
    v1Clips.forEach((clip, idx) => {
      const aIdx = assetToInputIdx.get(clip.assetId);
      const speed = clamp(clip.speed || 1, 0.25, 4);
      const isStatic = clip.kind === 'image' || clip.kind === 'freeze';
      const trimFilter = isStatic
        ? `trim=duration=${store.getClipDuration(clip).toFixed(3)},setpts=PTS-STARTPTS`
        : `trim=start=${(clip.trimStart || 0).toFixed(3)}:end=${(clip.trimEnd ?? clip.sourceDuration).toFixed(3)},setpts=(PTS-STARTPTS)/${speed.toFixed(4)}`;

      filterParts.push(
        `[${aIdx}:v]${trimFilter},scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${idx}]`
      );
      concatInputs.push(`[v${idx}]`);
    });

    filterParts.push(`${concatInputs.join('')}concat=n=${v1Clips.length}:v=1:a=0[vout]`);
    args.push('-filter_complex', filterParts.join(';'), '-map', '[vout]');

    let ext = container;
    let mime = 'video/mp4';
    if (container === 'webm') {
      args.push('-c:v', 'libvpx-vp9', '-b:v', `${Math.round(targetVideoBps / 1000)}k`);
      mime = 'video/webm';
    } else {
      args.push(
        '-c:v', 'libx264', '-preset', 'veryfast',
        '-b:v', `${Math.round(targetVideoBps / 1000)}k`,
        '-maxrate', `${Math.round(targetVideoBps * 1.25 / 1000)}k`,
        '-bufsize', `${Math.round(targetVideoBps * 2 / 1000)}k`,
        '-pix_fmt', 'yuv420p'
      );
      if (container === 'mp4') args.push('-movflags', '+faststart');
      mime = container === 'mkv' ? 'video/x-matroska' : 'video/mp4';
    }

    if (audioInputIdx >= 0) {
      args.push('-map', `${audioInputIdx}:a:0`);
      if (videoAudioCodec === 'aac') {
        args.push('-c:a', 'aac', '-b:a', '128k');
      } else {
        args.push(
          '-c:a', 'libopus',
          '-b:a', `${opus.bitrate}k`,
          '-vbr', opus.bitrateMode === 'constant' ? 'off' : 'on',
          '-ac', String(opus.channels),
          '-ar', String(opus.sampleRate)
        );
      }
      args.push('-shortest');
    } else {
      args.push('-an');
    }

    args.push('-y', '__OUT__');

    const { buffer } = await ffmpegWorker.run({
      files,
      args,
      outputName: `out.${ext}`,
      duration,
      onProgress: (p) => onProgress?.({
        pct: Math.round(15 + p * 82),
        status: 'Encoding via FFmpeg.wasm...',
        telemetry: 'Engine: FFmpeg.wasm (WORKERFS)',
      }),
    });

    const elapsedSec = Math.max(0.05, (performance.now() - tStart) / 1000);
    return {
      blob: new Blob([buffer], { type: mime }),
      ext,
      mime,
      speedMultiplier: duration / elapsedSec,
      engineLabel: 'FFmpeg',
    };
  }
}

function buildOpusHeadBytes(channels = 2, sampleRate = 48000, preSkip = 312) {
  const head = new Uint8Array(19);
  const v = new DataView(head.buffer);
  head.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
  head[8] = 1;
  head[9] = channels;
  v.setUint16(10, preSkip, true);
  v.setUint32(12, sampleRate, true);
  v.setInt16(16, 0, true);
  head[18] = 0;
  return head;
}
