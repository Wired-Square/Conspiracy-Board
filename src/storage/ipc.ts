import { invoke } from '@tauri-apps/api/core';
import type { z } from 'zod';

/**
 * invoke, then check. The command boundary's Rust structs and the adapter's TS
 * types are mirrored by hand, and a bare `invoke<T>()` *asserts* the shape
 * rather than checking it — a field renamed on either side compiles clean and
 * fails somewhere far away at runtime. Parsing the answer on receipt turns
 * that into a loud, named error at the boundary itself. Schemas live in
 * ipcSchemas.ts, typed against the adapter's types so they cannot drift.
 */
export async function invokeChecked<T>(
  cmd: string,
  schema: z.ZodType<T>,
  args?: Record<string, unknown>,
): Promise<T> {
  const parsed = schema.safeParse(await invoke(cmd, args));
  if (!parsed.success) {
    throw new Error(
      `The shell's ${cmd} answer was not the shape expected: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
