/**
 * Giọng đọc tiếng Việt bằng bộ chuyển văn bản thành giọng nói CÓ SẴN của máy (expo-speech) — không gửi gì lên máy chủ.
 */
import * as Speech from "expo-speech";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Platform } from "react-native";

const VIETNAMESE = /^vi(?:[-_]|$)/i;
// Android (expo-speech) dựng ngôn ngữ bằng Locale.Builder().setLanguage(...): "vi-VN" bị coi là sai và âm thầm
// chuyển về giọng mặc định của máy (thường là tiếng Anh) — phải truyền "vi". iOS/trình duyệt dùng mã đầy đủ.
export const SPEECH_LANGUAGE = Platform.OS === "android" ? "vi" : "vi-VN";
// Chậm hơn bình thường một chút cho người lớn tuổi dễ nghe.
export const SPEECH_RATE = 0.9;

export const MISSING_VOICE_HINT = Platform.select({
  android: "Máy chưa có giọng đọc tiếng Việt. Vào Cài đặt → Hệ thống (hoặc Hỗ trợ tiếp cận) → Ngôn ngữ → Chuyển văn bản thành giọng nói → biểu tượng cài đặt của Google → Cài đặt dữ liệu giọng nói → Tiếng Việt, rồi thử lại.",
  ios: "Máy chưa có giọng đọc tiếng Việt. Vào Cài đặt → Trợ năng → Nội dung được đọc → Giọng nói → Tiếng Việt để tải giọng, rồi thử lại.",
  default: "Trình duyệt này chưa có giọng đọc tiếng Việt. Hãy dùng ứng dụng trên điện thoại để nghe đọc thông tin thuốc.",
});

export type VoiceCheck = { status: "ok"; voice: string } | { status: "unknown" } | { status: "missing" };

/** Tìm giọng tiếng Việt tốt nhất (ưu tiên giọng cài sẵn trên máy, không cần mạng). */
export async function findVietnameseVoice(): Promise<VoiceCheck> {
  let voices: Speech.Voice[];
  try {
    voices = await Speech.getAvailableVoicesAsync();
  } catch {
    return { status: "unknown" };
  }
  // Danh sách rỗng: bộ đọc chưa khởi động xong (hay gặp ở lần đầu trên Android) — cứ đọc theo mã ngôn ngữ.
  if (!voices?.length) return { status: "unknown" };
  const vi = voices.filter((v) => VIETNAMESE.test(v.language ?? ""));
  if (!vi.length) return { status: "missing" };
  const score = (v: Speech.Voice) => (/network/i.test(v.identifier) ? 0 : 2) + (v.quality === Speech.VoiceQuality.Enhanced ? 1 : 0);
  const best = [...vi].sort((a, b) => score(b) - score(a))[0];
  return { status: "ok", voice: best.identifier };
}

/** Đọc/dừng đọc; tự dừng khi rời màn hình. `notice` = thông báo cho người dùng khi không đọc được. */
export function useSpeech() {
  const [speaking, setSpeaking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Mỗi lần đọc có một số thứ tự: sự kiện của lần đọc cũ (đã dừng) không được làm sai trạng thái lần mới.
  const turn = useRef(0);

  const stop = useCallback(() => {
    turn.current += 1;
    setSpeaking(false);
    void Speech.stop().catch(() => undefined);
  }, []);

  const speak = useCallback(async (text: string) => {
    const mine = ++turn.current;
    setNotice(null);
    setSpeaking(true);
    await Speech.stop().catch(() => undefined);
    const check = await findVietnameseVoice();
    if (mine !== turn.current) return;
    if (check.status === "missing") {
      setSpeaking(false);
      setNotice(MISSING_VOICE_HINT);
      return;
    }
    const finish = () => {
      if (mine === turn.current) setSpeaking(false);
    };
    Speech.speak(text, {
      language: SPEECH_LANGUAGE,
      voice: check.status === "ok" ? check.voice : undefined,
      rate: SPEECH_RATE,
      onDone: finish,
      onStopped: finish,
      onError: () => {
        finish();
        if (mine === turn.current) setNotice("Không phát được giọng đọc. Vui lòng kiểm tra âm lượng và thử lại.");
      },
    });
  }, []);

  // Rời màn hình (quay lại, chuyển tab, màn hình bị huỷ) → dừng đọc.
  useFocusEffect(useCallback(() => stop, [stop]));

  return { speaking, notice, speak, stop };
}
