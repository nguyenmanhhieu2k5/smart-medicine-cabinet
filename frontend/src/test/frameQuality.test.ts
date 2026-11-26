import { describe, expect, it } from "vitest";
import { frameSharpness } from "@/hooks/useCamera";
import { CENTER_REGION, frameScore, glareRatio, GLARE_HINT_RATIO } from "@/scan/frameQuality";

/** Ảnh RGBA giả: nền màu `base`, có thể thêm một ô lóa trắng và vài nét chữ tối. */
function frame(width: number, height: number, base: [number, number, number], opts: { glare?: [number, number, number, number]; strokes?: boolean } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let [r, g, b] = base;
      if (opts.strokes && x < width / 2 && x % 6 < 2 && y % 10 < 7) [r, g, b] = [30, 30, 90]; // chữ ở nửa trái
      const gl = opts.glare;
      if (gl && x >= gl[0] && x < gl[2] && y >= gl[1] && y < gl[3]) [r, g, b] = [255, 255, 254];
      data.set([r, g, b, 255], i);
    }
  }
  return data;
}

describe("Chất lượng khung hình webcam (chống lóa sáng)", () => {
  it("đếm điểm lóa trắng cháy sáng ở vùng giữa, bỏ qua màu sáng nhưng có màu và vùng ngoài khung", () => {
    const w = 100;
    const h = 100;
    expect(glareRatio(frame(w, h, [150, 150, 150]), w, h)).toBe(0); // giấy bạc xám
    expect(glareRatio(frame(w, h, [255, 240, 60]), w, h)).toBe(0); // vàng chói nhưng có màu → không phải lóa
    const spot = glareRatio(frame(w, h, [150, 150, 150], { glare: [40, 40, 60, 60] }), w, h); // ô 20×20 ở giữa
    const area = (CENTER_REGION.x1 - CENTER_REGION.x0) * (CENTER_REGION.y1 - CENTER_REGION.y0) * w * h;
    expect(spot).toBeCloseTo(400 / area, 3);
    expect(spot).toBeGreaterThan(GLARE_HINT_RATIO);
    expect(glareRatio(frame(w, h, [150, 150, 150], { glare: [0, 0, 10, 100] }), w, h)).toBe(0); // lóa sát mép trái: ngoài khung quét
  });

  it("chọn khung ít lóa dù khung lóa trông “nét” hơn (viền lóa gắt làm tăng độ nét giả)", () => {
    const w = 120;
    const h = 80;
    const clean = frame(w, h, [150, 150, 150], { strokes: true });
    const glared = frame(w, h, [150, 150, 150], { strokes: true, glare: [64, 15, 100, 65] }); // chỗ lóa cạnh dòng chữ
    const sClean = frameSharpness(clean, w, h);
    const sGlare = frameSharpness(glared, w, h);
    expect(sGlare).toBeGreaterThan(sClean); // chỉ xét độ nét thì khung lóa thắng
    expect(frameScore(sClean, glareRatio(clean, w, h))).toBeGreaterThan(frameScore(sGlare, glareRatio(glared, w, h)));
    expect(frameScore(100, 0)).toBe(100);
    expect(frameScore(100, 0.04)).toBeCloseTo(50);
  });
});
