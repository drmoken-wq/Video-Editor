// js/export-engine.js — Hybrid GPU WebCodecs (Mediabunny) + Single-Threaded FFmpeg.wasm (Blob Worker + WORKERFS)
import { store, clamp } from './state.js';
import { getMediabunny, seekVideoElement } from './media-loader.js';
import { renderCompositeFrame } from './canvas-stage.js';
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
  const CHUNK = 4 * 1024 * 1024; // 4 MB chunks — never loads entire large file into RAM
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
  const { id, type, files, args, outputName, duration } = e.data;
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
      // Primary: WORKERFS zero-copy mount (zero full-file RAM copy!)
      try {
        if (FS.filesystems && FS.filesystems.WORKERFS) {
          const blobs = files.map(f => ({ name: f.name, data: f.file }));
          FS.mount(FS.filesystems.WORKERFS, { blobs }, mountDir);
          usedWorkerFs = true;
          for (const f of files) mountedPaths.push({ alias: f.name, path: mountDir + '/' + f.name });
        }
      } catch (err) {
        usedWorkerFs = false;
      }

      // Fallback: 4 MB chunked FS.write
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

    // Cleanup virtual FS
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
      worker.postMessage({ id, type: 'exec', files, args, outputName, duration });
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
 * Transcodes an exotic media container (AVI, FLV, WMV, TS, VOB, WMA, AMR, AC3, etc.)
 * into a clean browser-compatible MP4 or WAV via WORKERFS zero-copy mount.
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

  /**
   * Main export entry point (Video Export or Audio-Only Export).
   */
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

    // 1. Instant WAV
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

    // 2. Opus / OGG — Fast WebCodecs AudioEncoder + RFC 3533/7845 Ogg Opus Muxer (with FFmpeg fallback)
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

    // 3. FFmpeg.wasm Audio Encoding (.mp3, .m4a, or Opus fallback)
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
    // 1. Pre-render mixed offline audio track first
    onProgress?.({ pct: 4, status: 'Mixing multi-track audio...', telemetry: 'Engine: OfflineAudioContext' });
    const audioSr = plan.videoAudioCodec === 'aac' ? 48000 : (plan.opus.sampleRate || 48000);
    const audioCh = plan.videoAudioCodec === 'aac' ? 2 : (plan.opus.channels || 2);
    const audioMix = await renderOfflineAudioMix(store.project, store.assets, {
      sampleRate: audioSr,
      channels: audioCh,
      duration: plan.duration,
    });
    if (this._cancelled) throw new Error('Export cancelled');

    // 2. Try GPU-Accelerated Faster-Than-Real-Time WebCodecs via Mediabunny
    const mb = await getMediabunny();
    if (mb && typeof VideoEncoder !== 'undefined') {
      const hwChain = plan.gpuAcceleration
        ? ['prefer-hardware', 'no-preference', 'prefer-software']
        : ['prefer-software', 'no-preference'];

      for (const hwPref of hwChain) {
        if (this._cancelled) throw new Error('Export cancelled');
        try {
          const result = await this._renderWithMediabunny(mb, plan, audioMix, hwPref, onProgress, tStart);
          return result;
        } catch (err) {
          if (this._cancelled) throw err;
          console.warn(`[ExportEngine] WebCodecs (${hwPref}) fallback:`, err?.message || err);
        }
      }
    }

    // 3. Universal FFmpeg.wasm fallback (if WebCodecs completely unavailable or rejected)
    return this._renderFallbackFfmpeg(plan, audioMix, onProgress, tStart);
  }

  async _renderWithMediabunny(mb, plan, audioMix, hwPref, onProgress, tStart) {
    const engineTag = hwPref === 'prefer-hardware' ? 'GPU' : hwPref === 'prefer-software' ? 'SW' : 'Auto';
    const { outW, outH, fps, duration, targetVideoBps, container, videoAudioCodec, opus } = plan;

    // Prepare output format (dynamic H.264 level selection via Mediabunny)
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

    const output = new mb.Output({
      format,
      target: new mb.BufferTarget(),
    });

    const videoSource = new mb.CanvasSource(canvas, {
      codec: videoCodec,
      bitrate: targetVideoBps,
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
        // Prefer exact Opus parameters (CBR/VBR + profile) via EncodedAudioPacketSource if available
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

    // Open streaming Mediabunny VideoSampleSinks for all V1 & V2 PiP video assets
    const decoders = await this._openVideoDecoders(mb);

    try {
      await output.start();

      // Write audio track
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

      // Render & encode frames faster-than-real-time
      const totalFrames = Math.max(1, Math.ceil(duration * fps));
      const frameDur = 1 / fps;

      for (let i = 0; i < totalFrames; i++) {
        if (this._cancelled) throw new Error('Export cancelled');
        const t = Math.min(duration, i * frameDur);

        // Fetch decoded frames for active V1 & V2 PiP clips at exact timeline time t
        const fetchedFrames = [];
        const v1Map = new Map();
        const ovMap = new Map();

        for (const clip of store.project.v1Clips) {
          const cDur = store.getClipDuration(clip);
          if (t < clip.startTime - 0.001 || t > clip.startTime + cDur + 0.001) continue;
          const asset = store.getAsset(clip.assetId);
          if (!asset) continue;
          if (clip.kind === 'image' || clip.kind === 'freeze') {
            v1Map.set(clip.id, asset.imageEl);
          } else {
            const relT = clamp(t - clip.startTime, 0, cDur);
            const srcTime = clamp((clip.trimStart || 0) + relT * (clip.speed || 1), 0, Math.max(0, (asset.duration || cDur) - 0.02));
            const frameObj = await this._getDecodedFrame(decoders, clip.id, asset, srcTime);
            if (frameObj) {
              v1Map.set(clip.id, frameObj.drawable);
              if (frameObj.close) fetchedFrames.push(frameObj.close);
            }
          }
        }

        for (const ov of store.project.v2Overlays) {
          if (t < ov.startTime || t > ov.endTime) continue;
          const asset = store.getAsset(ov.assetId);
          if (!asset) continue;
          if (ov.type === 'image') {
            ovMap.set(ov.id, asset.imageEl);
          } else if (ov.type === 'pip') {
            const relT = clamp(t - ov.startTime, 0, ov.endTime - ov.startTime);
            const srcTime = (ov.trimStart || 0) + (relT % Math.max(0.1, asset.duration || 5));
            const frameObj = await this._getDecodedFrame(decoders, ov.id, asset, srcTime);
            if (frameObj) {
              ovMap.set(ov.id, frameObj.drawable);
              if (frameObj.close) fetchedFrames.push(frameObj.close);
            }
          }
        }

        // Composite WYSIWYG frame
        renderCompositeFrame(ctx, outW, outH, t, store.project, {
          getV1Media: (clip) => v1Map.get(clip.id) || null,
          getOverlayMedia: (ov) => ovMap.get(ov.id) || null,
        });

        // Release GPU VideoSamples immediately after drawing to canvas!
        for (const closeFn of fetchedFrames) {
          try { closeFn(); } catch (_) {}
        }

        await videoSource.add(t, frameDur);

        if (i % 4 === 0 || i === totalFrames - 1) {
          const pct = Math.round(12 + ((i + 1) / totalFrames) * 84);
          const elapsed = Math.max(0.05, (performance.now() - tStart) / 1000);
          const speedX = (t / elapsed).toFixed(1);
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
      this._closeVideoDecoders(decoders);
    }
  }

  async _openVideoDecoders(mb) {
    const map = new Map();
    const entries = [
      ...store.project.v1Clips.filter(c => c.kind === 'video').map(c => ({ key: c.id, assetId: c.assetId })),
      ...store.project.v2Overlays.filter(o => o.type === 'pip').map(o => ({ key: o.id, assetId: o.assetId })),
    ];

    for (const { key, assetId } of entries) {
      const asset = store.getAsset(assetId);
      if (!asset || !asset.file) continue;
      let opened = false;
      try {
        const input = new mb.Input({ source: new mb.BlobSource(asset.file), formats: mb.ALL_FORMATS });
        const vTrack = await input.getPrimaryVideoTrack();
        if (vTrack && await vTrack.canDecode()) {
          const sink = new mb.VideoSampleSink(vTrack);
          map.set(key, { kind: 'sink', input, sink });
          opened = true;
        } else {
          input.dispose?.();
        }
      } catch (_) {}

      if (!opened) {
        const vid = document.createElement('video');
        vid.src = asset.objectUrl;
        vid.muted = true;
        vid.playsInline = true;
        vid.preload = 'auto';
        await new Promise((r) => {
          vid.onloadeddata = () => r();
          vid.onerror = () => r();
          setTimeout(r, 2500);
        });
        map.set(key, { kind: 'video', vid });
      }
    }
    return map;
  }

  async _getDecodedFrame(decoders, key, asset, srcTime) {
    const dec = decoders.get(key);
    if (!dec) return null;
    if (dec.kind === 'sink') {
      try {
        const sample = await dec.sink.getSample(srcTime);
        if (sample) {
          const vf = sample.toVideoFrame ? sample.toVideoFrame() : sample;
          return {
            drawable: vf,
            close: () => {
              if (vf !== sample) try { vf.close(); } catch (_) {}
              try { sample.close(); } catch (_) {}
            },
          };
        }
      } catch (_) {}
    }
    if (dec.kind === 'video') {
      await seekVideoElement(dec.vid, srcTime, 1500);
      return { drawable: dec.vid, close: null };
    }
    return null;
  }

  _closeVideoDecoders(decoders) {
    for (const dec of decoders.values()) {
      if (dec.kind === 'sink') {
        try { dec.input?.dispose?.(); } catch (_) {}
      } else if (dec.kind === 'video') {
        try { dec.vid.pause(); dec.vid.removeAttribute('src'); dec.vid.load(); } catch (_) {}
      }
    }
    decoders.clear();
  }

  /**
   * Universal FFmpeg.wasm fallback renderer (for browsers without WebCodecs).
   * Encodes canvas frames via FFmpeg.wasm worker using WORKERFS zero-copy mount.
   */
  async _renderFallbackFfmpeg(plan, audioMix, onProgress, tStart) {
    const { outW, outH, fps, duration, targetVideoBps, container, videoAudioCodec, opus } = plan;
    onProgress?.({ pct: 10, status: 'Starting FFmpeg.wasm universal engine...', telemetry: 'Engine: FFmpeg.wasm' });

    const primaryClip = store.project.v1Clips[0];
    const primaryAsset = primaryClip ? store.getAsset(primaryClip.assetId) : null;
    if (!primaryAsset?.file) {
      throw new Error('No source video available for FFmpeg fallback.');
    }

    const inName = 'src_' + Date.now() + '.' + (primaryAsset.ext || 'mp4');
    const files = [{ name: inName, file: primaryAsset.file }];
    const args = ['-i', `__IN:${inName}__`];

    let hasAudioFile = false;
    if (audioMix.hasAudioContent && audioMix.buffer) {
      const wavBlob = encodeAudioBufferToWav(audioMix.buffer);
      files.push({ name: 'mix.wav', file: new File([wavBlob], 'mix.wav', { type: 'audio/wav' }) });
      args.push('-i', '__IN:mix.wav__');
      hasAudioFile = true;
    }

    const trimStart = primaryClip.trimStart || 0;
    const trimDur = store.getClipDuration(primaryClip);
    args.push('-ss', trimStart.toFixed(3), '-t', trimDur.toFixed(3));
    args.push('-vf', `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2`);
    args.push('-r', String(fps));

    let ext = container;
    let mime = 'video/mp4';
    if (container === 'webm') {
      args.push('-c:v', 'libvpx-vp9', '-b:v', `${Math.round(targetVideoBps / 1000)}k`);
      mime = 'video/webm';
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${Math.round(targetVideoBps / 1000)}k`, '-maxrate', `${Math.round(targetVideoBps * 1.15 / 1000)}k`, '-bufsize', `${Math.round(targetVideoBps * 2 / 1000)}k`, '-pix_fmt', 'yuv420p');
      if (container === 'mp4') args.push('-movflags', '+faststart');
      mime = container === 'mkv' ? 'video/x-matroska' : 'video/mp4';
    }

    if (hasAudioFile) {
      args.push('-map', '0:v:0', '-map', '1:a:0');
      if (videoAudioCodec === 'aac') {
        args.push('-c:a', 'aac', '-b:a', '128k');
      } else {
        args.push('-c:a', 'libopus', '-b:a', `${opus.bitrate}k`, '-vbr', opus.bitrateMode === 'constant' ? 'off' : 'on', '-ac', String(opus.channels), '-ar', String(opus.sampleRate));
      }
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
