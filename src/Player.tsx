import { createSignal, onCleanup, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import { DebugPanel } from "./DebugPanel";
import { CicularAudioSharedBuffer } from "../render/audio_circular_buffer.js";
import { VideoRenderBuffer } from "../render/video_render_buffer.js";
import {
  GetVideoCodecStringFromAVCDecoderConfigurationRecord,
  ParseAVCDecoderConfigurationRecord,
} from "../utils/media/avc_decoder_configuration_record_parser.js";
import { JitterBuffer } from "../utils/jitter_buffer.js";
import { TimeBufferChecker } from "../utils/time_buffer_checker.js";
import {
  diagTime,
  getOrCreateRelayUrl,
  getTrackNames,
  generateTrackNamePrefix,
  getTrackNamePrefix,
} from "./helpers";
import type { DiagEvent, DownloaderConfig } from "./types";

// Audio states
const AUDIO_STOPPED = 0;
const AUDIO_PLAYING = 1;
const sourceBufferWorkletUrl = new URL(
  "../render/source_buffer_worklet.js",
  import.meta.url
);
export function Player() {
  const params = useParams<{ roomName?: string }>();

  // --- Signals ---
  const [relayUrl, setRelayUrl] = createSignal(getOrCreateRelayUrl());
  const [namespace, setNamespace] = createSignal("vc");
  const [trackNamePrefix, setTrackNamePrefix] = createSignal(
    params.roomName || getTrackNamePrefix() || generateTrackNamePrefix()
  );
  const [isPlaying, setIsPlaying] = createSignal(false);
  const [connectionStatus, setConnectionStatus] = createSignal("disconnected");
  const [diagLog, setDiagLog] = createSignal<DiagEvent[]>([]);
  const [speakerOn, setSpeakerOn] = createSignal(true);

  // Jitter buffer config
  const [audioJitterMs, setAudioJitterMs] = createSignal(300);
  const [videoJitterMs, setVideoJitterMs] = createSignal(300);
  const [playerBufferMs, setPlayerBufferMs] = createSignal(100);
  const [playerMaxBufferMs, setPlayerMaxBufferMs] = createSignal(800);

  // Stats
  const [videoLatencyMs, setVideoLatencyMs] = createSignal(0);
  const [audioLatencyMs, setAudioLatencyMs] = createSignal(0);
  const [audioBufferMs, setAudioBufferMs] = createSignal(0);
  const [videoJitterSize, setVideoJitterSize] = createSignal(0);
  const [audioJitterSize, setAudioJitterSize] = createSignal(0);

  // Workers & renderer refs
  let muxerDownloaderWorker: Worker | null = null;
  let audioDecoderWorker: Worker | null = null;
  let canvasRef: HTMLCanvasElement | undefined;
  let canvasCtx: CanvasRenderingContext2D | null = null;
  let animFrame: number | null = null;
  let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  // Main-thread video decoder
  let videoDecoder: VideoDecoder | null = null;
  let currentVideoFrame: VideoFrame | null = null;
  let lastVideoMetadata: ArrayBuffer | null = null;
  let waitForKeyFrame = true;
  let videoFrameCount = 0;
  let lastRenderedFrameTimestamp = -1;

  // Video chunk sequential processing
  let videoChunkQueue: Array<{
    chunk: EncodedVideoChunk;
    metadata: ArrayBuffer | null;
    isDisco: boolean;
    seqId: number;
  }> = [];
  let videoChunkProcessing = false;

  // Jitter buffers
  let wtVideoJitterBuffer: any = null;
  let wtAudioJitterBuffer: any = null;

  // Audio
  let audioCtx: AudioContext | null = null;
  let sourceBufferAudioWorklet: AudioWorkletNode | null = null;
  let audioSharedBuffer: any = null;
  let systemAudioLatencyMs = 0;
  let audioState = AUDIO_STOPPED;

  // Latency checkers
  let latencyAudioChecker: any = null;
  let latencyVideoChecker: any = null;

  // Video render buffer
  let videoRendererBuffer: any = null;

  // Timing info
  const timingInfo = {
    muxer: { currentAudioTs: -1, currentVideoTs: -1 },
    decoder: { currentAudioTs: -1, currentVideoTs: -1 },
    renderer: { currentAudioTS: -1, currentVideoTS: -1 },
  };
  const buffersInfo = {
    decoder: {
      audio: { size: -1, lengthMs: -1, timestampCompensationOffset: -1 },
      video: { size: -1, lengthMs: -1 },
    },
    renderer: {
      audio: { size: -1, lengthMs: -1, sizeMs: -1, state: AUDIO_STOPPED },
      video: { size: -1, lengthMs: -1 },
    },
  };

  function addDiag(tag: string, msg: string) {
    setDiagLog((prev) => [{ t: diagTime(), tag, msg }, ...prev].slice(0, 200));
  }

  function saveRelay(url: string) {
    setRelayUrl(url);
    localStorage.setItem("moq-test4-relay-url", url);
    window.location.reload();
  }

  function compareArrayBuffer(
    buf1: ArrayBuffer | null,
    buf2: ArrayBuffer | null
  ): boolean {
    if (buf1 === buf2) return true;
    if (!buf1 || !buf2) return false;
    if (buf1.byteLength !== buf2.byteLength) return false;
    const v1 = new Uint8Array(buf1);
    const v2 = new Uint8Array(buf2);
    for (let i = 0; i < v1.length; i++) {
      if (v1[i] !== v2[i]) return false;
    }
    return true;
  }

  function initMainThreadVideoDecoder() {
    videoDecoder = new VideoDecoder({
      output: (vFrame: VideoFrame) => {
        if (currentVideoFrame) {
          currentVideoFrame.close();
        }
        currentVideoFrame = vFrame;
        videoFrameCount++;
      },
      error: (err: DOMException) => {
        console.error("[VIDEO-DECODER] Error:", err);
        addDiag("error", `VideoDecoder: ${err.message}`);
      },
    });
  }

  function closeMainThreadVideoDecoder() {
    videoChunkQueue = [];
    videoChunkProcessing = false;
    if (videoDecoder) {
      videoDecoder.close();
      videoDecoder = null;
    }
    if (currentVideoFrame) {
      currentVideoFrame.close();
      currentVideoFrame = null;
    }
    lastVideoMetadata = null;
    waitForKeyFrame = true;
    videoFrameCount = 0;
    lastRenderedFrameTimestamp = -1;
  }

  function enqueueVideoChunk(
    chunk: EncodedVideoChunk,
    metadata: ArrayBuffer | null,
    isDisco: boolean,
    seqId: number
  ) {
    videoChunkQueue.push({ chunk, metadata, isDisco, seqId });
    processVideoChunkQueue();
  }

  async function processVideoChunkQueue() {
    if (videoChunkProcessing || videoChunkQueue.length === 0) return;
    videoChunkProcessing = true;
    while (videoChunkQueue.length > 0) {
      const item = videoChunkQueue.shift()!;
      await processVideoChunk(
        item.chunk,
        item.metadata,
        item.isDisco,
        item.seqId
      );
    }
    videoChunkProcessing = false;
  }

  async function processVideoChunk(
    chunk: EncodedVideoChunk,
    metadata: ArrayBuffer | null,
    isDisco: boolean,
    _seqId: number
  ) {
    if (!videoDecoder) return;

    if (metadata && !compareArrayBuffer(lastVideoMetadata, metadata)) {
      const avcInfo = ParseAVCDecoderConfigurationRecord(metadata);
      const codecString =
        GetVideoCodecStringFromAVCDecoderConfigurationRecord(avcInfo);
      videoDecoder.configure({
        codec: codecString,
        description: metadata,
        optimizeForLatency: true,
        hardwareAcceleration: "prefer-software",
      });
      lastVideoMetadata = metadata;
      waitForKeyFrame = true;
    }

    if (isDisco) {
      waitForKeyFrame = true;
    }

    if (waitForKeyFrame && chunk.type !== "key") return;
    if (chunk.type === "key") waitForKeyFrame = false;

    if (videoDecoder.state === "configured") {
      videoDecoder.decode(chunk);
      buffersInfo.decoder.video.size = videoDecoder.decodeQueueSize;
      timingInfo.decoder.currentVideoTs = chunk.timestamp;
    }
  }

  async function initializeAudioContext(desiredSampleRate: number) {
    if (audioCtx != null) return;

    audioCtx = new AudioContext({
      latencyHint: "interactive",
      sampleRate: desiredSampleRate,
    });
    await audioCtx.resume();

    await audioCtx.audioWorklet.addModule(sourceBufferWorkletUrl.href);
    sourceBufferAudioWorklet = new AudioWorkletNode(
      audioCtx,
      "source-buffer"
    );
    sourceBufferAudioWorklet.port.onmessage = (e: MessageEvent) => {
      processWorkerMessage(e);
    };
    sourceBufferAudioWorklet.onprocessorerror = (event: Event) => {
      console.error("Audio worklet error:", event);
    };
    sourceBufferAudioWorklet.connect(audioCtx.destination);

    systemAudioLatencyMs =
      (audioCtx.outputLatency + audioCtx.baseLatency) * 1000;
  }

  async function processWorkerMessage(e: MessageEvent) {
    const { type } = e.data;

    if (type === "diaglog") {
      addDiag("worker", e.data.data);
      return;
    }

    if (type === "debug") {
      console.debug(e.data.data);
    } else if (type === "info") {
      console.log(e.data.data);
      addDiag("info", String(e.data.data));
      if (
        typeof e.data.data === "string" &&
        e.data.data.includes("MOQ Initialized")
      ) {
        setConnectionStatus("connected");
      }
    } else if (type === "error") {
      console.error(e.data.data);
      addDiag("error", String(e.data.data));
    } else if (type === "warning") {
      console.warn(e.data.data);

      // --- Video chunk from receiver ---
    } else if (type === "videochunk") {
      const chunk = e.data.chunk;
      const seqId = e.data.seqId;
      const extraData = {
        captureClkms: e.data.captureClkms,
        metadata: e.data.metadata,
      };

      if (wtVideoJitterBuffer != null) {
        const ordered = wtVideoJitterBuffer.AddItem(chunk, seqId, extraData);
        if (ordered !== undefined) {
          if (ordered.repeatedOrBackwards) {
            console.warn(
              `VIDEO Repeated or backwards, discarding seqId: ${ordered.seqId}`
            );
          } else {
            latencyVideoChecker?.AddItem({
              ts: ordered.chunk.timestamp,
              clkms: ordered.extraData.captureClkms,
            });
            timingInfo.muxer.currentVideoTs = ordered.chunk.timestamp;
            enqueueVideoChunk(
              ordered.chunk,
              ordered.extraData.metadata,
              ordered.isDisco,
              ordered.seqId
            );
          }
        }
        const stats = wtVideoJitterBuffer.GetStats();
        setVideoJitterSize(stats.size);
      }

      // --- Audio chunk from receiver ---
    } else if (type === "audiochunk") {
      const chunk = e.data.chunk;
      const seqId = e.data.seqId;
      const extraData = {
        captureClkms: e.data.captureClkms,
        metadata: e.data.metadata,
        sampleFreq: e.data.sampleFreq,
        numChannels: e.data.numChannels,
        packagerType: e.data.packagerType,
      };

      if (wtAudioJitterBuffer != null) {
        const ordered = wtAudioJitterBuffer.AddItem(chunk, seqId, extraData);
        if (ordered !== undefined) {
          if (ordered.repeatedOrBackwards) {
            console.warn(
              `AUDIO Repeated or backwards, discarding seqId: ${ordered.seqId}`
            );
          } else {
            latencyAudioChecker?.AddItem({
              ts: ordered.chunk.timestamp,
              clkms: ordered.extraData.captureClkms,
            });
            timingInfo.muxer.currentAudioTs = ordered.chunk.timestamp;
            audioDecoderWorker?.postMessage({
              type: "audiochunk",
              seqId: ordered.seqId,
              chunk: ordered.chunk,
              metadata: ordered.extraData.metadata,
              sampleFreq: ordered.extraData.sampleFreq,
              numChannels: ordered.extraData.numChannels,
              isDisco: ordered.isDisco,
              packagerType: ordered.extraData.packagerType,
            });
          }
        }
        const stats = wtAudioJitterBuffer.GetStats();
        setAudioJitterSize(stats.size);
      }

      // --- Decoded audio frame ---
    } else if (type === "aframe") {
      const aFrame = e.data.frame;

      timingInfo.decoder.currentAudioTs =
        aFrame.timestamp + e.data.timestampCompensationOffset;
      buffersInfo.decoder.audio.timestampCompensationOffset =
        e.data.timestampCompensationOffset;
      buffersInfo.decoder.audio.size = e.data.queueSize;
      buffersInfo.decoder.audio.lengthMs = e.data.queueLengthMs;

      if (audioCtx == null && aFrame.sampleRate > 0) {
        await initializeAudioContext(aFrame.sampleRate);
      }

      if (
        audioCtx != null &&
        sourceBufferAudioWorklet != null &&
        audioSharedBuffer === null
      ) {
        const bufSizeMs = Math.max(
          playerMaxBufferMs(),
          playerBufferMs() * 2,
          100
        );
        buffersInfo.renderer.audio.sizeMs = bufSizeMs;
        const bufferSizeSamples = Math.floor(
          (bufSizeMs * aFrame.sampleRate) / 1000
        );

        audioSharedBuffer = new CicularAudioSharedBuffer();
        audioSharedBuffer.Init(
          aFrame.numberOfChannels,
          bufferSizeSamples,
          audioCtx.sampleRate
        );

        sourceBufferAudioWorklet.port.postMessage({
          type: "iniabuffer",
          config: {
            contextSampleFrequency: audioCtx.sampleRate,
            circularBufferSizeSamples: bufferSizeSamples,
            cicularAudioSharedBuffers: audioSharedBuffer.GetSharedBuffers(),
            sampleFrequency: aFrame.sampleRate,
          },
        });
      }

      if (audioSharedBuffer != null) {
        audioSharedBuffer.Add(aFrame, timingInfo.decoder.currentAudioTs);
        if (animFrame === null) {
          animFrame = requestAnimationFrame(renderLoop);
        }
      }
      aFrame.close();

      // --- Downloader stats ---
    } else if (type === "downloaderstats") {
      // Stats from downloader (ignored for now)

      // --- Dropped ---
    } else if (type === "dropped") {
      addDiag("dropped", JSON.stringify(e.data.data));

      // --- Publisher done ---
    } else if (type === "publishdone") {
      console.warn(
        "PUBLISH_DONE: Publisher disconnected (status=" +
          e.data.statusCode +
          ")"
      );
      addDiag("info", "Publisher disconnected");
      await stop();
    }
  }

  function renderVideoFrame() {
    if (!currentVideoFrame) return;
    if (currentVideoFrame.timestamp === lastRenderedFrameTimestamp) return;

    if (!canvasCtx && canvasRef) {
      canvasCtx = canvasRef.getContext("2d", {
        alpha: false,
        desynchronized: true,
      });
    }
    if (!canvasCtx) return;

    try {
      const frame = currentVideoFrame;
      const canvas = canvasCtx.canvas;
      if (
        canvas.width !== frame.displayWidth ||
        canvas.height !== frame.displayHeight
      ) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      canvasCtx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      lastRenderedFrameTimestamp = frame.timestamp;
      timingInfo.renderer.currentVideoTS = frame.timestamp;
    } catch (err) {
      console.error("[VIDEO-RENDER] Error:", err);
    }
  }

  function renderLoop(_wcTimestamp: number) {
    renderVideoFrame();

    if (audioSharedBuffer != null) {
      const stats = audioSharedBuffer.GetStats();
      timingInfo.renderer.currentAudioTS = stats.currentTimestamp;
      buffersInfo.renderer.audio.size = stats.queueSize;
      buffersInfo.renderer.audio.lengthMs = stats.queueLengthMs;
      setAudioBufferMs(stats.queueLengthMs);

      if (stats.isPlaying) {
        audioState = AUDIO_PLAYING;
      }

      // Detect underrun
      if (audioState === AUDIO_PLAYING && stats.queueLengthMs < 10) {
        audioSharedBuffer.Pause();
        audioState = AUDIO_STOPPED;
        console.warn(
          `[AUDIO-REBUFFER] Underrun (${stats.queueLengthMs}ms left)`
        );
      }

      // Start playback when buffer is full enough
      if (
        buffersInfo.renderer.audio.lengthMs >= playerBufferMs() &&
        audioState === AUDIO_STOPPED
      ) {
        audioSharedBuffer.Play();
        audioState = AUDIO_PLAYING;
      }
    }

    // Latency tracking
    if (latencyVideoChecker != null && timingInfo.renderer.currentVideoTS > 0) {
      const closest = latencyVideoChecker.GetItemByTs(
        timingInfo.renderer.currentVideoTS,
        true
      );
      if (closest.valid) {
        setVideoLatencyMs(Date.now() - Number(closest.clkms));
      }
    }
    if (latencyAudioChecker != null && timingInfo.renderer.currentAudioTS > 0) {
      const closest = latencyAudioChecker.GetItemByTs(
        Math.floor(timingInfo.renderer.currentAudioTS),
        false
      );
      if (closest.valid) {
        setAudioLatencyMs(
          systemAudioLatencyMs + (Date.now() - Number(closest.clkms))
        );
      }
    }

    animFrame = requestAnimationFrame(renderLoop);
  }

  async function start() {
    if (isPlaying()) return;
    setIsPlaying(true);
    setConnectionStatus("connecting");
    addDiag("info", "Starting player...");

    wtVideoJitterBuffer = new JitterBuffer(videoJitterMs(), (data: any) =>
      console.warn(`[VIDEO-JITTER] Dropped seqId: ${data.seqId}`)
    );
    wtAudioJitterBuffer = new JitterBuffer(audioJitterMs(), (data: any) =>
      console.warn(`[AUDIO-JITTER] Dropped seqId: ${data.seqId}`)
    );
    latencyAudioChecker = new TimeBufferChecker("audio");
    latencyVideoChecker = new TimeBufferChecker("video");
    videoRendererBuffer = new VideoRenderBuffer();

    // Create workers
    muxerDownloaderWorker = new Worker(
      new URL("../receiver/moq_demuxer_downloader.js", import.meta.url),
      {
        type: "module",
      }
    );
    audioDecoderWorker = new Worker(
      new URL("../decode/audio_decoder.js", import.meta.url),
      {
        type: "module",
      }
    );

    // Main-thread video decoder
    initMainThreadVideoDecoder();

    // Attach message handlers
    muxerDownloaderWorker.addEventListener("message", processWorkerMessage);
    audioDecoderWorker.addEventListener("message", processWorkerMessage);
    muxerDownloaderWorker.addEventListener("error", (e) => {
      console.error("[PLAYER-ERROR] Downloader worker error:", e.message);
      addDiag("error", `Downloader error: ${e.message}`);
    });
    audioDecoderWorker.addEventListener("error", (e) => {
      console.error("[PLAYER-ERROR] Audio decoder worker error:", e.message);
      addDiag("error", `Audio decoder error: ${e.message}`);
    });

    // Build downloader config
    const ns = namespace().split("/");
    const tracks = getTrackNames(trackNamePrefix());

    // Load certificate hash for self-signed relay certs (binary file served from app origin)
    let certHash: ArrayBuffer | null = null;
    try {
      const certUrl = `${location.origin}/certs/certificate_fingerprint.hex`;
      const resp = await fetch(certUrl);
      if (resp.ok) {
        certHash = await resp.arrayBuffer();
        addDiag("info", `Loaded certificate fingerprint from ${certUrl} (${certHash.byteLength} bytes)`);
      }
    } catch (err) {
      addDiag("warning", `Could not load cert hash: ${err}`);
    }

    const config: DownloaderConfig = {
      urlHostPort: relayUrl(),
      urlPath: "",
      certificateHash: certHash,
      moqTracks: {
        audio: {
          alias: 0,
          namespace: ns,
          name: tracks.audio,
          authInfo: "",
        },
        video: {
          alias: 1,
          namespace: ns,
          name: tracks.video,
          authInfo: "",
        },
      },
    };

    muxerDownloaderWorker.postMessage({
      type: "downloadersendini",
      downloaderConfig: config,
    });

    addDiag(
      "info",
      `Subscribing: ns=${ns.join("/")} audio=${tracks.audio} video=${tracks.video}`
    );

    // Health monitoring
    healthCheckInterval = setInterval(() => {
      const queueDepth = videoRendererBuffer
        ? videoRendererBuffer.elementsList?.length ?? 0
        : 0;
      console.log("[RENDERER-HEALTH]", {
        queueDepth,
        decoderQueueSize: buffersInfo.decoder.video.size,
      });
    }, 1000);
  }

  async function stop() {
    if (!isPlaying()) return;
    addDiag("info", "Stopping player...");

    if (animFrame != null) {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }

    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }

    muxerDownloaderWorker?.postMessage({ type: "stop" });
    audioDecoderWorker?.postMessage({ type: "stop" });

    closeMainThreadVideoDecoder();

    if (audioCtx !== null) {
      await audioCtx.close();
      audioCtx = null;
    }
    sourceBufferAudioWorklet = null;
    if (audioSharedBuffer != null) {
      audioSharedBuffer.Clear();
      audioSharedBuffer = null;
    }
    audioState = AUDIO_STOPPED;

    canvasCtx = null;
    wtVideoJitterBuffer = null;
    wtAudioJitterBuffer = null;
    latencyAudioChecker = null;
    latencyVideoChecker = null;
    if (videoRendererBuffer) {
      videoRendererBuffer.Clear();
      videoRendererBuffer = null;
    }

    muxerDownloaderWorker = null;
    audioDecoderWorker = null;

    // Reset timing
    timingInfo.muxer.currentAudioTs = -1;
    timingInfo.muxer.currentVideoTs = -1;
    timingInfo.decoder.currentAudioTs = -1;
    timingInfo.decoder.currentVideoTs = -1;
    timingInfo.renderer.currentAudioTS = -1;
    timingInfo.renderer.currentVideoTS = -1;

    setIsPlaying(false);
    setConnectionStatus("disconnected");
    setVideoLatencyMs(0);
    setAudioLatencyMs(0);
    setAudioBufferMs(0);
    setVideoJitterSize(0);
    setAudioJitterSize(0);
  }

  onCleanup(() => {
    if (isPlaying()) stop();
  });

  const fullTrackNames = () => {
    const t = getTrackNames(trackNamePrefix());
    return `${namespace()}/${t.audio}, ${namespace()}/${t.video}`;
  };

  return (
    <div class="min-h-screen bg-gray-950 text-white">
    <div class="max-w-4xl mx-auto p-4 space-y-6">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-bold">MoQ Test 4 - Player</h1>
        <div class="flex gap-2 text-sm">
          <a href="/encoder" class="text-gray-400 hover:underline">
            Encoder
          </a>
          <span class="text-gray-600">|</span>
          <a href="/player" class="text-blue-400 hover:underline font-medium">
            Player
          </a>
        </div>
      </div>

      {/* Config Section */}
      <div class="bg-gray-900 border border-gray-700 rounded-lg p-4 space-y-3">
        <h2 class="text-sm font-medium text-gray-400">Connection</h2>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label class="block">
            <span class="text-xs text-gray-500">Relay URL</span>
            <select
              value={relayUrl()}
              onChange={(e) => saveRelay(e.currentTarget.value)}
              disabled={isPlaying()}
              class="w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm font-mono disabled:opacity-50"
            >
              <option value="https://localhost:4433/moq">https://localhost:4433/moq (moxygen)</option>
              <option value="http://localhost:4443">http://localhost:4443 (moq-dev)</option>
              <option value="https://localhost:4434/moq">https://localhost:4434/moq (moqtail)</option>
            </select>
          </label>
          <label class="block">
            <span class="text-xs text-gray-500">Namespace</span>
            <input
              type="text"
              value={namespace()}
              onInput={(e) => setNamespace(e.currentTarget.value)}
              disabled={isPlaying()}
              class="w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm font-mono disabled:opacity-50"
            />
          </label>
          <label class="block">
            <span class="text-xs text-gray-500">Track Name Prefix</span>
            <input
              type="text"
              value={trackNamePrefix()}
              onInput={(e) => setTrackNamePrefix(e.currentTarget.value)}
              disabled={isPlaying()}
              class="w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm font-mono disabled:opacity-50"
            />
          </label>
          <div>
            <span class="text-xs text-gray-500">Full Track Names</span>
            <div class="mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm font-mono text-gray-400 truncate">
              {fullTrackNames()}
            </div>
          </div>
        </div>

        <h2 class="text-sm font-medium text-gray-400 pt-2">
          Playback Settings
        </h2>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <label class="block">
            <span class="text-xs text-gray-500">
              Audio Jitter Buffer (ms)
            </span>
            <input
              type="number"
              value={audioJitterMs()}
              onInput={(e) => {
                setAudioJitterMs(Number(e.currentTarget.value));
                wtAudioJitterBuffer?.UpdateMaxSize(
                  Number(e.currentTarget.value)
                );
              }}
              class="w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm font-mono"
            />
          </label>
          <label class="block">
            <span class="text-xs text-gray-500">
              Video Jitter Buffer (ms)
            </span>
            <input
              type="number"
              value={videoJitterMs()}
              onInput={(e) => {
                setVideoJitterMs(Number(e.currentTarget.value));
                wtVideoJitterBuffer?.UpdateMaxSize(
                  Number(e.currentTarget.value)
                );
              }}
              class="w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm font-mono"
            />
          </label>
          <label class="block">
            <span class="text-xs text-gray-500">
              Min Audio Buffer (ms)
            </span>
            <input
              type="number"
              value={playerBufferMs()}
              onInput={(e) => setPlayerBufferMs(Number(e.currentTarget.value))}
              disabled={isPlaying()}
              class="w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm font-mono disabled:opacity-50"
            />
          </label>
          <label class="block">
            <span class="text-xs text-gray-500">
              Max Audio Buffer (ms)
            </span>
            <input
              type="number"
              value={playerMaxBufferMs()}
              onInput={(e) =>
                setPlayerMaxBufferMs(Number(e.currentTarget.value))
              }
              disabled={isPlaying()}
              class="w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm font-mono disabled:opacity-50"
            />
          </label>
        </div>

        <div class="flex gap-3 pt-2">
          <button
            onClick={start}
            disabled={isPlaying()}
            class="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
          >
            Start
          </button>
          <button
            onClick={stop}
            disabled={!isPlaying()}
            class="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
          >
            Stop
          </button>
        </div>
      </div>

      {/* Video Canvas */}
      <div class="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
        <div class="text-xs text-gray-500 px-3 py-1.5 border-b border-gray-700">
          Video Player
        </div>
        <canvas
          ref={canvasRef}
          width="854"
          height="480"
          class="w-full bg-black"
        />
      </div>

      {/* Stats */}
      <Show when={isPlaying()}>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-2">
          <div class="bg-gray-900 border border-gray-700 rounded p-2 text-center">
            <div class="text-gray-500 text-xs">Video Latency</div>
            <div class="font-mono">{videoLatencyMs().toFixed(0)} ms</div>
          </div>
          <div class="bg-gray-900 border border-gray-700 rounded p-2 text-center">
            <div class="text-gray-500 text-xs">Audio Latency</div>
            <div class="font-mono">{audioLatencyMs().toFixed(0)} ms</div>
          </div>
          <div class="bg-gray-900 border border-gray-700 rounded p-2 text-center">
            <div class="text-gray-500 text-xs">Audio Buffer</div>
            <div class="font-mono">{audioBufferMs().toFixed(0)} ms</div>
          </div>
          <div class="bg-gray-900 border border-gray-700 rounded p-2 text-center">
            <div class="text-gray-500 text-xs">Video Jitter</div>
            <div class="font-mono">{videoJitterSize()}</div>
          </div>
          <div class="bg-gray-900 border border-gray-700 rounded p-2 text-center">
            <div class="text-gray-500 text-xs">Audio Jitter</div>
            <div class="font-mono">{audioJitterSize()}</div>
          </div>
        </div>
      </Show>

      {/* Debug Panel */}
      <DebugPanel
        connectionStatus={connectionStatus}
        roomName={() => trackNamePrefix()}
        publishingAudio={() => false}
        speakerOn={() => speakerOn() && isPlaying()}
        participantCount={() => (isPlaying() ? 1 : 0)}
        pubRms={() => 0}
        subRms={() => 0}
        diagLog={diagLog}
      />
    </div>
    </div>
  );
}
