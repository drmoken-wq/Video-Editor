// js/audio-engine.js — Real-time Multi-Track Mixer, OfflineAudioContext Mixdown & RFC 3533/7845 Ogg Opus Muxer
import { store, clamp } from './state.js';
import { getMediabunny } from './media-loader.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterLimiter = null;
    /** @type {Map<string, { el: HTMLMediaElement, src: MediaElementAudioSourceNode, gain: GainNode }>} */
    this.mediaNodes = new Map();
    /** @type {Map<string, HTMLAudioElement>} Dedicated audio elements for A1/A2 */
    this.audioPool = new Map();
  }

  ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.masterLimiter = this.ctx.createDynamicsCompressor();
      this.masterLimiter.threshold.value = -1.5;
      this.masterLimiter.knee.value = 6;
      this.masterLimiter.ratio.value = 12;
      this.masterLimiter.attack.value = 0.003;
      this.masterLimiter.release.value = 0.08;
      this.masterLimiter.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  resume() {
    this.ensureContext();
  }

  /** Attaches any HTMLMediaElement (<video> or <audio>) once to a GainNode (supports 0..300% boost) */
  attachMediaElement(key, el) {
    if (!el) return;
    const existing = this.mediaNodes.get(key);
    if (existing && existing.el === el) return;
    if (el.__pulsecutWired) return;

    try {
      const ctx = this.ensureContext();
      const src = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = 1;
      src.connect(gain);
      gain.connect(this.masterLimiter);
      el.__pulsecutWired = true;
      this.mediaNodes.set(key, { el, src, gain });
    } catch (err) {
      console.warn('[AudioEngine] attachMediaElement fallback:', err?.message || err);
    }
  }

  setElementGain(key, gainValue) {
    const node = this.mediaNodes.get(key);
    if (!node || !this.ctx) return;
    const target = clamp(Number.isFinite(gainValue) ? gainValue : 0, 0, 3.0);
    node.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.015);
  }

  getOrCreateAudioEl(clipId, asset) {
    if (!asset) return null;
    let el = this.audioPool.get(clipId);
    if (!el || el.dataset.assetId !== asset.id) {
      el = document.createElement('audio');
      el.src = asset.objectUrl;
      el.dataset.assetId = asset.id;
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      this.audioPool.set(clipId, el);
    }
    return el;
  }

  cleanupUnusedAudio() {
    const activeIds = new Set(store.project.audioClips.map(a => a.id));
    for (const [id, el] of this.audioPool.entries()) {
      if (!activeIds.has(id)) {
        try { el.pause(); el.removeAttribute('src'); el.load(); } catch (_) {}
        this.audioPool.delete(id);
        this.mediaNodes.delete(id);
      }
    }
  }

  pauseAllAudio() {
    for (const el of this.audioPool.values()) {
      if (!el.paused) el.pause();
    }
  }

  /** Syncs A1 & A2 audio tracks to timeline time t during live preview */
  syncAudioTracks(timeSec, isPlaying) {
    this.cleanupUnusedAudio();

    for (const ac of store.project.audioClips) {
      const asset = store.getAsset(ac.assetId);
      const el = this.getOrCreateAudioEl(ac.id, asset);
      if (!el) continue;

      const dur = store.getClipDuration(ac);
      const isActive = timeSec >= ac.startTime && timeSec <= ac.startTime + dur;

      if (!isActive || !isPlaying || ac.muted) {
        if (!el.paused) el.pause();
        this.setElementGain(ac.id, 0);
        continue;
      }

      const relT = clamp(timeSec - ac.startTime, 0, dur);
      const srcTime = clamp((ac.trimStart || 0) + relT * (ac.speed || 1), 0, Math.max(0, (asset.duration || dur) - 0.02));
      el.playbackRate = clamp(ac.speed || 1, 0.25, 4);

      let gainVal = clamp(ac.volume ?? 1, 0, 3);
      if (ac.fadeIn > 0 && relT < ac.fadeIn) {
        gainVal *= clamp(relT / ac.fadeIn, 0, 1);
      }
      if (ac.fadeOut > 0 && dur - relT < ac.fadeOut) {
        gainVal *= clamp((dur - relT) / ac.fadeOut, 0, 1);
      }

      this.attachMediaElement(ac.id, el);
      this.setElementGain(ac.id, gainVal);

      if (Math.abs(el.currentTime - srcTime) > 0.2 && el.readyState >= 1) {
        try { el.currentTime = srcTime; } catch (_) {}
      }
      if (el.paused && el.readyState >= 2) {
        el.play().catch(() => {});
      }
    }
  }
}

/**
 * Decodes a specific time range [trimStart, trimEnd] of an asset's audio track into an AudioBuffer
 * using streaming Mediabunny BlobSource (NEVER calls file.arrayBuffer() on large videos!).
 */
async function decodeAudioSegmentStreaming(asset, trimStart, trimEnd, targetSampleRate) {
  if (!asset || !asset.file) return null;

  // 1. Streaming decode via Mediabunny AudioBufferSink
  try {
    const mb = await getMediabunny();
    if (mb) {
      const input = new mb.Input({
        source: new mb.BlobSource(asset.file),
        formats: mb.ALL_FORMATS,
      });
      try {
        const aTrack = await input.getPrimaryAudioTrack();
        if (aTrack && await aTrack.canDecode()) {
          const sink = new mb.AudioBufferSink(aTrack);
          const chunks = [];
          let sr = aTrack.sampleRate || targetSampleRate || 48000;
          let ch = Math.min(2, aTrack.numberOfChannels || 2);
          let totalFrames = 0;

          const start = Math.max(0, trimStart - 0.05);
          const end = Math.max(start + 0.05, trimEnd + 0.05);
          for await (const item of sink.buffers(start, end)) {
            if (!item?.buffer) continue;
            sr = item.buffer.sampleRate;
            ch = Math.min(2, item.buffer.numberOfChannels);
            chunks.push(item);
            totalFrames += item.buffer.length;
          }

          if (chunks.length > 0 && totalFrames > 0) {
            const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
            const segDur = Math.max(0.05, trimEnd - trimStart);
            const segFrames = Math.ceil(segDur * sr);
            const outBuf = new AudioBuffer({ numberOfChannels: ch, length: segFrames, sampleRate: sr });

            for (const item of chunks) {
              const buf = item.buffer;
              const offsetSec = item.timestamp - trimStart;
              const dstOffset = Math.round(offsetSec * sr);
              for (let c = 0; c < ch; c++) {
                const srcData = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
                const dstData = outBuf.getChannelData(c);
                const srcStart = dstOffset < 0 ? -dstOffset : 0;
                const dstStart = Math.max(0, dstOffset);
                const copyLen = Math.min(srcData.length - srcStart, dstData.length - dstStart);
                if (copyLen > 0) {
                  dstData.set(srcData.subarray(srcStart, srcStart + copyLen), dstStart);
                }
              }
            }
            return outBuf;
          }
        }
      } finally {
        try { input.dispose?.(); } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('[OfflineAudio] Mediabunny AudioBufferSink fallback:', err?.message || err);
  }

  // 2. Fallback for standalone audio files (< 60 MB) or small videos (< 35 MB) if AudioBufferSink unavailable
  const allowFallback = (asset.kind === 'audio' && asset.size <= 60 * 1024 * 1024) || (asset.kind === 'video' && asset.hasAudio && asset.size <= 35 * 1024 * 1024);
  if (allowFallback) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const tmpCtx = new Ctx({ sampleRate: targetSampleRate || 48000 });
      try {
        const ab = await asset.file.arrayBuffer();
        const full = await tmpCtx.decodeAudioData(ab);
        const sr = full.sampleRate;
        const ch = Math.min(2, full.numberOfChannels);
        const s0 = clamp(Math.floor(trimStart * sr), 0, full.length);
        const s1 = clamp(Math.ceil(trimEnd * sr), s0 + 1, full.length);
        const sliceLen = Math.max(1, s1 - s0);
        const sliced = new AudioBuffer({ numberOfChannels: ch, length: sliceLen, sampleRate: sr });
        for (let c = 0; c < ch; c++) {
          sliced.getChannelData(c).set(full.getChannelData(c).subarray(s0, s1));
        }
        return sliced;
      } finally {
        tmpCtx.close().catch(() => {});
      }
    } catch (err) {
      console.warn('[OfflineAudio] decodeAudioData failed:', err?.message || err);
    }
  }

  return null;
}

/**
 * Fast OfflineAudioContext multi-track mixdown.
 * Combines V1 embedded audio (when not muted/detached), V2 PiP audio, and A1/A2 audio clips
 * with exact speed, volume (up to 300%), and fade in/out ramps.
 */
export async function renderOfflineAudioMix(project, assetsMap, options = {}) {
  const sampleRate = options.sampleRate || 48000;
  const channels = options.channels || 2;
  const totalDuration = Math.max(0.1, options.duration || store.getTotalDuration());
  const totalFrames = Math.max(1, Math.ceil(totalDuration * sampleRate));

  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new OfflineCtx(channels, totalFrames, sampleRate);

  // Safety master compressor/limiter for >100% boosted meme audio
  const limiter = offline.createDynamicsCompressor();
  limiter.threshold.value = -1.2;
  limiter.knee.value = 6;
  limiter.ratio.value = 14;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.06;
  limiter.connect(offline.destination);

  let scheduledAny = false;

  const scheduleSegment = (buffer, startTime, timelineDur, speed, volume, fadeIn, fadeOut) => {
    if (!buffer || volume <= 0 || timelineDur <= 0.01) return;
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = clamp(speed || 1, 0.25, 4);

    const gain = offline.createGain();
    const vol = clamp(volume, 0, 3.0);
    const t0 = Math.max(0, startTime);
    const t1 = Math.min(totalDuration, t0 + timelineDur);

    const fi = Math.min(fadeIn || 0, timelineDur * 0.48);
    const fo = Math.min(fadeOut || 0, timelineDur * 0.48);

    if (fi > 0.01) {
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(vol, t0 + fi);
    } else {
      gain.gain.setValueAtTime(vol, t0);
    }

    if (fo > 0.01) {
      gain.gain.setValueAtTime(vol, Math.max(t0 + fi, t1 - fo));
      gain.gain.linearRampToValueAtTime(0.0001, t1);
    }

    src.connect(gain);
    gain.connect(limiter);
    src.start(t0, 0, Math.max(0.01, timelineDur));
    scheduledAny = true;
  };

  // 1. V1 clips embedded audio
  for (const clip of project.v1Clips) {
    if (clip.kind !== 'video' || clip.muted || clip.audioDetached || (clip.volume ?? 1) <= 0) continue;
    const asset = assetsMap.get(clip.assetId);
    if (!asset || !asset.hasAudio) continue;
    const buf = await decodeAudioSegmentStreaming(asset, clip.trimStart || 0, clip.trimEnd ?? asset.duration, sampleRate);
    const dur = store.getClipDuration(clip);
    scheduleSegment(buf, clip.startTime, dur, clip.speed || 1, clip.volume ?? 1, clip.audioFadeIn || 0, clip.audioFadeOut || 0);
  }

  // 2. V2 PiP overlays audio
  for (const ov of project.v2Overlays) {
    if (ov.type !== 'pip' || (ov.volume ?? 1) <= 0) continue;
    const asset = assetsMap.get(ov.assetId);
    if (!asset || !asset.hasAudio) continue;
    const dur = Math.max(0.1, ov.endTime - ov.startTime);
    const buf = await decodeAudioSegmentStreaming(asset, ov.trimStart || 0, (ov.trimStart || 0) + dur, sampleRate);
    scheduleSegment(buf, ov.startTime, dur, 1, ov.volume ?? 1, ov.fadeIn || 0, ov.fadeOut || 0);
  }

  // 3. A1 & A2 audio tracks
  for (const ac of project.audioClips) {
    if (ac.muted || (ac.volume ?? 1) <= 0) continue;
    const asset = assetsMap.get(ac.assetId);
    if (!asset) continue;
    const buf = await decodeAudioSegmentStreaming(asset, ac.trimStart || 0, ac.trimEnd ?? asset.duration, sampleRate);
    const dur = store.getClipDuration(ac);
    scheduleSegment(buf, ac.startTime, dur, ac.speed || 1, ac.volume ?? 1, ac.fadeIn || 0, ac.fadeOut || 0);
  }

  const rendered = await offline.startRendering();
  return { buffer: rendered, hasAudioContent: scheduledAny };
}

/**
 * Encodes an AudioBuffer into raw Opus packets via WebCodecs AudioEncoder
 * with full customizable Opus parameters (profile, bitrate, CBR/VBR, sampleRate, channels).
 */
export async function encodeAudioBufferToOpusPackets(audioBuffer, opusOpts = {}) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    throw new Error('WebCodecs AudioEncoder unavailable');
  }

  const sampleRate = opusOpts.sampleRate || audioBuffer.sampleRate || 48000;
  const channels = opusOpts.channels || audioBuffer.numberOfChannels || 2;
  const bitrate = clamp((opusOpts.bitrate || 48) * 1000, 16_000, 320_000);
  const bitrateMode = opusOpts.bitrateMode === 'variable' ? 'variable' : 'constant';
  const application = ['audio', 'voip', 'lowdelay'].includes(opusOpts.profile) ? opusOpts.profile : 'audio';

  const fullConfig = {
    codec: 'opus',
    sampleRate,
    numberOfChannels: channels,
    bitrate,
    bitrateMode,
    opus: {
      application,
      frameDuration: 20000,
    },
  };

  let chosenConfig = fullConfig;
  let support = await AudioEncoder.isConfigSupported(fullConfig).catch(() => ({ supported: false }));
  if (!support.supported) {
    const basicConfig = { codec: 'opus', sampleRate, numberOfChannels: channels, bitrate };
    support = await AudioEncoder.isConfigSupported(basicConfig).catch(() => ({ supported: false }));
    if (!support.supported) {
      throw new Error('Browser AudioEncoder does not support this Opus configuration');
    }
    chosenConfig = basicConfig;
  }

  const packets = [];
  let encoderError = null;

  const encoder = new AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({
        data,
        timestamp: chunk.timestamp, // microseconds
        duration: chunk.duration || 20000, // microseconds
      });
    },
    error: (err) => {
      encoderError = err;
    },
  });

  encoder.configure(chosenConfig);

  // Feed 20ms planar f32 chunks
  const frameSize = Math.max(160, Math.round(sampleRate * 0.02));
  const totalFrames = audioBuffer.length;
  const chData = [];
  for (let c = 0; c < channels; c++) {
    chData.push(audioBuffer.getChannelData(Math.min(c, audioBuffer.numberOfChannels - 1)));
  }

  for (let offset = 0; offset < totalFrames; offset += frameSize) {
    if (encoderError) throw encoderError;
    const count = Math.min(frameSize, totalFrames - offset);
    const planar = new Float32Array(count * channels);
    for (let c = 0; c < channels; c++) {
      planar.set(chData[c].subarray(offset, offset + count), c * count);
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: count,
      numberOfChannels: channels,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planar,
    });
    encoder.encode(audioData);
    audioData.close();
  }

  await encoder.flush();
  encoder.close();
  if (encoderError) throw encoderError;

  return { packets, sampleRate, channels };
}

/* ============================================================================
 * Pure-JS Spec-Compliant RFC 3533 (Ogg) + RFC 7845 (Opus) Container Muxer
 * ============================================================================ */

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1);
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc32(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

function buildOggPage({ headerType, granulePos, serial, seqNum, packets }) {
  // Build segment lacing table
  const lacing = [];
  let payloadLen = 0;
  for (const pkt of packets) {
    let rem = pkt.byteLength;
    payloadLen += rem;
    while (rem >= 255) {
      lacing.push(255);
      rem -= 255;
    }
    lacing.push(rem);
  }

  const pageLen = 27 + lacing.length + payloadLen;
  const page = new Uint8Array(pageLen);
  const view = new DataView(page.buffer);

  // "OggS"
  page[0] = 0x4F; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53;
  page[4] = 0x00; // version
  page[5] = headerType;

  // 64-bit little-endian granule position
  const gpBig = BigInt(Math.max(0, Math.round(granulePos)));
  view.setUint32(6, Number(gpBig & 0xffffffffn), true);
  view.setUint32(10, Number((gpBig >> 32n) & 0xffffffffn), true);

  view.setUint32(14, serial >>> 0, true);
  view.setUint32(18, seqNum >>> 0, true);
  view.setUint32(22, 0, true); // CRC placeholder
  page[26] = lacing.length;

  for (let i = 0; i < lacing.length; i++) {
    page[27 + i] = lacing[i];
  }

  let offset = 27 + lacing.length;
  for (const pkt of packets) {
    page.set(pkt, offset);
    offset += pkt.byteLength;
  }

  const crc = oggCrc32(page);
  view.setUint32(22, crc, true);
  return page;
}

/**
 * Muxes encoded WebCodecs Opus packets into a 100% RFC 3533 / RFC 7845 compliant .opus / .ogg Blob.
 */
export function muxOggOpus(packets, { channels = 2, sampleRate = 48000, preSkip = 312 } = {}) {
  const serial = (Math.floor(Math.random() * 0x7fffffff) ^ 0x50435554) >>> 0;
  const pages = [];
  let seqNum = 0;

  // Page 0: OpusHead (19 bytes, BOS=0x02, granule=0)
  const head = new Uint8Array(19);
  const hv = new DataView(head.buffer);
  const headMagic = [0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"
  head.set(headMagic, 0);
  head[8] = 1; // version
  head[9] = channels;
  hv.setUint16(10, preSkip, true);
  hv.setUint32(12, sampleRate, true);
  hv.setInt16(16, 0, true); // output gain
  head[18] = 0; // mapping family 0 (mono/stereo)

  pages.push(buildOggPage({
    headerType: 0x02,
    granulePos: 0,
    serial,
    seqNum: seqNum++,
    packets: [head],
  }));

  // Page 1: OpusTags (granule=0)
  const vendorBytes = new TextEncoder().encode('PulseCut Local Studio');
  const tags = new Uint8Array(8 + 4 + vendorBytes.length + 4);
  const tv = new DataView(tags.buffer);
  tags.set([0x4F, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // "OpusTags"
  tv.setUint32(8, vendorBytes.length, true);
  tags.set(vendorBytes, 12);
  tv.setUint32(12 + vendorBytes.length, 0, true); // 0 user comments

  pages.push(buildOggPage({
    headerType: 0x00,
    granulePos: 0,
    serial,
    seqNum: seqNum++,
    packets: [tags],
  }));

  // Audio Pages: RFC 7845 granule positions ALWAYS count 48 kHz samples!
  let granule48k = preSkip;
  let batch = [];
  let batchSegments = 0;

  for (let i = 0; i < packets.length; i++) {
    const pkt = packets[i];
    const segsNeeded = Math.floor(pkt.data.byteLength / 255) + 1;

    if (batch.length > 0 && (batchSegments + segsNeeded > 250 || batch.length >= 40)) {
      pages.push(buildOggPage({
        headerType: 0x00,
        granulePos: granule48k,
        serial,
        seqNum: seqNum++,
        packets: batch,
      }));
      batch = [];
      batchSegments = 0;
    }

    batch.push(pkt.data);
    batchSegments += segsNeeded;
    const samples48k = Math.max(120, Math.round(((pkt.duration || 20000) / 1_000_000) * 48000));
    granule48k += samples48k;
  }

  // Final EOS page (headerType = 0x04)
  pages.push(buildOggPage({
    headerType: 0x04,
    granulePos: granule48k,
    serial,
    seqNum: seqNum++,
    packets: batch.length ? batch : [new Uint8Array(0)],
  }));

  return new Blob(pages, { type: 'audio/ogg; codecs=opus' });
}

/**
 * Pure-JS instant 16-bit PCM WAV encoder for AudioBuffer.
 */
export function encodeAudioBufferToWav(audioBuffer) {
  const numChannels = Math.min(2, audioBuffer.numberOfChannels);
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }

  let pos = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = clamp(channels[c][i], -1, 1);
      view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      pos += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
