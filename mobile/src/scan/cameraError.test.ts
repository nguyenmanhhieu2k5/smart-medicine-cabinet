import { cameraErrorMessage } from "./startScan";

jest.mock("expo-haptics", () => ({ impactAsync: jest.fn(), ImpactFeedbackStyle: { Medium: "medium" } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/api", () => ({ api: {}, ApiError: class ApiError extends Error {} }));

describe("cameraErrorMessage", () => {
  it.each([
    ["Requested device not found", "Không tìm thấy camera trên thiết bị này."],
    ["NotFoundError: no camera", "Không tìm thấy camera trên thiết bị này."],
    ["NotAllowedError: Permission denied", "Chưa được phép dùng camera. Hãy cho phép camera trong cài đặt."],
    ["NotReadableError: Could not start video source", "Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại."],
    ["Camera is in use by another app", "Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại."],
    ["something odd", "Không mở được camera."],
    [undefined, "Không mở được camera."],
  ])("%s → %s", (raw, expected) => {
    expect(cameraErrorMessage(raw)).toBe(expected);
  });
});
