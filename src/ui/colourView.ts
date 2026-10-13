/**
 * What the Colour panel shows for a colour in each model, and the colour a
 * set of slider values means.
 *
 * Each model edits in a definite space and profile: the front document's
 * own when it's in that mode (so RGB sliders in an Adobe RGB document are
 * Adobe RGB numbers), otherwise the usual one (sRGB, Generic CMYK, Gray
 * Gamma 2.2). Lab needs no profile. Numbers are shown the way editors
 * show them: RGB 0..255, HSB as degrees and percent, Lab as is, CMYK and
 * Gray as percent of ink.
 */
import type { Converter, ColourValue, Target } from '../color/value'
import type { PickerModel } from '../app/colours'
import { hsbToRgb, rgbToHsb } from '../color/models'
import { DEFAULT_PROFILE_ID, type DisplayProfileId } from '../color/profiles'
import type { Doc } from '../doc/types'

export interface Channel {
  label: string
  min: number
  max: number
  unit: string
}

export const CHANNELS_OF: Record<PickerModel, Channel[]> = {
  rgb: [
    { label: 'R', min: 0, max: 255, unit: '' },
    { label: 'G', min: 0, max: 255, unit: '' },
    { label: 'B', min: 0, max: 255, unit: '' },
  ],
  hsb: [
    { label: 'H', min: 0, max: 360, unit: '°' },
    { label: 'S', min: 0, max: 100, unit: '%' },
    { label: 'B', min: 0, max: 100, unit: '%' },
  ],
  lab: [
    { label: 'L', min: 0, max: 100, unit: '' },
    { label: 'a', min: -128, max: 127, unit: '' },
    { label: 'b', min: -128, max: 127, unit: '' },
  ],
  cmyk: [
    { label: 'C', min: 0, max: 100, unit: '%' },
    { label: 'M', min: 0, max: 100, unit: '%' },
    { label: 'Y', min: 0, max: 100, unit: '%' },
    { label: 'K', min: 0, max: 100, unit: '%' },
  ],
  gray: [{ label: 'K', min: 0, max: 100, unit: '%' }],
}

/** The space and profile a model edits in, given the front document. */
export function targetOf(model: PickerModel, doc: Doc | null): Target {
  if (model === 'lab') return { space: 'lab', profile: null }
  const space = model === 'hsb' ? 'rgb' : model
  return { space, profile: doc && doc.mode === space ? doc.profile : { builtin: DEFAULT_PROFILE_ID[space] } }
}

/** The colour in the model's numbers. */
export function valuesOf(model: PickerModel, colour: ColourValue, conv: Converter, doc: Doc | null): number[] {
  const t = targetOf(model, doc)
  const c = conv.convert(colour, t).c
  switch (model) {
    case 'rgb':
      return c.map((v) => v * 255)
    case 'hsb': {
      const [h, s, b] = rgbToHsb(c)
      return [h, s * 100, b * 100]
    }
    case 'lab':
      return c
    case 'cmyk':
      return c.map((v) => v * 100)
    case 'gray':
      return [(1 - c[0]) * 100]
  }
}

/** The colour that slider values mean. */
export function colourOf(model: PickerModel, values: number[], doc: Doc | null): ColourValue {
  const t = targetOf(model, doc)
  switch (model) {
    case 'rgb':
      return { ...t, c: values.map((v) => v / 255) }
    case 'hsb':
      return { ...t, c: hsbToRgb([values[0], values[1] / 100, values[2] / 100]) }
    case 'lab':
      return { ...t, c: [...values] }
    case 'cmyk':
      return { ...t, c: values.map((v) => v / 100) }
    case 'gray':
      return { ...t, c: [1 - values[0] / 100] }
  }
}

/** A CSS colour showing the colour on the display, in its own colour space when that's Display P3. */
export function cssOf(colour: ColourValue, conv: Converter, display: DisplayProfileId): string {
  const { c } = conv.convert(colour, { space: 'rgb', profile: { builtin: display } })
  const n = c.map((v) => Math.round(v * 10000) / 10000)
  return display === 'display-p3' ? `color(display-p3 ${n[0]} ${n[1]} ${n[2]})` : `rgb(${n.map((v) => Math.round(v * 255)).join(' ')})`
}

/** A slider's track: the colour as that one channel runs from its minimum to its maximum. */
export function trackOf(model: PickerModel, values: number[], index: number, conv: Converter, doc: Doc | null, display: DisplayProfileId, stops = 7): string {
  const ch = CHANNELS_OF[model][index]
  const colours: string[] = []
  for (let i = 0; i < stops; i++) {
    const v = [...values]
    v[index] = ch.min + ((ch.max - ch.min) * i) / (stops - 1)
    // A hue track at zero saturation would be one grey; show it saturated.
    if (model === 'hsb' && index === 0) {
      v[1] = 100
      v[2] = 100
    }
    colours.push(cssOf(colourOf(model, v, doc), conv, display))
  }
  return `linear-gradient(to right, ${colours.join(', ')})`
}
