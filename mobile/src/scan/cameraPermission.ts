import { useCameraPermissions } from "expo-camera";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

/**
 * Quyền camera của màn Quét.
 * - Lần đầu mở màn Quét: tự hiện hộp thoại xin quyền của hệ thống (mỗi phiên một lần — đã từ chối thì không hỏi dồn,
 *   người dùng bấm “Cho phép camera” khi muốn).
 * - Quay lại ứng dụng sau khi bật quyền trong Cài đặt điện thoại → kiểm tra lại để camera mở ngay, không phải thoát app.
 * Lưu ý: quyền CAMERA phải được khai báo trong APK (app.json — xem src/build/appConfig.test.ts); thiếu khai báo thì
 * Android từ chối ngay mà không hỏi, và Cài đặt cũng không có mục Camera.
 */
export function useCameraAccess(focused: boolean) {
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const asked = useRef(false);

  useEffect(() => {
    if (!focused || asked.current || !permission || permission.granted || !permission.canAskAgain) return;
    asked.current = true;
    void requestPermission();
  }, [focused, permission, requestPermission]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void getPermission();
    });
    return () => sub.remove();
  }, [getPermission]);

  return { permission, requestPermission };
}
