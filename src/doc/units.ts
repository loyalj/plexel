/**
 * Lengths in the units people type: pixels, inches, centimetres,
 * millimetres and points. A document's size is always stored in pixels;
 * its resolution (pixels per inch) turns the rest into pixels and back.
 */

export type Unit = 'px' | 'in' | 'cm' | 'mm' | 'pt'

export const UNITS: { id: Unit; label: string; perInch: number }[] = [
  { id: 'px', label: 'Pixels', perInch: 0 },
  { id: 'in', label: 'Inches', perInch: 1 },
  { id: 'cm', label: 'Centimetres', perInch: 2.54 },
  { id: 'mm', label: 'Millimetres', perInch: 25.4 },
  { id: 'pt', label: 'Points', perInch: 72 },
]

const perInch = (u: Unit) => UNITS.find((x) => x.id === u)!.perInch

/** A length in `unit` as pixels at `ppi`, rounded to whole pixels. */
export function toPixels(value: number, unit: Unit, ppi: number): number {
  if (unit === 'px') return Math.round(value)
  return Math.round((value / perInch(unit)) * ppi)
}

/** Pixels as a length in `unit` at `ppi`, unrounded. */
export function fromPixels(px: number, unit: Unit, ppi: number): number {
  if (unit === 'px') return px
  return (px / ppi) * perInch(unit)
}

/** For a field: whole pixels, and at most three decimals elsewhere, with no trailing zeros. */
export function formatLength(px: number, unit: Unit, ppi: number): string {
  const v = fromPixels(px, unit, ppi)
  return unit === 'px' ? String(Math.round(v)) : String(Math.round(v * 1000) / 1000)
}
