import { create } from "zustand";

interface UiState {
  /** Hộp tìm thuốc thủ công trong danh mục (dùng chung cho Trang chủ, Quét thuốc, Thuốc trong tủ). */
  catalogSearch: { open: boolean; query: string; scanJobId: string | null };
  openCatalogSearch: (query?: string, scanJobId?: string | null) => void;
  closeCatalogSearch: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  catalogSearch: { open: false, query: "", scanJobId: null },
  openCatalogSearch: (query = "", scanJobId = null) => set({ catalogSearch: { open: true, query, scanJobId } }),
  closeCatalogSearch: () => set((state) => ({ catalogSearch: { ...state.catalogSearch, open: false } })),
}));
