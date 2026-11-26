// Cấu hình build (app.json): quyền CAMERA phải có trong APK.
// Lỗi thật (25/11/2026): expo-image-picker đặt "cameraPermission": false → plugin của nó CHẶN android.permission.CAMERA
// cho cả ứng dụng (kể cả expo-camera) → Android từ chối ngay không hỏi, Cài đặt điện thoại không có mục Camera.
const app = require("../../app.json") as {
  expo: { android: { permissions?: string[]; blockedPermissions?: string[] }; plugins: (string | [string, Record<string, unknown>])[] };
};

const plugin = (name: string) =>
  app.expo.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name) as [string, Record<string, unknown>] | string | undefined;

describe("app.json — quyền camera", () => {
  it("khai báo CAMERA và không chặn nó", () => {
    expect(app.expo.android.permissions).toContain("android.permission.CAMERA");
    expect(app.expo.android.blockedPermissions ?? []).not.toContain("android.permission.CAMERA");
  });

  it("không plugin nào tắt quyền camera (expo-image-picker cameraPermission: false sẽ xóa CAMERA khỏi APK)", () => {
    for (const name of ["expo-camera", "expo-image-picker"]) {
      const entry = plugin(name);
      expect(entry).toBeDefined();
      const options = Array.isArray(entry) ? entry[1] : {};
      expect(options.cameraPermission).not.toBe(false);
    }
  });

  it("vẫn chặn micro (ứng dụng không ghi âm)", () => {
    expect(app.expo.android.blockedPermissions).toContain("android.permission.RECORD_AUDIO");
  });
});
