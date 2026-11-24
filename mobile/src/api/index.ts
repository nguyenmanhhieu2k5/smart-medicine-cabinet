import { ScannerApi } from "./client";
import { deviceStore } from "./storage";

/** Một phiên bản dùng chung cho cả ứng dụng. */
export const api = new ScannerApi(deviceStore);

export { ApiError, PUBLIC_PATH, ScannerApi, assertPublicPath } from "./client";
export type { PickedImage, SessionEndReason } from "./client";
export * from "./types";
