import { createSignal, onCleanup, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import { DebugPanel } from "./DebugPanel";
import { TimeBufferChecker } from "../utils/time_buffer_checker.js";
import {
  diagTime,
  getOrCreateRelayUrl,
  getOrCreateStreamName,
  generateTrackNamePrefix,
  getTrackNames,
  setTrackNamePrefix as persistTrackPrefix,
} from "./helpers";
import type { DiagEvent, MuxerSenderConfig } from "./types";

// MOQ_MAPPING_SUBGROUP_PER_GROUP value from moqt.js
const MOQ_MAPPING_SUBGROUP_PER_GROUP = "SubGroupPerObj";
export function Encoder() {
  const params = useParams<{ roomName?: string }>();

  // --- Signals ---
  const [relayUrl, setRelayUrl] = createSignal(getOrCreateRelayUrl());
  const [namespace, setNamespace] = createSignal("vc");
  const [trackNamePrefix, setTrackNamePrefix] = createSignal(
    params.roomName || generateTrackNamePrefix()
  );
  const [isPublishing, setIsPublishing] = createSignal(false);
  const [connectionStatus, setConnectionStatus] = createSignal("disconnected");
  const [diagLog, setDiagLog] = createSignal<DiagEvent[]>([]);

  // Stats signals
  const [audioInflight, setAudioInflight] = createSignal(0);
  const [videoInflight, setVideoInflight] = createSignal(0);
  const [maxAudioInflight, setMaxAudioInflight] = createSignal(0);
  const [maxVideoInflight, setMaxVideoInflight] = createSignal(0);
  const [lastAudioSeqId, setLastAudioSeqId] = createSignal(0);
  const [lastVideoSeqId, setLastVideoSeqId] = createSignal(0);

  // Encoding params
  const [videoWidth, setVideoWidth] = createSignal(854);
  const [videoHeight, setVideoHeight] = createSignal(480);
  const [videoFps, setVideoFps] = createSignal(30);
  const [videoBitrate, setVideoBitrate] = createSignal(750000);
  const [keyframeEvery, setKeyframeEvery] = createSignal(60);

  // Workers + MediaStream refs
  let vStreamWorker: Worker | null = null;
  let aStreamWorker: Worker | null = null;
  let vEncoderWorker: Worker | null = null;
  let aEncoderWorker: Worker | null = null;
  let muxerSenderWorker: Worker | null = null;
  let mediaStream: MediaStream | null = null;
  let videoPreviewRef: HTMLVideoElement | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Timestamp offset tracking (for A/V sync compensation)
  let currentAudioTs: number | undefined;
  let currentVideoTs: number | undefined;
  let videoOffsetTS: number | undefined;
  let audioOffsetTS: number | undefined;

  let audioTimeChecker: any = null;
  let videoTimeChecker: any = null;

  function addDiag(tag: string, msg: string) {
    setDiagLog((prev) => [{ t: diagTime(), tag, msg }, ...prev].slice(0, 200));
  }

  function saveRelay(url: string) {
    setRelayUrl(url);
    localStorage.setItem("moq-test4-relay-url", url);
    window.location.reload();
  }

  function processWorkerMessage(e: MessageEvent) {
    const { type, data } = e.data;

    // Diagnostic log capture from workers
    if (type === "diaglog") {
      addDiag("worker", e.data.data);
      return;
    }

    // Logging
    if (type === "debug") {
      console.debug(data);
    } else if (type === "info") {
      console.log(data);
      addDiag("info", String(data));
      if (typeof data === "string" && data.includes("MOQ Initialized")) {
        setConnectionStatus("connected");
      }
    } else if (type === "error") {
      console.error(data);
      addDiag("error", String(data));
    } else if (type === "warning") {
      console.warn(data);

      // --- Encoding: video frame from capture ---
    } else if (type === "vframe") {
      const vFrame = e.data.data;
      const videoTs = vFrame.timestamp;
      let estimatedDuration = -1;
      if (currentVideoTs === undefined) {
        if (audioOffsetTS === undefined) {
          videoOffsetTS = -videoTs;
        } else {
          videoOffsetTS = -videoTs + (currentAudioTs ?? 0) + audioOffsetTS;
        }
      } else {
        estimatedDuration = videoTs - currentVideoTs;
      }
      currentVideoTs = videoTs;
      videoTimeChecker?.AddItem({
        ts: videoTs,
        compensatedTs: videoTs + (videoOffsetTS ?? 0),
        estimatedDuration,
        clkms: e.data.clkms,
      });
      vEncoderWorker?.postMessage({ type: "vframe", vframe: vFrame }, [
        vFrame,
      ]);

      // --- Encoding: audio frame from capture ---
    } else if (type === "aframe") {
      const aFrame = e.data.data;
      const audioTs = aFrame.timestamp;
      let estimatedDuration = -1;
      if (currentAudioTs === undefined) {
        if (videoOffsetTS === undefined) {
          audioOffsetTS = -audioTs;
        } else {
          audioOffsetTS = -audioTs + (currentVideoTs ?? 0) + videoOffsetTS;
        }
      } else {
        estimatedDuration = audioTs - currentAudioTs;
      }
      currentAudioTs = audioTs;
      audioTimeChecker?.AddItem({
        ts: audioTs,
        compensatedTs: audioTs + (audioOffsetTS ?? 0),
        estimatedDuration,
        clkms: e.data.clkms,
      });
      aEncoderWorker?.postMessage({ type: "aframe", aframe: aFrame });

      // --- Encoded video chunk ---
    } else if (type === "vchunk") {
      const chunk = e.data.chunk;
      const metadata = e.data.metadata;
      const seqId = e.data.seqId;
      const timebase = e.data.timebase;
      const itemTsClk = videoTimeChecker?.GetItemByTs(chunk.timestamp) ?? {
        valid: false,
      };

      setLastVideoSeqId(seqId);
      muxerSenderWorker?.postMessage({
        type: "video",
        firstFrameClkms: itemTsClk.clkms,
        compensatedTs: itemTsClk.compensatedTs,
        estimatedDuration: itemTsClk.estimatedDuration,
        seqId,
        chunk,
        metadata,
        timebase,
      });

      // --- Encoded audio chunk ---
    } else if (type === "achunk") {
      const chunk = e.data.chunk;
      const metadata = e.data.metadata;
      const seqId = e.data.seqId;
      const timebase = e.data.timebase;
      const sampleFreq = e.data.sampleFreq;
      const numChannels = e.data.numChannels;
      const codec = e.data.codec;
      const itemTsClk = audioTimeChecker?.GetItemByTs(chunk.timestamp) ?? {
        valid: false,
      };

      setLastAudioSeqId(seqId);
      muxerSenderWorker?.postMessage({
        type: "audio",
        firstFrameClkms: itemTsClk.clkms,
        compensatedTs: itemTsClk.compensatedTs,
        seqId,
        chunk,
        metadata,
        timebase,
        sampleFreq,
        numChannels,
        codec,
      });

      // --- Send stats ---
    } else if (type === "sendstats") {
      const inflight = e.data.inFlightReq;
      setAudioInflight(inflight.audio ?? 0);
      setVideoInflight(inflight.video ?? 0);
      setMaxAudioInflight((prev) => Math.max(prev, inflight.audio ?? 0));
      setMaxVideoInflight((prev) => Math.max(prev, inflight.video ?? 0));

      // --- Dropped ---
    } else if (type === "dropped") {
      addDiag("dropped", JSON.stringify(e.data.data));
    }
  }

  async function start() {
    if (isPublishing()) return;
    setIsPublishing(true);
    setConnectionStatus("connecting");
    addDiag("info", "Starting encoder...");

    // Reset timestamp offsets
    currentAudioTs = undefined;
    currentVideoTs = undefined;
    videoOffsetTS = undefined;
    audioOffsetTS = undefined;
    setMaxAudioInflight(0);
    setMaxVideoInflight(0);

    audioTimeChecker = new TimeBufferChecker("audio");
    videoTimeChecker = new TimeBufferChecker("video");

    // Create workers
    vStreamWorker = new Worker(new URL("../capture/v_capture.js", import.meta.url), {
      type: "module",
    });
    aStreamWorker = new Worker(new URL("../capture/a_capture.js", import.meta.url), {
      type: "module",
    });
    vEncoderWorker = new Worker(new URL("../encode/v_encoder.js", import.meta.url), {
      type: "module",
    });
    aEncoderWorker = new Worker(new URL("../encode/a_encoder.js", import.meta.url), {
      type: "module",
    });
    muxerSenderWorker = new Worker(new URL("../sender/moq_sender.js", import.meta.url), {
      type: "module",
    });

    // Attach message handlers
    const workers = [
      vStreamWorker,
      aStreamWorker,
      vEncoderWorker,
      aEncoderWorker,
      muxerSenderWorker,
    ];
    for (const w of workers) {
      w.addEventListener("message", processWorkerMessage);
      w.addEventListener("error", (e) => {
        console.error("[ENCODER-ERROR] Worker error:", e.message);
        addDiag("error", `Worker error: ${e.message}`);
      });
    }

    // Get media
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: videoWidth() },
          height: { ideal: videoHeight() },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      addDiag("error", `getUserMedia failed: ${err}`);
      setIsPublishing(false);
      setConnectionStatus("disconnected");
      return;
    }

    // Show preview
    if (videoPreviewRef) {
      videoPreviewRef.srcObject = mediaStream;
    }

    // Get audio track settings for encoder config
    const audioTrack = mediaStream.getAudioTracks()[0];
    const audioSettings = audioTrack.getSettings();

    // Initialize encoders
    vEncoderWorker.postMessage({
      type: "vencoderini",
      encoderConfig: {
        codec: "avc1.42001e",
        width: videoWidth(),
        height: videoHeight(),
        bitrate: videoBitrate(),
        framerate: videoFps(),
        latencyMode: "realtime",
      },
      encoderMaxQueueSize: 2,
      keyframeEvery: keyframeEvery(),
    });

    aEncoderWorker.postMessage({
      type: "aencoderini",
      encoderConfig: {
        codec: "opus",
        sampleRate: audioSettings.sampleRate ?? 48000,
        numberOfChannels: audioSettings.channelCount ?? 1,
        bitrate: 32000,
        opus: { frameDuration: 10000 },
      },
      encoderMaxQueueSize: 10,
    });

    // Build muxer sender config
    const ns = namespace().split("/");
    const prefix = trackNamePrefix();
    persistTrackPrefix(prefix); // Persist to localStorage so player can discover
    const tracks = getTrackNames(prefix);

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

    const config: MuxerSenderConfig = {
      urlHostPort: relayUrl(),
      urlPath: "",
      keepAlivesEveryMs: 5000,
      certificateHash: certHash,
      usePublishNamespace: false,
      moqTracks: {
        audio: {
          namespace: ns,
          name: tracks.audio,
          maxInFlightRequests: 60,
          isHipri: true,
          authInfo: "",
          moqMapping: MOQ_MAPPING_SUBGROUP_PER_GROUP,
        },
        video: {
          namespace: ns,
          name: tracks.video,
          maxInFlightRequests: 39,
          isHipri: false,
          authInfo: "",
          moqMapping: MOQ_MAPPING_SUBGROUP_PER_GROUP,
        },
      },
    };
    muxerSenderWorker.postMessage({
      type: "muxersendini",
      muxerSenderConfig: config,
    });

    addDiag(
      "info",
      `Publishing: ns=${ns.join("/")} audio=${tracks.audio} video=${tracks.video}`
    );

    // Transfer media streams to capture workers
    const vTrack = mediaStream.getVideoTracks()[0];
    const vProcessor = new MediaStreamTrackProcessor({ track: vTrack });
    const vFrameStream = vProcessor.readable;
    vStreamWorker.postMessage(
      { type: "stream", vStream: vFrameStream },
      [vFrameStream]
    );

    const aProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
    const aFrameStream = aProcessor.readable;
    aStreamWorker.postMessage(
      { type: "stream", aStream: aFrameStream },
      [aFrameStream]
    );

    // Heartbeat
    heartbeatTimer = setInterval(() => {
      console.log(
        "[ENCODER-HEARTBEAT] video seqId:",
        lastVideoSeqId(),
        "audio seqId:",
        lastAudioSeqId()
      );
    }, 5000);
  }

  function stop() {
    if (!isPublishing()) return;
    addDiag("info", "Stopping encoder...");

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    const stopMsg = { type: "stop" };
    aStreamWorker?.postMessage(stopMsg);
    vStreamWorker?.postMessage(stopMsg);
    vEncoderWorker?.postMessage(stopMsg);
    aEncoderWorker?.postMessage(stopMsg);
    muxerSenderWorker?.postMessage(stopMsg);

    // Stop media tracks
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) {
        track.stop();
      }
      mediaStream = null;
    }
    if (videoPreviewRef) {
      videoPreviewRef.srcObject = null;
    }

    audioTimeChecker?.Clear();
    videoTimeChecker?.Clear();

    vStreamWorker = null;
    aStreamWorker = null;
    vEncoderWorker = null;
    aEncoderWorker = null;
    muxerSenderWorker = null;

    setIsPublishing(false);
    setConnectionStatus("disconnected");
    setAudioInflight(0);
    setVideoInflight(0);

    // Generate new track name for next session
    setTrackNamePrefix(generateTrackNamePrefix());
  }

  onCleanup(() => {
    if (isPublishing()) stop();
  });

  // Computed track names for display
  const fullTrackNames = () => {
    const t = getTrackNames(trackNamePrefix());
    return `${namespace()}/${t.audio}, ${namespace()}/${t.video}`;
  };

  return (
    <div class="min-h-screen bg-gray-950 text-white">
    <div class="max-w-4xl mx-auto p-4 space-y-6">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-bold">MoQ Test 4 - Encoder</h1>
        <div class="flex gap-2 text-sm">
          <a href="/encoder" class="text-blue-400 hover:underline font-medium">
            Encoder
          </a>
          <span class="text-gray-600">|</span>
          <a href="/player" class="text-gray-400 hover:underline">
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
              disabled={isPublishing()}
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
              disabled={isPublishing()}
              class="w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm font-mono disabled:opacity-50"
            />
          </label>
          <label class="block">
            <span class="text-xs text-gray-500">Track Name Prefix</span>
            <input
              type="text"
              value={trackNamePrefix()}
              onInput={(e) => setTrackNamePrefix(e.currentTarget.value)}
              disabled={isPublishing()}
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
          Video Encoding
        </h2>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <label class="block">
            <span class="text-xs text-gray-500">Resolution</span>
            <select
              value={`${videoWidth()}x${videoHeight()}`}
              onChange={(e) => {
                const [w, h] = e.currentTarget.value.split("x").map(Number);
                setVideoWidth(w);
                setVideoHeight(h);
              }}
              disabled={isPublishing()}
              class="w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm disabled:opacity-50"
            >
              <option value="320x180">320x180</option>
              <option value="854x480">854x480</option>
              <option value="1280x720">1280x720</option>
              <option value="1920x1080">1920x1080</option>
            </select>
          </label>
          <label class="block">
            <span class="text-xs text-gray-500">FPS</span>
            <select
              value={videoFps()}
              onChange={(e) => setVideoFps(Number(e.currentTarget.value))}
              disabled={isPublishing()}
              class="w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm disabled:opacity-50"
            >
              <option value="15">15</option>
              <option value="30">30</option>
            </select>
          </label>
          <label class="block">
            <span class="text-xs text-gray-500">Bitrate (bps)</span>
            <input
              type="number"
              value={videoBitrate()}
              onInput={(e) => setVideoBitrate(Number(e.currentTarget.value))}
              disabled={isPublishing()}
              class="w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm font-mono disabled:opacity-50"
            />
          </label>
          <label class="block">
            <span class="text-xs text-gray-500">Keyframe Every</span>
            <input
              type="number"
              value={keyframeEvery()}
              onInput={(e) => setKeyframeEvery(Number(e.currentTarget.value))}
              disabled={isPublishing()}
              class="w-full mt-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm font-mono disabled:opacity-50"
            />
          </label>
        </div>

        <div class="flex gap-3 pt-2">
          <button
            onClick={start}
            disabled={isPublishing()}
            class="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
          >
            Start
          </button>
          <button
            onClick={stop}
            disabled={!isPublishing()}
            class="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
          >
            Stop
          </button>
        </div>
      </div>

      {/* Video Preview */}
      <div class="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
        <div class="text-xs text-gray-500 px-3 py-1.5 border-b border-gray-700">
          Local Preview
        </div>
        <video
          ref={videoPreviewRef}
          autoplay
          muted
          playsinline
          class="w-full max-h-96 bg-black"
        />
      </div>

      {/* Inflight Stats */}
      <Show when={isPublishing()}>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div class="bg-gray-900 border border-gray-700 rounded p-2 text-center">
            <div class="text-gray-500 text-xs">Audio Inflight</div>
            <div class="font-mono">
              {audioInflight()}{" "}
              <span class="text-gray-500 text-xs">
                (max: {maxAudioInflight()})
              </span>
            </div>
          </div>
          <div class="bg-gray-900 border border-gray-700 rounded p-2 text-center">
            <div class="text-gray-500 text-xs">Video Inflight</div>
            <div class="font-mono">
              {videoInflight()}{" "}
              <span class="text-gray-500 text-xs">
                (max: {maxVideoInflight()})
              </span>
            </div>
          </div>
          <div class="bg-gray-900 border border-gray-700 rounded p-2 text-center">
            <div class="text-gray-500 text-xs">Audio SeqId</div>
            <div class="font-mono">{lastAudioSeqId()}</div>
          </div>
          <div class="bg-gray-900 border border-gray-700 rounded p-2 text-center">
            <div class="text-gray-500 text-xs">Video SeqId</div>
            <div class="font-mono">{lastVideoSeqId()}</div>
          </div>
        </div>
      </Show>

      {/* Debug Panel */}
      <DebugPanel
        connectionStatus={connectionStatus}
        roomName={() => trackNamePrefix()}
        publishingAudio={() => isPublishing()}
        speakerOn={() => false}
        participantCount={() => (isPublishing() ? 1 : 0)}
        pubRms={() => 0}
        subRms={() => 0}
        diagLog={diagLog}
      />
    </div>
    </div>
  );
}
