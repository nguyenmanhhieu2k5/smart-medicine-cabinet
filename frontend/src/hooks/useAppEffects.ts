import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useLanguageStore } from "@/i18n";
import { api } from "@/services/api";
import { useSettings } from "@/services/queries";
import { toast } from "@/stores/toast";

/** Áp dụng giao diện sáng/tối và ngôn ngữ theo cài đặt. */
export function useThemeAndLanguage(): void {
  const settings = useSettings().data?.settings;
  const setLanguage = useLanguageStore((state) => state.setLanguage);
  const theme = settings?.theme ?? "light";
  const language = settings?.language ?? "vi";

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => setLanguage(language), [language, setLanguage]);

  const tray = settings?.minimize_to_tray;
  useEffect(() => {
    if (tray !== undefined) void window.smc?.setTrayEnabled(tray);
  }, [tray]);
}

/** Tiếng "ting" ngắn tạo bằng WebAudio (không cần file âm thanh). */
export function playChime(): void {
  try {
    const AudioCtx = window.AudioContext;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    [880, 1174.7].forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + index * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.18, now + index * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.16 + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + index * 0.16);
      osc.stop(now + index * 0.16 + 0.55);
    });
    window.setTimeout(() => void ctx.close(), 1200);
  } catch {
    /* thiết bị không có âm thanh */
  }
}

/**
 * Hỏi backend các thông báo đến hạn (lời nhắc uống thuốc, cảnh báo mới) rồi hiển thị:
 * thông báo Windows qua Electron (hoặc Notification API của trình duyệt) + toast trong ứng dụng.
 */
export function useNotificationPump(enabled: boolean): void {
  const client = useQueryClient();
  const navigate = useNavigate();
  const busy = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const poll = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const pending = await api.notificationsPending();
        if (pending.items.length > 0) {
          void client.invalidateQueries({ queryKey: ["alerts"] });
          void client.invalidateQueries({ queryKey: ["reminders"] });
          if (pending.sound) playChime();
        }
        // Nhiều thông báo cùng lúc (vd lúc mở ứng dụng) → gộp thành một toast để không che màn hình.
        if (pending.items.length > 2) {
          const titles = pending.items.slice(0, 2).map((item) => item.title).join(" · ");
          toast.warning(`Có ${pending.items.length} thông báo mới`, `${titles}…`);
        }
        for (const item of pending.items) {
          if (pending.items.length <= 2) {
            if (item.kind === "reminder") toast.info(item.title, item.body);
            else if (item.severity === "danger") toast.error(item.title, item.body);
            else toast.warning(item.title, item.body);
          }
          if (!pending.windows_notifications) continue;
          if (window.smc) void window.smc.notify({ title: item.title, body: item.body, route: item.route });
          else if ("Notification" in window && Notification.permission === "granted") new Notification(item.title, { body: item.body });
        }
      } catch {
        /* backend chưa sẵn sàng — thử lại ở chu kỳ sau */
      } finally {
        busy.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, 30_000);
    const off = window.smc?.onNavigate((route) => navigate(route));
    return () => {
      window.clearInterval(timer);
      off?.();
    };
  }, [enabled, client, navigate]);
}
