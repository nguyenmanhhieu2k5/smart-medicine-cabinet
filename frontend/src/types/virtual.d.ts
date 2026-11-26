/** File zxing_reader.wasm nhúng vào bản build dưới dạng base64 — xem plugin zxingReaderWasm trong vite.config.ts. */
declare module "virtual:zxing-reader-wasm" {
  const base64: string;
  export default base64;
}
