declare class MediaStreamTrackProcessor<T = VideoFrame | AudioData> {
  readonly readable: ReadableStream<T>;

  constructor(init: { track: MediaStreamTrack });
}
