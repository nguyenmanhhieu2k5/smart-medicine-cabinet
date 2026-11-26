import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { speak, stopSpeaking, usesServerVoice } from "@/services/tts";
import { cabinetItem, installMockApi, type MockState } from "./mockApi";
import { renderApp } from "./renderApp";

/** Audio giả: ghi lại các lần phát; test gọi `finish()` để mô phỏng đọc xong. */
class FakeAudio {
  static played: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = true;
  constructor(public src: string) {}
  play() {
    this.paused = false;
    FakeAudio.played.push(this);
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  finish() {
    this.onended?.();
  }
}

let api: MockState;
let windowsSpoken: string[];

beforeEach(() => {
  api = installMockApi();
  FakeAudio.played = [];
  windowsSpoken = [];
  vi.stubGlobal("Audio", FakeAudio);
  URL.createObjectURL = vi.fn(() => "blob:giong-doc");
  URL.revokeObjectURL = vi.fn();
  // Giọng Windows (Web Speech) — "Microsoft An" là giọng tiếng Việt duy nhất có sẵn trên Windows 10.
  vi.stubGlobal("SpeechSynthesisUtterance", class {
    voice: unknown = null;
    lang = "";
    rate = 1;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public text: string) {}
  });
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => [{ voiceURI: "Microsoft An - Vietnamese (Vietnam)", name: "Microsoft An", lang: "vi-VN", localService: true }],
    speak: (u: { text: string }) => windowsSpoken.push(u.text),
    cancel: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

const ttsCalls = () => api.calls.filter((c) => c.path === "/tts" && c.method === "POST");

describe("Giọng đọc tiếng Việt tự nhiên (máy chủ) cho ứng dụng Windows", () => {
  it("mặc định đọc bằng giọng của máy chủ khi máy chủ có giọng; chọn giọng Windows cụ thể thì dùng giọng đó", () => {
    expect(usesServerVoice(null, true)).toBe(true);
    expect(usesServerVoice("server:vi_VN-vais1000", true)).toBe(true);
    expect(usesServerVoice("Microsoft An - Vietnamese (Vietnam)", true)).toBe(false);
    expect(usesServerVoice(null, false)).toBe(false);
  });

  it("trang chi tiết: bấm Đọc thông tin → máy chủ tạo giọng, ứng dụng phát; đọc xong nút trở lại", async () => {
    api.cabinet = [cabinetItem()];
    renderApp("/cabinet/1");
    await userEvent.click(await screen.findByRole("button", { name: "Đọc thông tin" }));
    await waitFor(() => expect(FakeAudio.played).toHaveLength(1));
    const [call] = ttsCalls();
    expect(call.body).toMatchObject({ speed: 1 });
    expect((call.body as { text: string }).text).toContain("Augmentin 625mg tablets");
    expect(windowsSpoken).toEqual([]); // không dùng giọng Windows khó nghe
    expect(screen.getByRole("button", { name: "Dừng đọc" })).toBeInTheDocument();
    act(() => FakeAudio.played[0].finish());
    expect(await screen.findByRole("button", { name: "Đọc thông tin" })).toBeInTheDocument();
  });

  it("máy chủ chưa có giọng → đọc bằng giọng Windows như trước", async () => {
    api.ttsAvailable = false;
    api.cabinet = [cabinetItem()];
    renderApp("/cabinet/1");
    await userEvent.click(await screen.findByRole("button", { name: "Đọc thông tin" }));
    await waitFor(() => expect(windowsSpoken).toHaveLength(1));
    expect(windowsSpoken[0]).toContain("Augmentin 625mg tablets");
    expect(ttsCalls()).toHaveLength(0);
  });

  it("máy chủ lỗi khi tạo giọng (mất kết nối, 503) → tự chuyển sang giọng Windows, không im lặng", async () => {
    api.ttsAvailable = false; // POST /tts trả 503
    const ended = vi.fn();
    const result = await speak("Paracetamol 500mg", { serverAvailable: true, onEnd: ended });
    expect(result).toEqual({ ok: true, engine: "windows" });
    expect(windowsSpoken).toEqual(["Paracetamol 500mg"]);
    expect(FakeAudio.played).toHaveLength(0);
  });

  it("bấm Dừng trong lúc máy chủ đang tạo giọng → không phát gì nữa", async () => {
    const pending = speak("Paracetamol 500mg", { serverAvailable: true });
    stopSpeaking();
    await pending;
    expect(FakeAudio.played).toHaveLength(0);
    expect(windowsSpoken).toEqual([]);
  });

  it("Cài đặt: giọng tự nhiên là lựa chọn mặc định, Đọc thử dùng giọng máy chủ", async () => {
    renderApp("/settings");
    const select = await screen.findByRole("combobox", { name: "Giọng đọc" });
    await waitFor(() => expect(select).toHaveDisplayValue("Giọng tự nhiên tiếng Việt — máy chủ (khuyên dùng)"));
    expect(screen.getByText("CC BY 4.0 — VAIS-1000 Vietnamese Speech Synthesis Corpus")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Đọc thử" }));
    await waitFor(() => expect(FakeAudio.played).toHaveLength(1));
    expect(ttsCalls()).toHaveLength(1);
  });

  it("Cài đặt: máy chủ chưa có giọng → nói rõ lý do, vẫn chọn được giọng Windows", async () => {
    api.ttsAvailable = false;
    renderApp("/settings");
    expect(await screen.findByText(/Giọng tự nhiên của máy chủ chưa sẵn sàng: Chưa tải mô hình giọng đọc/)).toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "Giọng đọc" });
    expect(select).toHaveDisplayValue("Tự chọn giọng tiếng Việt");
    expect(screen.getByRole("option", { name: "Microsoft An (vi-VN)" })).toBeInTheDocument();
  });
});
