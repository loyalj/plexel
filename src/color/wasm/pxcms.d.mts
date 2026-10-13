/** Types for the Emscripten module scripts/build-cms.mjs builds. Only what cms.ts uses. */
export interface PxCmsModule {
  HEAPU8: Uint8Array
  HEAPU32: Uint32Array
  HEAPF32: Float32Array
  HEAPF64: Float64Array
  UTF8ToString(ptr: number): string
  stringToUTF8(s: string, ptr: number, max: number): void
  lengthBytesUTF8(s: string): number
  _malloc(n: number): number
  _free(ptr: number): void
  _px_init(): void
  _px_last_error(): number
  _px_clear_error(): void
  _px_open(mem: number, len: number): number
  _px_close(p: number): void
  _px_srgb(): number
  _px_lab_d50(): number
  _px_xyz(): number
  _px_rgb(wx: number, wy: number, rx: number, ry: number, gx: number, gy: number, bx: number, by: number, type: number, params: number, count: number, table: number, desc: number, copyright: number): number
  _px_gray(wx: number, wy: number, type: number, params: number, count: number, table: number, desc: number, copyright: number): number
  _px_clut_profile(space: number, channels: number, a2bPoints: number, a2b: number, b2aPoints: number, b2a: number, desc: number, copyright: number): number
  _px_save(p: number, out: number): number
  _px_space(p: number): number
  _px_pcs(p: number): number
  _px_class(p: number): number
  _px_channels(p: number): number
  _px_version(p: number): number
  _px_description(p: number, buf: number, size: number): number
  _px_supports_intent(p: number, intent: number, direction: number): number
  _px_transform(inP: number, outP: number, intent: number, flags: number): number
  _px_proof(inP: number, outP: number, proof: number, intent: number, proofIntent: number, flags: number): number
  _px_do(t: number, inPtr: number, outPtr: number, count: number): void
  _px_free_transform(t: number): void
  _px_set_alarm(a: number, b: number, c: number): void
}

export default function createPxCms(opts?: { wasmBinary?: ArrayBuffer | Uint8Array; locateFile?(name: string): string }): Promise<PxCmsModule>
