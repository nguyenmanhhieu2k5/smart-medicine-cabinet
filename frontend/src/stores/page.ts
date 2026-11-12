import { useLayoutEffect } from "react";
import { create } from "zustand";

export interface PageMeta {
  breadcrumb: string;
  title: string;
  subtitle: string;
}

interface PageState {
  meta: PageMeta;
  setMeta: (meta: PageMeta) => void;
}

export const usePageStore = create<PageState>((set) => ({
  meta: { breadcrumb: "Tủ thuốc thông minh", title: "", subtitle: "" },
  setMeta: (meta) => set({ meta }),
}));

/** Mỗi trang khai báo tiêu đề của mình; Topbar (dùng chung) hiển thị lại. */
export function usePageHeader(title: string, subtitle: string, breadcrumb = "Tủ thuốc thông minh"): void {
  const setMeta = usePageStore((state) => state.setMeta);
  useLayoutEffect(() => {
    setMeta({ breadcrumb, title, subtitle });
    document.title = title ? `${title} · Tủ thuốc thông minh` : "Tủ thuốc thông minh";
  }, [breadcrumb, title, subtitle, setMeta]);
}
