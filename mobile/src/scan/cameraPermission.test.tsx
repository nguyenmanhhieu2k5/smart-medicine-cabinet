import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import { useCameraAccess } from "./cameraPermission";

type Perm = { granted: boolean; canAskAgain: boolean; status: string } | null;
let mockCurrent: Perm = null;
const mockRequest = jest.fn(async () => mockCurrent);
const mockGet = jest.fn(async () => mockCurrent);

jest.mock("expo-camera", () => ({ useCameraPermissions: () => [mockCurrent, mockRequest, mockGet] }));

const perm = (granted: boolean, canAskAgain = true, status = granted ? "granted" : "undetermined"): Perm => ({ granted, canAskAgain, status });

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrent = null;
});

describe("Quyền camera của màn Quét", () => {
  it("lần đầu mở màn Quét: tự hiện hộp thoại xin quyền, chỉ một lần", async () => {
    mockCurrent = perm(false);
    const { rerender } = await renderHook((props: { focused: boolean }) => useCameraAccess(props.focused), { initialProps: { focused: true } });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    mockCurrent = perm(false, true, "denied"); // người dùng bấm “Không cho phép”
    await rerender({ focused: true });
    expect(mockRequest).toHaveBeenCalledTimes(1); // không hỏi dồn — người dùng tự bấm “Cho phép camera” khi muốn
  });

  it("không hỏi khi đã có quyền, khi Android không cho hỏi nữa, hoặc khi màn Quét không hiển thị", async () => {
    mockCurrent = perm(true);
    await renderHook(() => useCameraAccess(true));
    mockCurrent = perm(false, false, "denied");
    await renderHook(() => useCameraAccess(true));
    mockCurrent = perm(false);
    await renderHook(() => useCameraAccess(false));
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("quay lại ứng dụng (sau khi bật quyền trong Cài đặt) → kiểm tra lại quyền", async () => {
    mockCurrent = perm(false, false, "denied");
    let onChange: ((state: string) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AppState, "addEventListener").mockImplementation(((_: string, cb: (state: string) => void) => {
      onChange = cb;
      return { remove };
    }) as never);
    const { unmount } = await renderHook(() => useCameraAccess(true));
    await act(async () => onChange?.("background"));
    expect(mockGet).not.toHaveBeenCalled();
    await act(async () => onChange?.("active"));
    expect(mockGet).toHaveBeenCalledTimes(1);
    await unmount();
    expect(remove).toHaveBeenCalled();
  });
});
