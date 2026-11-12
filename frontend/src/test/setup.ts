import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());

// jsdom không có các API trình duyệt này.
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }),
  });
}
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver ??= ResizeObserverStub;
Element.prototype.scrollIntoView ??= () => {};

// Bỏ hoạt ảnh trong kiểm thử để chuyển trang hoàn tất ngay.
import { MotionGlobalConfig } from "motion/react";
MotionGlobalConfig.skipAnimations = true;

// Store toàn cục (zustand) phải được đặt lại giữa các test để toast/hộp thoại cũ không lọt sang test sau.
import { useToastStore } from "@/stores/toast";
import { useUiStore } from "@/stores/ui";
afterEach(() => {
  useToastStore.setState({ toasts: [] });
  useUiStore.setState({ catalogSearch: { open: false, query: "", scanJobId: null } });
  vi.unstubAllGlobals();
});
