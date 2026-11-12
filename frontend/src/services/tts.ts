import { useEffect, useState } from "react";

/** Đọc văn bản bằng giọng cài sẵn trên máy (Web Speech API — chạy offline với giọng của Windows). */

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export function isVietnamese(voice: SpeechSynthesisVoice): boolean {
  return voice.lang.toLowerCase().replace("_", "-").startsWith("vi");
}

export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (ttsSupported() ? window.speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (!ttsSupported()) return;
    const update = () => setVoices(window.speechSynthesis.getVoices());
    update();
    window.speechSynthesis.addEventListener?.("voiceschanged", update);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", update);
  }, []);
  return voices;
}

export type SpeakResult = { ok: true } | { ok: false; reason: "unsupported" | "no_vietnamese_voice" };

export function pickVoice(voices: SpeechSynthesisVoice[], preferredUri: string | null | undefined): SpeechSynthesisVoice | null {
  const preferred = preferredUri ? voices.find((v) => v.voiceURI === preferredUri) : undefined;
  if (preferred) return preferred;
  return voices.find((v) => isVietnamese(v) && v.localService) ?? voices.find(isVietnamese) ?? null;
}

export function speak(text: string, options: { voiceUri?: string | null; rate?: number; onEnd?: () => void } = {}): SpeakResult {
  if (!ttsSupported()) return { ok: false, reason: "unsupported" };
  const voice = pickVoice(window.speechSynthesis.getVoices(), options.voiceUri);
  if (!voice) return { ok: false, reason: "no_vietnamese_voice" };
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = options.rate ?? 1;
  utterance.onend = () => options.onEnd?.();
  utterance.onerror = () => options.onEnd?.();
  window.speechSynthesis.speak(utterance);
  return { ok: true };
}

export function stopSpeaking(): void {
  if (ttsSupported()) window.speechSynthesis.cancel();
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
