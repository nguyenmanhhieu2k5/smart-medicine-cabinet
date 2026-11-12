import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/services/api";

export type CameraStatus = "idle" | "starting" | "active" | "error";

export interface CameraDevice {
  deviceId: string;
  label: string;
}

function describeError(error: unknown): string {
  const name = (error as DOMException)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Chưa được cấp quyền dùng camera. Hãy cho phép trong cài đặt quyền riêng tư của Windows.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Không tìm thấy camera. Hãy kiểm tra webcam đã được cắm.";
  if (name === "NotReadableError" || name === "AbortError") return "Camera đang được ứng dụng khác sử dụng hoặc không phản hồi.";
  return "Không mở được camera.";
}

/** Phương sai Laplacian trên ảnh thu nhỏ — càng lớn khung hình càng nét. */
export function frameSharpness(data: Uint8ClampedArray, width: number, height: number): number {
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

export interface Capture {
  blob: Blob;
  /** Vùng cắt [x, y, w, h] theo tỉ lệ 0–1 (hiện không dùng: gửi nguyên khung hình). */
  crop: number[] | null;
}

export function useCamera(preferredDeviceId: string | null | undefined) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const reportedError = useRef(false);
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(preferredDeviceId ?? null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus((current) => (current === "error" ? current : "idle"));
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(
        list.filter((d) => d.kind === "videoinput").map((d, index) => ({ deviceId: d.deviceId, label: d.label || `Camera ${index + 1}` })),
      );
    } catch {
      setDevices([]);
    }
  }, []);

  const start = useCallback(
    async (requestedId?: string | null) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("error");
        setError("Thiết bị này không hỗ trợ camera.");
        return false;
      }
      stop();
      setStatus("starting");
      setError(null);
      const wanted = requestedId === undefined ? deviceId : requestedId;
      const base: MediaTrackConstraints = { width: { ideal: 1920 }, height: { ideal: 1080 } };
      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: wanted ? { ...base, deviceId: { exact: wanted } } : base, audio: false });
        } catch (first) {
          if (!wanted) throw first;
          stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false }); // camera đã lưu không còn → dùng mặc định
        }
        streamRef.current = stream;
        const active = stream.getVideoTracks()[0]?.getSettings().deviceId ?? wanted ?? null;
        setDeviceId(active);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setStatus("active");
        void refreshDevices();
        if (reportedError.current) {
          reportedError.current = false;
          void api.alertReport("camera_error", "", true).catch(() => undefined);
        }
        return true;
      } catch (err) {
        const message = describeError(err);
        setStatus("error");
        setError(message);
        reportedError.current = true;
        void api.alertReport("camera_error", message).catch(() => undefined);
        return false;
      }
    },
    [deviceId, refreshDevices, stop],
  );

  /** Chụp vài khung liên tiếp và giữ khung nét nhất. */
  const capture = useCallback(async (): Promise<Capture | null> => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const width = video.videoWidth;
    const height = video.videoHeight;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const probe = document.createElement("canvas");
    probe.width = 192;
    probe.height = Math.max(8, Math.round((192 * height) / width));
    const probeCtx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx || !probeCtx) return null;

    let best = -1;
    let bestBitmap: ImageData | null = null;
    for (let i = 0; i < 4; i++) {
      probeCtx.drawImage(video, 0, 0, probe.width, probe.height);
      const score = frameSharpness(probeCtx.getImageData(0, 0, probe.width, probe.height).data, probe.width, probe.height);
      if (score > best) {
        best = score;
        ctx.drawImage(video, 0, 0, width, height);
        bestBitmap = ctx.getImageData(0, 0, width, height);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    if (bestBitmap) ctx.putImageData(bestBitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) return null;

    // Không cắt ảnh theo khung quét: hộp thuốc thường lớn hơn khung, cắt sẽ mất chữ ở mép
    // (đã kiểm chứng khi thử nghiệm). Khung quét chỉ là hướng dẫn canh giữa.
    const crop: number[] | null = null;
    return { blob, crop };
  }, []);

  useEffect(() => {
    if (preferredDeviceId !== undefined && status === "idle") setDeviceId(preferredDeviceId ?? null);
  }, [preferredDeviceId, status]);

  useEffect(() => {
    const handler = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", handler);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", handler);
      streamRef.current?.getTracks().forEach((track) => track.stop()); // tắt camera khi rời trang
      streamRef.current = null;
    };
  }, [refreshDevices]);

  return { videoRef, status, error, devices, deviceId, start, stop, capture };
}
