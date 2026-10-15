/**
 * A vector brush drawn small, along an S-curve, as an SVG: the Vector
 * Brushes panel's rows and Brush Options' preview. The pieces are the
 * brush's own drawing (vector/brush.ts), so the preview is what a stroke
 * gets; colorized brushes are shown in black.
 */
import { useMemo } from 'react'
import type { ColourMode } from '../doc/types'
import { blackIn, solid, type Paint } from '../doc/vector'
import type { VectorBrush } from '../doc/vectorBrush'
import { anchor, flattenPath } from '../geom/path'
import { brushPieces } from '../vector/brush'
import { swatchCss } from './ParamControls'

const W = 120
const H = 36

const fillOf = (p: Paint, mode: ColourMode) => swatchCss(p.kind === 'solid' ? p.colour : p.kind === 'gradient' ? p.stops[0].colour : p.colour, mode)

export function BrushPreview({ brush, mode, width = W, height = H }: { brush: VectorBrush; mode: ColourMode; width?: number; height?: number }) {
  const paths = useMemo(() => {
    const line = flattenPath({ fillRule: 'nonzero', subpaths: [{ closed: false, anchors: [anchor(10, H / 2, null, [40, -2]), anchor(W - 10, H / 2, [W - 40, H + 2], null)] }] }, 0.1)
    const pieces = brushPieces(line, { width: brush.kind === 'scatter' ? 7 : 10, paint: solid(blackIn(mode)) }, brush, mode, 0.15)
    const loopD = (l: number[]) => {
      let s = ''
      for (let i = 0; i < l.length; i += 2) s += `${i ? 'L' : 'M'}${l[i].toFixed(1)} ${l[i + 1].toFixed(1)}`
      return `${s}Z`
    }
    return pieces.map((p) => ({ d: p.loops.map(loopD).join(''), rule: p.rule, fill: fillOf(p.paint, mode) }))
  }, [brush, mode])
  return (
    <svg className="brush-preview" width={width} height={height} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill={p.fill} fillRule={p.rule} />
      ))}
    </svg>
  )
}
