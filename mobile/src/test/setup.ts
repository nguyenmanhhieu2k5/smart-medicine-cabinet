// Thiết lập chung cho jest (jest-expo): giả lập các module điều hướng/cảm biến không có trong môi trường Node.
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), navigate: jest.fn(), back: jest.fn(), canGoBack: () => true, dismissTo: jest.fn() },
  useLocalSearchParams: () => ({}),
  useIsFocused: () => true,
  useFocusEffect: jest.fn(),
  Redirect: () => null,
}));

jest.mock("expo-secure-store", () => {
  const data = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => data.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void data.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void data.delete(k)),
  };
});
