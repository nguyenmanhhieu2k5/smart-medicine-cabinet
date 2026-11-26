import { useEffect, useState } from "react";
import { api } from "@/services/api";

/**
 * Đọc thông tin thuốc bằng giọng tiếng Việt.
 * - Mặc định: GIỌNG TỰ NHIÊN của máy chủ Mini PC (Piper vi_VN-vais1000, neural, offline) — máy chủ trả file WAV, ứng dụng phát.
 * - Dự phòng / tự chọn: giọng cài sẵn trên Windows (Web Speech API; Windows 10 chỉ có “Microsoft An” đời cũ, khó nghe).
 */

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/** Có dùng giọng máy chủ không: máy chủ có giọng và người dùng chưa chọn một giọng Windows cụ thể (tts_voice rỗng hoặc "server:…"). */
export function usesServerVoice(voiceUri: string | null | undefined, serverAvailable: boolean): boolean {
  return serverAvailable && (!voiceUri || voiceUri.startsWith("server:"));
}

export function isVietnamese(voice: SpeechSynthesisVoice): boolean {
  return voice.lang.toLowerCase().replace("_", "-").startsWith("vi");
}

export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (ttsSupported() ? window.speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (!ttsSupported()) return;
    const synth = window.speechSynthesis;
    const update = () => setVoices(synth.getVoices());
    update();
    synth.addEventListener?.("voiceschanged", update);
    return () => synth.removeEventListener?.("voiceschanged", update);
  }, []);
  return voices;
}

export type SpeakResult = { ok: true; engine: "server" | "windows" } | { ok: false; reason: "unsupported" | "no_vietnamese_voice" };

export function pickVoice(voices: SpeechSynthesisVoice[], preferredUri: string | null | undefined): SpeechSynthesisVoice | null {
  const preferred = preferredUri ? voices.find((v) => v.voiceURI === preferredUri) : undefined;
  if (preferred) return preferred;
  return voices.find((v) => isVietnamese(v) && v.localService) ?? voices.find(isVietnamese) ?? null;
}

type SpeakOptions = { voiceUri?: string | null; rate?: number; onEnd?: () => void; serverAvailable?: boolean };

let audio: HTMLAudioElement | null = null;
let audioUrl: string | null = null;
let generation = 0; // mỗi lần đọc/dừng tăng 1 → bỏ kết quả đến muộn của lần đọc đã bị dừng

function releaseAudio(): void {
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
  }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audio = null;
  audioUrl = null;
}

function speakWindows(text: string, options: SpeakOptions): SpeakResult {
  if (!ttsSupported()) return { ok: false, reason: "unsupported" };
  const voice = pickVoice(window.speechSynthesis.getVoices(), options.voiceUri);
  if (!voice) return { ok: false, reason: "no_vietnamese_voice" };
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = options.rate ?? 1;
  utterance.onend = () => options.onEnd?.();
  utterance.onerror = () => options.onEnd?.();
  window.speechSynthesis.speak(utterance);
  return { ok: true, engine: "windows" };
}

/** Đọc một đoạn. Giọng máy chủ lỗi (mất kết nối, chưa cài mô hình) → tự đọc bằng giọng Windows. */
export async function speak(text: string, options: SpeakOptions = {}): Promise<SpeakResult> {
  stopSpeaking();
  const mine = ++generation;
  if (usesServerVoice(options.voiceUri, options.serverAvailable === true)) {
    try {
      const blob = await api.ttsAudio(text, options.rate ?? 1);
      if (mine !== generation) return { ok: true, engine: "server" }; // người dùng đã bấm Dừng trong lúc chờ
      audioUrl = URL.createObjectURL(blob);
      audio = new Audio(audioUrl);
      const done = () => {
        releaseAudio();
        options.onEnd?.();
      };
      audio.onended = done;
      audio.onerror = done;
      await audio.play();
      return { ok: true, engine: "server" };
    } catch {
      releaseAudio();
      if (mine !== generation) return { ok: true, engine: "server" };
      return speakWindows(text, { ...options, voiceUri: null });
    }
  }
  return speakWindows(text, options);
}

export function stopSpeaking(): void {
  generation += 1;
  releaseAudio();
  if (ttsSupported()) window.speechSynthesis?.cancel();
}

/** "2027-06-15" → "ngày 15 tháng 6 năm 2027" để giọng đọc phát âm tự nhiên. */
export function spokenDate(iso: string | null | undefined): string | null {
  const match = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return match ? `ngày ${Number(match[3])} tháng ${Number(match[2])} năm ${match[1]}` : null;
}

/** Ghép câu đọc CHỈ từ dữ liệu có sẵn (danh mục Excel + thông tin người dùng nhập). */
export function buildSpeech(parts: [label: string, value: string | null | undefined][]): string {
  return parts.filter(([, value]) => value && value.trim()).map(([label, value]) => `${label}: ${value}.`).join(" ");
}
