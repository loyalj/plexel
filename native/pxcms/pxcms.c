/*
 * pxcms: the part of LittleCMS that Plexel uses, behind a small API made
 * for being called from JavaScript.
 *
 * Profiles and transforms are handed out as opaque pointers. Arrays go in
 * and out through memory the caller allocates with malloc and frees with
 * free (both exported). Every transform is float in and float out, in
 * LittleCMS's float conventions: RGB and Gray 0..1, CMYK 0..100, Lab as
 * L 0..100 and a, b about -128..127.
 *
 * Built by scripts/build-cms.mjs, which compiles this file together with a
 * pinned LittleCMS release using Emscripten in Docker. The result is
 * checked in under src/color/wasm, so building the app never needs either.
 */
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "lcms2.h"

#define EXPORT EMSCRIPTEN_KEEPALIVE

/* --- errors --------------------------------------------------------------
   LittleCMS reports errors through a handler rather than return values.
   The last message is kept for the JS side to read when a call returns 0. */

static char last_error[512];

static void on_error(cmsContext ctx, cmsUInt32Number code, const char *text) {
  (void)ctx;
  (void)code;
  strncpy(last_error, text, sizeof(last_error) - 1);
  last_error[sizeof(last_error) - 1] = 0;
}

EXPORT void px_init(void) { cmsSetLogErrorHandler(on_error); }

EXPORT const char *px_last_error(void) { return last_error; }

EXPORT void px_clear_error(void) { last_error[0] = 0; }

/* --- profiles ------------------------------------------------------------ */

EXPORT cmsHPROFILE px_open(const void *mem, cmsUInt32Number len) { return cmsOpenProfileFromMem(mem, len); }

EXPORT void px_close(cmsHPROFILE p) { cmsCloseProfile(p); }

EXPORT cmsHPROFILE px_srgb(void) { return cmsCreate_sRGBProfile(); }

EXPORT cmsHPROFILE px_lab_d50(void) { return cmsCreateLab4Profile(NULL); }

EXPORT cmsHPROFILE px_xyz(void) { return cmsCreateXYZProfile(); }

/* A tone curve: parametric when `count` is 0 (type and params as in the ICC
   spec, through cmsBuildParametricToneCurve), tabulated otherwise. */
static cmsToneCurve *make_curve(int type, const double *params, int count, const float *table) {
  if (count > 0) return cmsBuildTabulatedToneCurveFloat(NULL, (cmsUInt32Number)count, table);
  return cmsBuildParametricToneCurve(NULL, type, params);
}

static void set_description(cmsHPROFILE p, const char *desc, const char *copyright) {
  cmsMLU *d = cmsMLUalloc(NULL, 1);
  cmsMLUsetASCII(d, "en", "US", desc);
  cmsWriteTag(p, cmsSigProfileDescriptionTag, d);
  cmsMLUfree(d);
  cmsMLU *c = cmsMLUalloc(NULL, 1);
  cmsMLUsetASCII(c, "en", "US", copyright);
  cmsWriteTag(p, cmsSigCopyrightTag, c);
  cmsMLUfree(c);
}

/* An RGB matrix/TRC profile from a white point, three primaries (CIE xy)
   and one curve shared by the three channels. */
EXPORT cmsHPROFILE px_rgb(double wx, double wy, double rx, double ry, double gx, double gy, double bx, double by, int curve_type,
                          const double *params, int count, const float *table, const char *desc, const char *copyright) {
  cmsCIExyY white = {wx, wy, 1.0};
  cmsCIExyYTRIPLE primaries = {{rx, ry, 1.0}, {gx, gy, 1.0}, {bx, by, 1.0}};
  cmsToneCurve *c = make_curve(curve_type, params, count, table);
  if (!c) return NULL;
  cmsToneCurve *curves[3] = {c, c, c};
  cmsHPROFILE p = cmsCreateRGBProfile(&white, &primaries, curves);
  cmsFreeToneCurve(c);
  if (p) set_description(p, desc, copyright);
  return p;
}

/* A Gray profile from a white point and a curve. */
EXPORT cmsHPROFILE px_gray(double wx, double wy, int curve_type, const double *params, int count, const float *table, const char *desc,
                           const char *copyright) {
  cmsCIExyY white = {wx, wy, 1.0};
  cmsToneCurve *c = make_curve(curve_type, params, count, table);
  if (!c) return NULL;
  cmsHPROFILE p = cmsCreateGrayProfile(&white, c);
  cmsFreeToneCurve(c);
  if (p) set_description(p, desc, copyright);
  return p;
}

/* Floats 0..1 to 16-bit table entries, in memory the caller frees. */
static cmsUInt16Number *to16(const float *v, cmsUInt32Number n) {
  cmsUInt16Number *out = (cmsUInt16Number *)malloc(n * sizeof(cmsUInt16Number));
  if (!out) return NULL;
  for (cmsUInt32Number i = 0; i < n; i++) {
    float x = v[i] < 0 ? 0 : v[i] > 1 ? 1 : v[i];
    out[i] = (cmsUInt16Number)(x * 65535.0f + 0.5f);
  }
  return out;
}

/*
 * An output profile from two lookup tables, both float and in LittleCMS's
 * normalised PCS Lab (L/100, (a+128)/255, (b+128)/255):
 *
 *   a2b: device -> Lab, `a2b_points` per input channel, `channels` inputs
 *   b2a: Lab -> device, `b2a_points` per Lab axis, values 0..1
 *
 * The same tables serve every rendering intent. Plexel builds its generic
 * CMYK profile this way, from an ink model in src/color/cmykModel.ts.
 */
EXPORT cmsHPROFILE px_clut_profile(cmsUInt32Number space, int channels, int a2b_points, const float *a2b, int b2a_points, const float *b2a,
                                   const char *desc, const char *copyright) {
  cmsHPROFILE p = cmsCreateProfilePlaceholder(NULL);
  if (!p) return NULL;
  cmsSetProfileVersion(p, 4.3);
  cmsSetDeviceClass(p, cmsSigOutputClass);
  cmsSetColorSpace(p, (cmsColorSpaceSignature)space);
  cmsSetPCS(p, cmsSigLabData);
  cmsSetHeaderRenderingIntent(p, INTENT_PERCEPTUAL);
  set_description(p, desc, copyright);
  cmsWriteTag(p, cmsSigMediaWhitePointTag, cmsD50_XYZ());

  /* The ICC lutAtoB and lutBtoA tags hold 16-bit tables, and LittleCMS
     writes them only with curve sets on both sides of the table, so the
     float tables are quantised here and wrapped in identity curves. */
  cmsUInt32Number in_points[cmsMAXCHANNELS];
  for (int i = 0; i < channels; i++) in_points[i] = (cmsUInt32Number)a2b_points;
  cmsUInt32Number fwd_n = 1;
  for (int i = 0; i < channels; i++) fwd_n *= (cmsUInt32Number)a2b_points;
  cmsUInt32Number back_n = (cmsUInt32Number)(b2a_points * b2a_points * b2a_points);
  cmsUInt16Number *fwd16 = to16(a2b, fwd_n * 3);
  cmsUInt16Number *back16 = to16(b2a, back_n * (cmsUInt32Number)channels);
  cmsUInt32Number lab_points[3] = {(cmsUInt32Number)b2a_points, (cmsUInt32Number)b2a_points, (cmsUInt32Number)b2a_points};

  cmsPipeline *fwd = cmsPipelineAlloc(NULL, (cmsUInt32Number)channels, 3);
  cmsPipeline *back = cmsPipelineAlloc(NULL, 3, (cmsUInt32Number)channels);
  int ok = fwd16 && back16 && fwd && back &&
           cmsPipelineInsertStage(fwd, cmsAT_END, cmsStageAllocToneCurves(NULL, (cmsUInt32Number)channels, NULL)) &&
           cmsPipelineInsertStage(fwd, cmsAT_END, cmsStageAllocCLut16bitGranular(NULL, in_points, (cmsUInt32Number)channels, 3, fwd16)) &&
           cmsPipelineInsertStage(fwd, cmsAT_END, cmsStageAllocToneCurves(NULL, 3, NULL)) &&
           cmsPipelineInsertStage(back, cmsAT_END, cmsStageAllocToneCurves(NULL, 3, NULL)) &&
           cmsPipelineInsertStage(back, cmsAT_END, cmsStageAllocCLut16bitGranular(NULL, lab_points, 3, (cmsUInt32Number)channels, back16)) &&
           cmsPipelineInsertStage(back, cmsAT_END, cmsStageAllocToneCurves(NULL, (cmsUInt32Number)channels, NULL));
  free(fwd16);
  free(back16);
  /* One copy of each table, which the other two intents' tags point to:
     a third of the size of writing it three times. */
  if (ok) ok = cmsWriteTag(p, cmsSigAToB0Tag, fwd) && cmsWriteTag(p, cmsSigBToA0Tag, back);
  if (ok)
    ok = cmsLinkTag(p, cmsSigAToB1Tag, cmsSigAToB0Tag) && cmsLinkTag(p, cmsSigAToB2Tag, cmsSigAToB0Tag) &&
         cmsLinkTag(p, cmsSigBToA1Tag, cmsSigBToA0Tag) && cmsLinkTag(p, cmsSigBToA2Tag, cmsSigBToA0Tag);
  if (fwd) cmsPipelineFree(fwd);
  if (back) cmsPipelineFree(back);
  if (!ok) {
    cmsCloseProfile(p);
    return NULL;
  }
  return p;
}

/* The profile as ICC bytes, into memory the caller frees. Returns the length, 0 on failure. */
EXPORT cmsUInt32Number px_save(cmsHPROFILE p, void **out) {
  cmsUInt32Number len = 0;
  if (!cmsSaveProfileToMem(p, NULL, &len) || len == 0) return 0;
  void *buf = malloc(len);
  if (!buf) return 0;
  if (!cmsSaveProfileToMem(p, buf, &len)) {
    free(buf);
    return 0;
  }
  *out = buf;
  return len;
}

EXPORT cmsUInt32Number px_space(cmsHPROFILE p) { return (cmsUInt32Number)cmsGetColorSpace(p); }

EXPORT cmsUInt32Number px_pcs(cmsHPROFILE p) { return (cmsUInt32Number)cmsGetPCS(p); }

EXPORT cmsUInt32Number px_class(cmsHPROFILE p) { return (cmsUInt32Number)cmsGetDeviceClass(p); }

EXPORT cmsUInt32Number px_channels(cmsHPROFILE p) { return cmsChannelsOfColorSpace(cmsGetColorSpace(p)); }

EXPORT double px_version(cmsHPROFILE p) { return cmsGetProfileVersion(p); }

/* The profile's description, ASCII, into `buf`. Returns the length written. */
EXPORT cmsUInt32Number px_description(cmsHPROFILE p, char *buf, cmsUInt32Number size) {
  return cmsGetProfileInfoASCII(p, cmsInfoDescription, "en", "US", buf, size);
}

EXPORT int px_supports_intent(cmsHPROFILE p, int intent, int direction) {
  return cmsIsIntentSupported(p, (cmsUInt32Number)intent, (cmsUInt32Number)direction);
}

/* --- transforms --------------------------------------------------------- */

/* A float format for a colour space with this many channels, as the TYPE_*_FLT macros build it. */
static cmsUInt32Number float_format(cmsHPROFILE p) {
  cmsColorSpaceSignature space = cmsGetColorSpace(p);
  int pt = _cmsLCMScolorSpace(space);
  cmsUInt32Number n = cmsChannelsOfColorSpace(space);
  return FLOAT_SH(1) | COLORSPACE_SH(pt) | CHANNELS_SH(n) | BYTES_SH(4);
}

EXPORT cmsHTRANSFORM px_transform(cmsHPROFILE in, cmsHPROFILE out, int intent, cmsUInt32Number flags) {
  return cmsCreateTransform(in, float_format(in), out, float_format(out), (cmsUInt32Number)intent, flags);
}

/* A transform from `in` to `out` that shows how `proof` would print it
   (soft-proofing), or marks colours outside `proof`'s gamut when
   cmsFLAGS_GAMUTCHECK is set. */
EXPORT cmsHTRANSFORM px_proof(cmsHPROFILE in, cmsHPROFILE out, cmsHPROFILE proof, int intent, int proof_intent, cmsUInt32Number flags) {
  return cmsCreateProofingTransform(in, float_format(in), out, float_format(out), proof, (cmsUInt32Number)intent,
                                    (cmsUInt32Number)proof_intent, flags);
}

EXPORT void px_do(cmsHTRANSFORM t, const float *in, float *out, cmsUInt32Number count) { cmsDoTransform(t, in, out, count); }

EXPORT void px_free_transform(cmsHTRANSFORM t) { cmsDeleteTransform(t); }

/* The alarm colour marked by a gamut check, in 16-bit device values. */
EXPORT void px_set_alarm(int a, int b, int c) {
  cmsUInt16Number codes[cmsMAXCHANNELS] = {0};
  codes[0] = (cmsUInt16Number)a;
  codes[1] = (cmsUInt16Number)b;
  codes[2] = (cmsUInt16Number)c;
  cmsSetAlarmCodes(codes);
}
