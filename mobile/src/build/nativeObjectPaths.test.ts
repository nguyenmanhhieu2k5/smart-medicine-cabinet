// Plugin build Android: thêm CMAKE_OBJECT_PATH_MAX để Windows không vượt giới hạn 260 ký tự đường dẫn.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require("../../plugins/withShortNativeObjectPaths") as {
  addObjectPathMax: (gradle: string) => string;
  OBJECT_PATH_MAX: number;
};

const TEMPLATE = `android {
    namespace 'vn.smartmedicinecabinet.scanner'
    defaultConfig {
        applicationId 'vn.smartmedicinecabinet.scanner'
        versionName "2.0.0"
    }
    buildTypes {
    }
}
`;

describe("withShortNativeObjectPaths", () => {
  it("thêm tham số CMake ngay trong defaultConfig, giữ nguyên phần còn lại", () => {
    const out = plugin.addObjectPathMax(TEMPLATE);
    expect(out).toContain(`    defaultConfig {
        externalNativeBuild {
            cmake {
                arguments "-DCMAKE_OBJECT_PATH_MAX=250"
            }
        }
        applicationId 'vn.smartmedicinecabinet.scanner'`);
    expect(out.replace(/\n {8}externalNativeBuild \{[\s\S]*?\n {8}\}/, "")).toBe(TEMPLATE);
  });

  it("chạy prebuild nhiều lần vẫn chỉ thêm một lần", () => {
    const once = plugin.addObjectPathMax(TEMPLATE);
    expect(plugin.addObjectPathMax(once)).toBe(once);
    expect(once.match(/CMAKE_OBJECT_PATH_MAX/g)).toHaveLength(1);
  });

  it("ngưỡng < 260 (giới hạn Windows) và ≥ 128 (CMake bỏ qua giá trị nhỏ hơn)", () => {
    expect(plugin.OBJECT_PATH_MAX).toBeLessThan(258);
    expect(plugin.OBJECT_PATH_MAX).toBeGreaterThanOrEqual(128);
  });

  it("báo lỗi rõ khi mẫu build.gradle đổi và không còn defaultConfig", () => {
    expect(() => plugin.addObjectPathMax("android {\n}\n")).toThrow(/defaultConfig/);
  });
});
