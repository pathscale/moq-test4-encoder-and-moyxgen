export interface DiagEvent {
  t: number;
  tag: string;
  msg: string;
}

export interface MuxerSenderConfig {
  urlHostPort: string;
  urlPath: string;
  keepAlivesEveryMs: number;
  certificateHash: ArrayBuffer | null;
  usePublishNamespace: boolean;
  moqTracks: {
    audio: SenderTrackConfig;
    video: SenderTrackConfig;
  };
}

export interface SenderTrackConfig {
  namespace: string[];
  name: string;
  maxInFlightRequests: number;
  isHipri: boolean;
  authInfo: string;
  moqMapping: string;
}

export interface DownloaderConfig {
  urlHostPort: string;
  urlPath: string;
  certificateHash: ArrayBuffer | null;
  moqTracks: {
    audio: ReceiverTrackConfig;
    video: ReceiverTrackConfig;
  };
}

export interface ReceiverTrackConfig {
  alias: number;
  namespace: string[];
  name: string;
  authInfo: string;
}
