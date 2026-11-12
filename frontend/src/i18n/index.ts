import { create } from "zustand";
import { en } from "./en";

export type Language = "vi" | "en";

interface LanguageState {
  language: Language;
  setLanguage: (language: Language) => void;
}

export const useLanguageStore = create<LanguageState>((set) => ({
  language: "vi",
  setLanguage: (language) => {
    document.documentElement.lang = language;
    set({ language });
  },
}));

function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => (key in vars ? String(vars[key]) : `{${key}}`));
}

/**
 * Dịch chuỗi giao diện. Khóa chính là câu tiếng Việt; thiếu bản dịch thì giữ tiếng Việt.
 * Nội dung do backend sinh ra (cảnh báo, lịch sử) luôn là tiếng Việt.
 */
export function translate(language: Language, text: string, vars?: Record<string, string | number>): string {
  const template = language === "en" ? (en[text] ?? text) : text;
  return format(template, vars);
}

export function useT(): (text: string, vars?: Record<string, string | number>) => string {
  const language = useLanguageStore((state) => state.language);
  return (text, vars) => translate(language, text, vars);
}

export function getLocale(language: Language): string {
  return language === "en" ? "en-GB" : "vi-VN";
}
