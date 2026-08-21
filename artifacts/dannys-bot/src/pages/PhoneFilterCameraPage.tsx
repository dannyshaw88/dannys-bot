import React, { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CircleStop, Video } from "lucide-react";

type FilterId = "off" | "long_hair" | "beard" | "cute_face" | "glasses" | "freckles" | "blush" | "cartoon";
type Point = { x: number; y: number };

const FILTERS: { id: FilterId; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "long_hair", label: "Long hair" },
  { id: "beard", label: "Beard" },
  { id: "cute_face", label: "Cute face" },
  { id: "glasses", label: "Glasses" },
  { id: "freckles", label: "Freckles" },
  { id: "blush", label: "Blush" },
  { id: "cartoon", label: "Cartoon" },
];

declare global {
  interface Window {
    FaceMesh?: any;
  }
}

function point(landmarks: any[], index: number, mirrored: boolean): Point {
  const p = landmarks[index] ?? { x: 0.5, y: 0.5 };
  return { x: (mirrored ? 1 - p.x : p.x), y: p.y };
}

function drawFaceFilter(
  ctx: CanvasRenderingContext2D,
  landmarks: any[] | null,
  filter: FilterId,
  width: number,
  height: number,
) {
  if (!landmarks || filter === "off") return;
  const mirrored = true;
  const p = (index: number) => {
    const v = point(landmarks, index, mirrored);
    return { x: v.x * width, y: v.y * height };
  };
  const left = p(234), right = p(454), forehead = p(10), chin = p(152);
  const eyeL = p(33), eyeR = p(263), mouthL = p(61), mouthR = p(291);
  const faceWidth = Math.max(1, Math.abs(right.x - left.x));
  const faceHeight = Math.max(1, Math.abs(chin.y - forehead.y));
  const centerX = (left.x + right.x) / 2;
  const centerY = (forehead.y + chin.y) / 2;
  const line = (a: Point, b: Point) => {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (filter === "long_hair") {
    ctx.fillStyle = "rgba(43, 22, 18, .88)";
    ctx.beginPath();
    ctx.ellipse(centerX, forehead.y + faceHeight * .14, faceWidth * .72, faceHeight * .72, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.ellipse(centerX, forehead.y + faceHeight * .27, faceWidth * .49, faceHeight * .47, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(67, 32, 24, .9)";
    ctx.fillRect(left.x - faceWidth * .22, forehead.y + faceHeight * .16, faceWidth * .18, faceHeight * .95);
    ctx.fillRect(right.x + faceWidth * .04, forehead.y + faceHeight * .16, faceWidth * .18, faceHeight * .95);
  }

  if (filter === "beard" || filter === "cartoon") {
    ctx.fillStyle = filter === "cartoon" ? "rgba(90, 45, 30, .45)" : "rgba(35, 24, 22, .82)";
    ctx.beginPath();
    ctx.moveTo(mouthL.x - faceWidth * .08, mouthL.y);
    ctx.quadraticCurveTo(centerX, chin.y + faceHeight * .08, mouthR.x + faceWidth * .08, mouthR.y);
    ctx.lineTo(mouthR.x, mouthR.y + faceHeight * .2);
    ctx.quadraticCurveTo(centerX, chin.y + faceHeight * .3, mouthL.x, mouthL.y + faceHeight * .2);
    ctx.closePath();
    ctx.fill();
  }

  if (filter === "glasses" || filter === "cartoon") {
    ctx.strokeStyle = filter === "cartoon" ? "#7dd3fc" : "#111827";
    ctx.lineWidth = Math.max(5, faceWidth * .035);
    const eyeY = (eyeL.y + eyeR.y) / 2;
    const eyeGap = Math.abs(eyeR.x - eyeL.x);
    ctx.beginPath();
    ctx.roundRect(eyeL.x - eyeGap * .28, eyeY - faceHeight * .07, eyeGap * .55, faceHeight * .2, faceHeight * .07);
    ctx.roundRect(eyeR.x - eyeGap * .27, eyeY - faceHeight * .07, eyeGap * .55, faceHeight * .2, faceHeight * .07);
    ctx.stroke();
    line({ x: eyeL.x + eyeGap * .27, y: eyeY }, { x: eyeR.x - eyeGap * .27, y: eyeY });
  }

  if (filter === "blush" || filter === "cute_face") {
    ctx.fillStyle = "rgba(248, 113, 113, .35)";
    for (const cheek of [p(50), p(280)]) {
      ctx.beginPath();
      ctx.ellipse(cheek.x, cheek.y + faceHeight * .05, faceWidth * .14, faceHeight * .06, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (filter === "freckles" || filter === "cute_face") {
    ctx.fillStyle = "rgba(120, 53, 15, .8)";
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const x = mouthL.x + (mouthR.x - mouthL.x) * t;
      const y = (mouthL.y + mouthR.y) / 2 - faceHeight * (.11 + (i % 2) * .025);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(2, faceWidth * .012), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (filter === "cute_face") {
    ctx.fillStyle = "rgba(255,255,255,.9)";
    for (const eye of [eyeL, eyeR]) {
      ctx.beginPath();
      ctx.arc(eye.x, eye.y, Math.max(4, faceWidth * .055), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(30, 41, 59, .95)";
      ctx.beginPath();
      ctx.arc(eye.x, eye.y, Math.max(2, faceWidth * .025), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.9)";
    }
  }

  ctx.restore();
}

export default function PhoneFilterCameraPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const meshRef = useRef<any>(null);
  const animationRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const serial = new URLSearchParams(window.location.search).get("serial") ?? "unknown";
  const storageKey = `phone-filter:${serial}`;
  const [filter, setFilter] = useState<FilterId>(() => (localStorage.getItem(storageKey) as FilterId) || "off");
  const filterRef = useRef<FilterId>(filter);
  const [status, setStatus] = useState("Starting camera…");
  const [recording, setRecording] = useState(false);
  const [ready, setReady] = useState(false);

  const loadFaceMesh = useCallback(async () => {
    if (window.FaceMesh) return;
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Face tracking library could not load"));
      document.head.appendChild(script);
    });
  }, []);

  useEffect(() => {
    let active = true;
    const start = async () => {
      try {
        await loadFaceMesh();
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: true,
        });
        if (!active) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        const mesh = new window.FaceMesh({ locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
        mesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: .6, minTrackingConfidence: .6 });
        mesh.onResults((results: any) => {
          const canvas = canvasRef.current;
          if (!canvas || !video.videoWidth) return;
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.save();
          ctx.scale(-1, 1);
          ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
          ctx.restore();
          drawFaceFilter(ctx, results.multiFaceLandmarks?.[0] ?? null, filterRef.current, canvas.width, canvas.height);
          setStatus(results.multiFaceLandmarks?.length ? "Face tracked" : "Show your face to the camera");
        });
        meshRef.current = mesh;
        setReady(true);
        const tick = async () => {
          if (!active || !videoRef.current || videoRef.current.readyState < 2) return;
          await mesh.send({ image: videoRef.current });
          animationRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (error: any) {
        setStatus(error?.message ?? "Camera permission or face tracking failed");
      }
    };
    start();
    return () => {
      active = false;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      meshRef.current?.close?.();
      streamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, [loadFaceMesh]);

  useEffect(() => {
    filterRef.current = filter;
    localStorage.setItem(storageKey, filter);
  }, [filter, storageKey]);

  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const capturePhoto = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob(blob => blob && downloadBlob(blob, `filtered-${Date.now()}.jpg`), "image/jpeg", .94);
  };

  const toggleRecording = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    const output = canvas.captureStream(30);
    streamRef.current?.getAudioTracks().forEach(track => output.addTrack(track));
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
      ? "video/webm;codecs=vp8,opus"
      : "video/webm";
    const recorder = new MediaRecorder(output, { mimeType });
    chunksRef.current = [];
    recorder.ondataavailable = event => { if (event.data.size) chunksRef.current.push(event.data); };
    recorder.onstop = () => downloadBlob(new Blob(chunksRef.current, { type: "video/webm" }), `filtered-${Date.now()}.webm`);
    recorder.start();
    recorderRef.current = recorder;
    setRecording(true);
  };

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <header className="px-4 py-3 flex items-center justify-between bg-zinc-950 border-b border-white/10">
        <div>
          <p className="font-semibold">Filter Camera</p>
          <p className="text-xs text-white/45">Device {serial} · phone-side capture</p>
        </div>
        <span className={`text-xs ${ready ? "text-emerald-400" : "text-amber-300"}`}>{status}</span>
      </header>
      <section className="relative flex-1 flex items-center justify-center bg-zinc-900 overflow-hidden">
        <video ref={videoRef} className="hidden" playsInline muted />
        <canvas ref={canvasRef} className="max-h-full max-w-full object-contain" />
        {!ready && <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60 px-8 text-center">{status}</div>}
      </section>
      <section className="bg-zinc-950 p-3 space-y-3">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {FILTERS.map(item => (
            <button key={item.id} onClick={() => setFilter(item.id)}
              className={`shrink-0 rounded-full px-3 py-2 text-xs ${filter === item.id ? "bg-violet-500 text-white" : "bg-white/10 text-white/70"}`}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex justify-center gap-3">
          <button onClick={capturePhoto} disabled={!ready} className="rounded-full bg-white text-black px-5 py-3 flex items-center gap-2 disabled:opacity-40">
            <Camera className="w-4 h-4" /> Capture photo
          </button>
          <button onClick={toggleRecording} disabled={!ready} className={`rounded-full px-5 py-3 flex items-center gap-2 ${recording ? "bg-red-500 text-white" : "bg-white/10 text-white"} disabled:opacity-40`}>
            {recording ? <CircleStop className="w-4 h-4" /> : <Video className="w-4 h-4" />}
            {recording ? "Stop video" : "Record video"}
          </button>
        </div>
        <p className="text-center text-[11px] text-white/40">Captured files are rendered from the filtered canvas and downloaded to this phone.</p>
      </section>
    </main>
  );
}