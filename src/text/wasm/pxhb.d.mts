/** Types for the Emscripten module scripts/build-hb.mjs builds. Only what hb.ts uses. */
export interface PxHbModule {
  HEAPU8: Uint8Array
  HEAPU16: Uint16Array
  HEAPU32: Uint32Array
  HEAPF32: Float32Array
  UTF8ToString(ptr: number, max?: number): string
  stringToUTF8(s: string, ptr: number, max: number): void
  lengthBytesUTF8(s: string): number
  _malloc(n: number): number
  _free(ptr: number): void
  _px_out(): number
  _px_out_len(): number
  _px_version(): number
  _px_face_count(bytes: number, len: number): number
  _px_face(bytes: number, len: number, index: number): number
  _px_face_destroy(face: number): void
  _px_face_upem(face: number): number
  _px_face_glyphs(face: number): number
  _px_face_name(face: number, id: number, buf: number, cap: number): number
  _px_face_table(face: number, tag: number, buf: number, cap: number): number
  _px_face_axes(face: number): number
  _px_face_instances(face: number): number
  _px_face_instance(face: number, i: number): number
  _px_font(face: number): number
  _px_font_destroy(font: number): void
  _px_font_variations(font: number, pairs: number, n: number): void
  _px_font_metrics(font: number): void
  _px_shape(font: number, text: number, len: number, itemOffset: number, itemLength: number, direction: number, script: number, lang: number, features: number): number
  _px_has_glyph(font: number, cp: number): number
  _px_glyph_outline(font: number, glyph: number): number
}

export default function createPxHb(opts?: { wasmBinary?: ArrayBuffer | Uint8Array; locateFile?(name: string): string }): Promise<PxHbModule>
