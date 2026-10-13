/**
 * Align and distribute: how far to move each of several boxes, as
 * Photoshop's Move tool and Illustrator's Align panel do it. Pure maths
 * over document pixels, checked in Node (check:snap); the app measures the
 * layers and moves them (app/align.ts).
 */
import type { Box } from './snap'

export type AlignOp = 'left' | 'hcentre' | 'right' | 'top' | 'vcentre' | 'bottom'
export type DistributeOp = AlignOp | 'hspace' | 'vspace'

export const ALIGN_OPS: { id: AlignOp; label: string }[] = [
  { id: 'left', label: 'Left Edges' },
  { id: 'hcentre', label: 'Horizontal Centres' },
  { id: 'right', label: 'Right Edges' },
  { id: 'top', label: 'Top Edges' },
  { id: 'vcentre', label: 'Vertical Centres' },
  { id: 'bottom', label: 'Bottom Edges' },
]

export const DISTRIBUTE_OPS: { id: DistributeOp; label: string }[] = [
  ...ALIGN_OPS,
  { id: 'hspace', label: 'Horizontal Spacing' },
  { id: 'vspace', label: 'Vertical Spacing' },
]

/** Which axis an operation works along, and where on a box it reads: 0 the near edge, 0.5 the centre, 1 the far edge. */
const SPEC: Record<AlignOp, { axis: 0 | 1; at: number }> = {
  left: { axis: 0, at: 0 },
  hcentre: { axis: 0, at: 0.5 },
  right: { axis: 0, at: 1 },
  top: { axis: 1, at: 0 },
  vcentre: { axis: 1, at: 0.5 },
  bottom: { axis: 1, at: 1 },
}

const feature = (b: Box, axis: 0 | 1, at: number) => b[axis] + (b[axis + 2] - b[axis]) * at
const size = (b: Box, axis: 0 | 1) => b[axis + 2] - b[axis]
const delta = (axis: 0 | 1, d: number): [number, number] => (axis === 0 ? [d, 0] : [0, d])

/** How far to move each box so its edge or centre lines up with `ref`'s. */
export function alignDeltas(boxes: Box[], op: AlignOp, ref: Box): [number, number][] {
  const { axis, at } = SPEC[op]
  const to = feature(ref, axis, at)
  return boxes.map((b) => delta(axis, to - feature(b, axis, at)))
}

/**
 * How far to move each box to spread them evenly: their edges or centres
 * the same distance apart, or (`hspace`, `vspace`) the same gap between
 * each. Without a `range` the first and last stay where they are, and the
 * rest spread between them. With one (the canvas), the first and last are
 * put against its edges, and the rest spread between.
 */
export function distributeDeltas(boxes: Box[], op: DistributeOp, range: Box | null = null): [number, number][] {
  const n = boxes.length
  const out: [number, number][] = boxes.map(() => [0, 0])
  if (n < 2 || (n < 3 && !range)) return out
  if (op === 'hspace' || op === 'vspace') {
    const axis = op === 'hspace' ? 0 : 1
    const order = boxes.map((_, i) => i).sort((p, q) => feature(boxes[p], axis, 0.5) - feature(boxes[q], axis, 0.5))
    const start = range ? range[axis] : boxes[order[0]][axis]
    const end = range ? range[axis + 2] : boxes[order[n - 1]][axis + 2]
    const total = order.reduce((s, i) => s + size(boxes[i], axis), 0)
    const gap = (end - start - total) / (n - 1)
    let pos = start
    for (const i of order) {
      out[i] = delta(axis, pos - boxes[i][axis])
      pos += size(boxes[i], axis) + gap
    }
    return out
  }
  const { axis, at } = SPEC[op]
  const order = boxes.map((_, i) => i).sort((p, q) => feature(boxes[p], axis, at) - feature(boxes[q], axis, at))
  const first = boxes[order[0]]
  const last = boxes[order[n - 1]]
  // Against the range's edges: the first box touching its start, the last its end.
  const from = range ? range[axis] + size(first, axis) * at : feature(first, axis, at)
  const to = range ? range[axis + 2] - size(last, axis) * (1 - at) : feature(last, axis, at)
  order.forEach((i, k) => {
    out[i] = delta(axis, from + ((to - from) * k) / (n - 1) - feature(boxes[i], axis, at))
  })
  return out
}
