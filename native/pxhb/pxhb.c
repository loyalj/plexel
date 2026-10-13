/*
 * pxhb: the part of HarfBuzz that Plexel uses, behind a small API made for
 * being called from JavaScript.
 *
 * Faces and fonts are handed out as opaque pointers. Bytes and strings go
 * in through memory the caller allocates with malloc and frees with free
 * (both exported); results come back in static buffers the caller reads
 * straight away (px_glyphs, px_path, px_floats), so nothing else needs
 * freeing.
 *
 * Fonts are set to a scale of their units per em: shaped positions and
 * outlines come back in font units, and the caller scales them to the size
 * the text is set at.
 *
 * Built by scripts/build-hb.mjs, which compiles this file together with a
 * pinned HarfBuzz release (its amalgamated harfbuzz.cc) using Emscripten in
 * Docker. The result is checked in under src/text/wasm, so building the app
 * never needs either.
 */
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "hb.h"
#include "hb-ot.h"

#define EXPORT EMSCRIPTEN_KEEPALIVE

/* --- a growable buffer of 32-bit values, read by the caller ------------------------ */

typedef struct {
  float *data;
  int len;
  int cap;
} floats_t;

static floats_t out = {0, 0, 0};

static void out_reset(void) { out.len = 0; }

static void out_push(float v) {
  if (out.len == out.cap) {
    int cap = out.cap ? out.cap * 2 : 4096;
    float *next = (float *)realloc(out.data, (size_t)cap * sizeof(float));
    if (!next) return;
    out.data = next;
    out.cap = cap;
  }
  out.data[out.len++] = v;
}

/* Where the last result is, and how many values it has. */
EXPORT float *px_out(void) { return out.data; }
EXPORT int px_out_len(void) { return out.len; }

/* --- faces ---------------------------------------------------------------------------- */

/* How many faces a file holds (a .ttc holds several). The bytes are copied. */
EXPORT unsigned px_face_count(const char *bytes, unsigned len) {
  hb_blob_t *blob = hb_blob_create(bytes, len, HB_MEMORY_MODE_DUPLICATE, NULL, NULL);
  unsigned n = hb_face_count(blob);
  hb_blob_destroy(blob);
  return n;
}

/* A face from a file's bytes (copied), or null when they aren't a font. */
EXPORT hb_face_t *px_face(const char *bytes, unsigned len, unsigned index) {
  hb_blob_t *blob = hb_blob_create(bytes, len, HB_MEMORY_MODE_DUPLICATE, NULL, NULL);
  hb_face_t *face = hb_face_create(blob, index);
  hb_blob_destroy(blob);
  if (hb_face_get_glyph_count(face) == 0) {
    hb_face_destroy(face);
    return NULL;
  }
  return face;
}

EXPORT void px_face_destroy(hb_face_t *face) { hb_face_destroy(face); }

EXPORT unsigned px_face_upem(hb_face_t *face) { return hb_face_get_upem(face); }

EXPORT unsigned px_face_glyphs(hb_face_t *face) { return hb_face_get_glyph_count(face); }

/* One of the face's names (1 family, 2 subfamily, 4 full, 6 PostScript, 16
   and 17 typographic family and subfamily), in English where it has one,
   written as UTF-8 into buf. Returns its length, 0 when there's none. */
EXPORT unsigned px_face_name(hb_face_t *face, unsigned id, char *buf, unsigned cap) {
  unsigned size = cap;
  unsigned len = hb_ot_name_get_utf8(face, (hb_ot_name_id_t)id, hb_language_from_string("en", -1), &size, buf);
  if (len == 0) {
    size = cap;
    len = hb_ot_name_get_utf8(face, (hb_ot_name_id_t)id, HB_LANGUAGE_INVALID, &size, buf);
  }
  return len < cap ? len : cap - 1;
}

/* A table's bytes (by tag, as four ASCII letters packed big-endian), copied
   into buf up to cap. Returns the table's whole length. */
EXPORT unsigned px_face_table(hb_face_t *face, unsigned tag, char *buf, unsigned cap) {
  hb_blob_t *blob = hb_face_reference_table(face, (hb_tag_t)tag);
  unsigned len = 0;
  const char *data = hb_blob_get_data(blob, &len);
  if (data && buf && cap) memcpy(buf, data, len < cap ? len : cap);
  hb_blob_destroy(blob);
  return len;
}

/* The face's variation axes into px_out: the tag in two halves, min, default, max, name id, flags; seven values each. */
EXPORT unsigned px_face_axes(hb_face_t *face) {
  out_reset();
  unsigned n = hb_ot_var_get_axis_count(face);
  for (unsigned i = 0; i < n; i++) {
    hb_ot_var_axis_info_t info;
    unsigned one = 1;
    hb_ot_var_get_axis_infos(face, i, &one, &info);
    out_push((float)(info.tag >> 16));
    out_push((float)(info.tag & 0xffff));
    out_push(info.min_value);
    out_push(info.default_value);
    out_push(info.max_value);
    out_push((float)info.name_id);
    out_push((float)info.flags);
  }
  return n;
}

/* A named instance's subfamily name id, and its coordinates into px_out. */
EXPORT unsigned px_face_instances(hb_face_t *face) { return hb_ot_var_get_named_instance_count(face); }

EXPORT unsigned px_face_instance(hb_face_t *face, unsigned i) {
  out_reset();
  unsigned n = hb_ot_var_get_axis_count(face);
  float *coords = (float *)malloc(sizeof(float) * (n ? n : 1));
  unsigned len = n;
  hb_ot_var_named_instance_get_design_coords(face, i, &len, coords);
  for (unsigned k = 0; k < len; k++) out_push(coords[k]);
  free(coords);
  return hb_ot_var_named_instance_get_subfamily_name_id(face, i);
}

/* --- fonts ---------------------------------------------------------------------------- */

EXPORT hb_font_t *px_font(hb_face_t *face) {
  hb_font_t *font = hb_font_create(face);
  unsigned upem = hb_face_get_upem(face);
  hb_font_set_scale(font, (int)upem, (int)upem);
  return font;
}

EXPORT void px_font_destroy(hb_font_t *font) { hb_font_destroy(font); }

/* Variation coordinates: n pairs of (tag, value) as floats, the tag split in two halves. */
EXPORT void px_font_variations(hb_font_t *font, const float *pairs, unsigned n) {
  hb_variation_t *v = (hb_variation_t *)malloc(sizeof(hb_variation_t) * (n ? n : 1));
  for (unsigned i = 0; i < n; i++) {
    v[i].tag = ((unsigned)pairs[i * 3] << 16) | (unsigned)pairs[i * 3 + 1];
    v[i].value = pairs[i * 3 + 2];
  }
  hb_font_set_variations(font, v, n);
  free(v);
}

/* Metrics in font units into px_out: ascender, descender, line gap, x-height,
   cap height, underline offset and size, strikeout offset and size. */
EXPORT void px_font_metrics(hb_font_t *font) {
  out_reset();
  hb_font_extents_t e;
  hb_font_get_h_extents(font, &e);
  out_push((float)e.ascender);
  out_push((float)e.descender);
  out_push((float)e.line_gap);
  hb_ot_metrics_tag_t tags[] = {HB_OT_METRICS_TAG_X_HEIGHT, HB_OT_METRICS_TAG_CAP_HEIGHT, HB_OT_METRICS_TAG_UNDERLINE_OFFSET, HB_OT_METRICS_TAG_UNDERLINE_SIZE, HB_OT_METRICS_TAG_STRIKEOUT_OFFSET, HB_OT_METRICS_TAG_STRIKEOUT_SIZE};
  for (int i = 0; i < 6; i++) {
    hb_position_t p = 0;
    hb_ot_metrics_get_position_with_fallback(font, tags[i], &p);
    out_push((float)p);
  }
}

/* --- shaping ---------------------------------------------------------------------------- */

/*
 * Shapes item_length UTF-16 units of text from item_offset (the whole
 * paragraph is given, so shaping sees its context). direction is
 * HarfBuzz's (4 LTR, 5 RTL); script an ISO 15924 tag packed big-endian, or
 * 0 to have HarfBuzz guess; lang a BCP 47 tag or empty; features a
 * comma-separated list in HarfBuzz's syntax ("kern=0,liga,+smcp").
 * Glyphs go into px_out, six values each: glyph id, cluster (a UTF-16
 * offset into the text), x advance, y advance, x offset, y offset.
 */
EXPORT unsigned px_shape(hb_font_t *font, const uint16_t *text, int len, unsigned item_offset, int item_length, int direction, unsigned script, const char *lang, const char *features) {
  hb_buffer_t *buf = hb_buffer_create();
  hb_buffer_set_cluster_level(buf, HB_BUFFER_CLUSTER_LEVEL_MONOTONE_CHARACTERS);
  hb_buffer_add_utf16(buf, text, len, item_offset, item_length);
  hb_buffer_set_direction(buf, (hb_direction_t)direction);
  if (script) hb_buffer_set_script(buf, hb_script_from_iso15924_tag((hb_tag_t)script));
  if (lang && lang[0]) hb_buffer_set_language(buf, hb_language_from_string(lang, -1));
  hb_buffer_guess_segment_properties(buf);

  hb_feature_t feats[64];
  unsigned nf = 0;
  if (features) {
    const char *p = features;
    while (*p && nf < 64) {
      const char *end = strchr(p, ',');
      int l = end ? (int)(end - p) : (int)strlen(p);
      if (l > 0 && hb_feature_from_string(p, l, &feats[nf])) nf++;
      if (!end) break;
      p = end + 1;
    }
  }
  hb_shape(font, buf, feats, nf);

  unsigned n = 0;
  hb_glyph_info_t *info = hb_buffer_get_glyph_infos(buf, &n);
  hb_glyph_position_t *pos = hb_buffer_get_glyph_positions(buf, &n);
  out_reset();
  for (unsigned i = 0; i < n; i++) {
    out_push((float)info[i].codepoint);
    out_push((float)info[i].cluster);
    out_push((float)pos[i].x_advance);
    out_push((float)pos[i].y_advance);
    out_push((float)pos[i].x_offset);
    out_push((float)pos[i].y_offset);
  }
  hb_buffer_destroy(buf);
  return n;
}

/* Whether the font has a glyph for a code point. */
EXPORT int px_has_glyph(hb_font_t *font, unsigned cp) {
  hb_codepoint_t g = 0;
  return hb_font_get_nominal_glyph(font, cp, &g) ? 1 : 0;
}

/* --- outlines ---------------------------------------------------------------------------- */

/* A glyph's outline into px_out in font units, y up as fonts have it:
   0 x y (move), 1 x y (line), 2 cx cy x y (quadratic), 3 c1x c1y c2x c2y x y
   (cubic), 4 (close). */

static void move_to(hb_draw_funcs_t *f, void *d, hb_draw_state_t *s, float x, float y, void *u) {
  (void)f; (void)d; (void)s; (void)u;
  out_push(0); out_push(x); out_push(y);
}
static void line_to(hb_draw_funcs_t *f, void *d, hb_draw_state_t *s, float x, float y, void *u) {
  (void)f; (void)d; (void)s; (void)u;
  out_push(1); out_push(x); out_push(y);
}
static void quad_to(hb_draw_funcs_t *f, void *d, hb_draw_state_t *s, float cx, float cy, float x, float y, void *u) {
  (void)f; (void)d; (void)s; (void)u;
  out_push(2); out_push(cx); out_push(cy); out_push(x); out_push(y);
}
static void cubic_to(hb_draw_funcs_t *f, void *d, hb_draw_state_t *s, float c1x, float c1y, float c2x, float c2y, float x, float y, void *u) {
  (void)f; (void)d; (void)s; (void)u;
  out_push(3); out_push(c1x); out_push(c1y); out_push(c2x); out_push(c2y); out_push(x); out_push(y);
}
static void close_path(hb_draw_funcs_t *f, void *d, hb_draw_state_t *s, void *u) {
  (void)f; (void)d; (void)s; (void)u;
  out_push(4);
}

static hb_draw_funcs_t *draw_funcs = NULL;

EXPORT int px_glyph_outline(hb_font_t *font, unsigned glyph) {
  if (!draw_funcs) {
    draw_funcs = hb_draw_funcs_create();
    hb_draw_funcs_set_move_to_func(draw_funcs, move_to, NULL, NULL);
    hb_draw_funcs_set_line_to_func(draw_funcs, line_to, NULL, NULL);
    hb_draw_funcs_set_quadratic_to_func(draw_funcs, quad_to, NULL, NULL);
    hb_draw_funcs_set_cubic_to_func(draw_funcs, cubic_to, NULL, NULL);
    hb_draw_funcs_set_close_path_func(draw_funcs, close_path, NULL, NULL);
    hb_draw_funcs_make_immutable(draw_funcs);
  }
  out_reset();
  hb_font_draw_glyph(font, glyph, draw_funcs, NULL);
  return out.len;
}

EXPORT const char *px_version(void) { return hb_version_string(); }
