import { create } from "zustand";

export type ToastKind = "success" | "error" | "info" | "warning";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, "id">, durationMs?: number) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast, durationMs = 4200) => {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-3), { ...toast, id }] });
    window.setTimeout(() => get().dismiss(id), durationMs);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Gọi được từ mọi nơi (kể cả ngoài component). */
export const toast = {
  success: (title: string, description?: string) => useToastStore.getState().push({ kind: "success", title, description }),
  error: (title: string, description?: string) => useToastStore.getState().push({ kind: "error", title, description }, 6500),
  info: (title: string, description?: string) => useToastStore.getState().push({ kind: "info", title, description }),
  warning: (title: string, description?: string) => useToastStore.getState().push({ kind: "warning", title, description }, 6000),
};
