// Build Android trên Windows: tránh lỗi đường dẫn > 260 ký tự khi CMake/Ninja biên dịch C++ của app.
//
// Với file nguồn nằm ngoài thư mục app (node_modules/…/codegen), CMake chép NGUYÊN đường dẫn tuyệt đối của nguồn
// vào tên file object, ví dụ:
//   app/.cxx/…/rngesturehandler_codegen_autolinked_build/CMakeFiles/…dir/C_/…/node_modules/react-native-gesture-handler/…
// nên dễ vượt MAX_PATH (260) của Windows → "ninja: error: mkdir(…): No such file or directory".
// CMAKE_OBJECT_PATH_MAX bảo CMake thay phần đầu tên object bằng mã băm MD5 khi tổng độ dài vượt ngưỡng.
// Trên macOS/Linux đường dẫn hiếm khi chạm ngưỡng này nên không có gì thay đổi.
const { withAppBuildGradle } = require("expo/config-plugins");

const ARG = "-DCMAKE_OBJECT_PATH_MAX=";
const OBJECT_PATH_MAX = 250;

/** Thêm tham số CMake vào android.defaultConfig của app/build.gradle (Groovy). Gọi lại nhiều lần vẫn chỉ thêm một lần. */
function addObjectPathMax(gradle) {
  if (gradle.includes(ARG)) return gradle;
  const anchor = /^(\s*)defaultConfig\s*\{[^\n]*$/m;
  const found = anchor.exec(gradle);
  if (!found) throw new Error("withShortNativeObjectPaths: không tìm thấy defaultConfig { trong android/app/build.gradle");
  const pad = `${found[1]}    `;
  const block = [
    `${pad}externalNativeBuild {`,
    `${pad}    cmake {`,
    `${pad}        arguments "${ARG}${OBJECT_PATH_MAX}"`,
    `${pad}    }`,
    `${pad}}`,
  ].join("\n");
  const end = found.index + found[0].length;
  return `${gradle.slice(0, end)}\n${block}${gradle.slice(end)}`;
}

function withShortNativeObjectPaths(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error("withShortNativeObjectPaths: chỉ hỗ trợ android/app/build.gradle dạng Groovy");
    }
    cfg.modResults.contents = addObjectPathMax(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = withShortNativeObjectPaths;
module.exports.addObjectPathMax = addObjectPathMax;
module.exports.OBJECT_PATH_MAX = OBJECT_PATH_MAX;
