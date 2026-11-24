import { normalizeServerUrl, pickReachableServer, safeNormalize } from "./server";

describe("Tự chọn máy chủ còn hoạt động", () => {
  const OLD = "https://licence-trading-newman-warrior.trycloudflare.com"; // tunnel thử đã tắt
  const FUNNEL = "https://may-chu.ten-tailnet.ts.net:8443";

  it("địa chỉ ưu tiên còn sống → dùng luôn", async () => {
    await expect(pickReachableServer([FUNNEL, OLD], async () => true)).resolves.toBe(FUNNEL);
  });

  it("địa chỉ cũ đã chết (ví dụ tunnel thử) → tự chuyển sang địa chỉ gài sẵn", async () => {
    const up = new Set([FUNNEL]);
    await expect(pickReachableServer([OLD, FUNNEL], async (u) => up.has(u))).resolves.toBe(FUNNEL);
  });

  it("kiểm tra lỗi (ném ngoại lệ) coi như chết; trùng lặp và rỗng bị bỏ", async () => {
    const isUp = jest.fn(async (u: string) => {
      if (u === OLD) throw new Error("DNS");
      return true;
    });
    await expect(pickReachableServer(["", OLD, OLD, FUNNEL], isUp)).resolves.toBe(FUNNEL);
    expect(isUp).toHaveBeenCalledTimes(2);
  });

  it("mất mạng (không địa chỉ nào trả lời) → null để giữ lựa chọn đầu", async () => {
    await expect(pickReachableServer([OLD, FUNNEL], async () => false)).resolves.toBeNull();
  });

  it("không chờ địa chỉ chậm/chết khi địa chỉ ưu tiên đã trả lời", async () => {
    const never = new Promise<boolean>(() => undefined);
    await expect(pickReachableServer([FUNNEL, OLD], (u) => (u === FUNNEL ? Promise.resolve(true) : never))).resolves.toBe(FUNNEL);
  });

  it("chuẩn hóa an toàn: giá trị hỏng → rỗng, không ném lỗi", () => {
    expect(safeNormalize("http://ngoai-mang.example")).toBe("");
    expect(safeNormalize(undefined)).toBe("");
    expect(safeNormalize("may-chu.ten-tailnet.ts.net:8443")).toBe(FUNNEL);
  });
});

describe("Địa chỉ máy chủ", () => {
  it.each([
    ["api.tuthuoc.example", "https://api.tuthuoc.example"],
    ["https://api.tuthuoc.example/api/v1/", "https://api.tuthuoc.example"],
    ["  HTTPS://Api.TuThuoc.Example  ", "https://api.tuthuoc.example"],
    ["may-chu.ten-tailnet.ts.net:8443", "https://may-chu.ten-tailnet.ts.net:8443"],
    ["https://may-chu.ten-tailnet.ts.net:8443/api/v1/health", "https://may-chu.ten-tailnet.ts.net:8443"],
    ["192.168.1.20:8000", "http://192.168.1.20:8000"],
    ["http://10.0.2.2:8000", "http://10.0.2.2:8000"],
  ])("%s → %s", (input, expected) => expect(normalizeServerUrl(input)).toBe(expected));

  it.each([
    ["", /Hãy nhập/],
    ["http://api.tuthuoc.example", /https/],
    ["https://user:pass@api.tuthuoc.example", /mật khẩu/],
    ["ftp://api.tuthuoc.example", /https/],
  ])("từ chối %p", (input, message) => expect(() => normalizeServerUrl(input)).toThrow(message));
});
