// A Tauri command is JSON, so the bytes the image editor holds cross to the shell as
// base64 (see src-tauri/src/board_store/media.rs). Chunked encode because spreading
// a large array into String.fromCharCode overflows the call stack.

/** ArrayBuffer → base64. */
export function bytesToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}
