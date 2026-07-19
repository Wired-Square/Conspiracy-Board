// base64 ↔ bytes, in one place. A Tauri command is JSON, so media bytes cross the
// webview↔shell boundary as base64 (see src-tauri/src/board_store.rs), and both a
// data: URL and an Apple Mail drop arrive base64 too. Chunked encode because
// spreading a large array into String.fromCharCode overflows the call stack.

/** ArrayBuffer → base64. */
export function bytesToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

/** base64 → ArrayBuffer. */
export function b64ToBytes(b64: string): ArrayBuffer {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}
