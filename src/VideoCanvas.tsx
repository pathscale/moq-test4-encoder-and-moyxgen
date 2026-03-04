import { createEffect } from "solid-js";

interface VideoCanvasProps {
  frame: () => VideoFrame | undefined;
  flip?: boolean;
}

export function VideoCanvas(props: VideoCanvasProps) {
  let canvasRef!: HTMLCanvasElement;

  createEffect(() => {
    const frameRaw = props.frame();
    if (!frameRaw || !canvasRef) return;
    const frame = frameRaw.clone();
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (canvasRef.width !== w || canvasRef.height !== h) {
      canvasRef.width = w;
      canvasRef.height = h;
    }
    const ctx = canvasRef.getContext("2d");
    if (!ctx) {
      frame.close();
      return;
    }
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    if (props.flip) {
      ctx.scale(-1, 1);
      ctx.drawImage(frame, -w, 0, w, h);
    } else {
      ctx.drawImage(frame, 0, 0, w, h);
    }
    ctx.restore();
    frame.close();
  });

  return (
    <canvas ref={canvasRef} class="w-full h-full object-cover bg-black" />
  );
}
