import { useFocusEffect } from "expo-router";
import { useCallback, useSyncExternalStore } from "react";

/** Màn hình nằm trong tab nhưng thiết kế không có thanh tab (Đang xử lý ảnh — thiết kế 06) gọi useHideTabBar(). */
let hidden = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function useHideTabBar(): void {
  useFocusEffect(
    useCallback(() => {
      hidden += 1;
      emit();
      return () => {
        hidden = Math.max(0, hidden - 1);
        emit();
      };
    }, []),
  );
}

export function useTabBarHidden(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => hidden > 0,
    () => false,
  );
}
