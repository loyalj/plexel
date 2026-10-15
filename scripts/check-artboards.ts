/**
 * Artboards and symbols, in the model: artboards made, moved, sized and
 * kept at the top level; the canvas grown round them (and how far things
 * moved); the pasteboard's shape; one artboard as a document of its own;
 * symbols made from layers, placed, edited, renamed, replaced, broken and
 * deleted; both turned into plain layers for the renderer and exporters
 * (doc/expand.ts), the same objects while nothing changes; files written
 * and read back; copying instances with their symbols; where a new layer
 * goes.
 *
 * Run with: npm run check:artboards
 */
import { addArtboard, artboardAt, artboardDoc, artboardOf, artboardRect, artboardsOf, fitCanvas, isArtboard, makeArtboard, nextArtboardPlace, pasteboardQuads, setArtboard, setArtboardRect, PASTEBOARD, type ArtboardNode } from '../src/doc/artboards'
import { createDoc, insertNode, moveNode, tileSetsOf, transformNode } from '../src/doc/edit'
import { expandDoc, ownerOf } from '../src/doc/expand'
import { fragmentOf, pasteFragment } from '../src/doc/fragment'
import { makeNode } from '../src/doc/nodes'
import { docToJson, readDocJson } from '../src/doc/serialize'
import { breakLink, deleteSymbol, instancesOf, makeSymbol, placeSymbol, renameSymbol, replaceSymbol, setSymbolContent, symbolById } from '../src/doc/symbols'
import { placeOf, whereNew } from '../src/doc/tree'
import type { Doc, DocNode } from '../src/doc/types'
import { fillItem, solid } from '../src/doc/vector'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}

const base = (): Doc => createDoc({ name: 'Boards', width: 800, height: 600, resolution: 72, mode: 'rgb', depth: 8, profile: { builtin: 'srgb' } }, 'root')
const rect = (id: string, x: number, y: number, w: number, h: number): DocNode => {
  const n = makeNode('vector', id, id, { geometry: { kind: 'shape', shape: { type: 'rect', x: 0, y: 0, w, h, radii: [0, 0, 0, 0], corner: 'round' } }, appearance: [fillItem(solid([1, 0, 0]))], graphicStyle: null })
  n.transform = [1, 0, 0, 1, x, y]
  return n as DocNode
}
const pixel = (id: string, tiles: string): DocNode => makeNode('pixel', id, id, { tiles }) as DocNode

// --- artboards ------------------------------------------------------------------------------
console.log('\nartboards')
{
  let d = addArtboard(base(), makeArtboard('a1', 'Artboard 1', 0, 0, 800, 600, 'rgb'))
  check('an artboard is a group with its size, a white background and clipping', isArtboard(d.nodes.a1) && (d.nodes.a1 as ArtboardNode).props.artboard.width === 800 && (d.nodes.a1 as ArtboardNode).props.artboard.background?.join() === '1,1,1' && (d.nodes.a1 as ArtboardNode).props.artboard.clip)
  const f = fitCanvas(d)
  check('the canvas grows round it, everything moving by the room left of it', f.dx === PASTEBOARD && f.dy === PASTEBOARD && f.doc.width === 800 + 2 * PASTEBOARD && artboardRect(f.doc.nodes.a1 as ArtboardNode).join() === `${PASTEBOARD},${PASTEBOARD},${PASTEBOARD + 800},${PASTEBOARD + 600}`)
  check('fitted again, nothing moves', fitCanvas(f.doc).dx === 0 && fitCanvas(f.doc).doc === f.doc)
  d = f.doc
  const [nx, ny] = nextArtboardPlace(d)
  check('the next goes to the right of the others, level with them', nx === PASTEBOARD + 800 + 100 && ny === PASTEBOARD)
  d = fitCanvas(addArtboard(d, makeArtboard('a2', 'Artboard 2', nx, ny, 400, 300, 'rgb'))).doc
  check('two artboards, top first', artboardsOf(d).map((a) => a.id).join() === 'a2,a1')
  check('found by a point on them', artboardAt(d, PASTEBOARD + 10, PASTEBOARD + 10)?.id === 'a1' && artboardAt(d, nx + 10, ny + 10)?.id === 'a2' && artboardAt(d, 5, 5) === null)
  d = insertNode(d, rect('r', PASTEBOARD + 100, PASTEBOARD + 100, 50, 50), 'a1', 0)
  check('a layer on one is in it', artboardOf(d, 'r')?.id === 'a1')
  const moved = transformNode(d, 'a1', [1, 0, 0, 1, 30, 40])
  check('moving an artboard carries its layers', moved.nodes.r.transform[4] === PASTEBOARD + 130 && moved.nodes.r.transform[5] === PASTEBOARD + 140)
  const sized = setArtboardRect(d, 'a1', [PASTEBOARD - 50, PASTEBOARD, PASTEBOARD + 800, PASTEBOARD + 600], false)
  check('sizing one leaves its layers where they are', artboardRect(sized.nodes.a1 as ArtboardNode)[0] === PASTEBOARD - 50 && (sized.nodes.a1 as ArtboardNode).props.artboard.width === 850 && sized.nodes.r.transform[4] === PASTEBOARD + 100)
  const left = fitCanvas(setArtboardRect(d, 'a1', [-300, PASTEBOARD, 500, PASTEBOARD + 600], false))
  check('one past the canvas’s left edge: everything moves right, and says how far', left.dx === 300 + PASTEBOARD && artboardRect(left.doc.nodes.a1 as ArtboardNode)[0] === PASTEBOARD && left.doc.nodes.r.transform[4] === PASTEBOARD + 100 + left.dx)
  check('an artboard can’t go inside a group or another artboard', moveNode(d, 'a2', 'a1', 0) === d && insertNode(d, makeArtboard('a3', 'x', 0, 0, 10, 10, 'rgb'), 'a1', 0) === d)
  check('its background changed', (setArtboard(d, 'a1', { background: null }).nodes.a1 as ArtboardNode).props.artboard.background === null)
  // The pasteboard: everything on the canvas but the artboards.
  const quads = pasteboardQuads(d)
  let area = 0
  for (let i = 0; i < quads.length; i += 4) area += (quads[i + 1][0] - quads[i][0]) * (quads[i + 2][1] - quads[i][1])
  check('the pasteboard is the canvas less the artboards', area === d.width * d.height - 800 * 600 - 400 * 300, `${area}`)
  const one = artboardDoc(d, 'a1')!
  check('one artboard as a document: its size, it alone, at the corner', one.width === 800 && one.height === 600 && one.nodes[one.root].children!.join() === 'a1' && one.nodes.a1.transform[4] === 0 && one.nodes.r.transform[4] === 100 && one.guides.length === 0)

  // As plain layers.
  const ex = expandDoc(d)
  const g = ex.nodes.a1
  check('expanded, an artboard is an isolated group with its background at the bottom and its clip among its masks', g.kind === 'group' && !('artboard' in g.props) && g.blend === 'normal' && g.children![0] === 'a1~bg' && ex.nodes['a1~bg'].kind === 'vector' && g.masks.includes('a1~clip') && ex.nodes['a1~clip'].kind === 'mask')
  check('expanded twice, the same document', expandDoc(d) === ex)
  const d2 = { ...d, nodes: { ...d.nodes, r: { ...d.nodes.r, name: 'renamed' } } }
  check('an edit elsewhere keeps the artboard’s made-up layers the same objects', expandDoc(d2).nodes['a1~bg'] === ex.nodes['a1~bg'])
  check('no clip, no clip mask; no background, no background', !expandDoc(setArtboard(setArtboard(d, 'a1', { clip: false }), 'a1', { background: null })).nodes['a1~clip'] && !expandDoc(setArtboard(d, 'a1', { background: null })).nodes['a1~bg'])
  check('a made-up layer belongs to the node it stands for', ownerOf('a1~bg') === 'a1' && ownerOf('plain') === 'plain')
  const plain = base()
  check('…the very same object', expandDoc(plain) === plain)

  // Files.
  const back = readDocJson(docToJson(d))
  check('written and read back, the artboards come back as they were', back.ok && isArtboard(back.doc.nodes.a1) && JSON.stringify((back.doc.nodes.a1 as ArtboardNode).props.artboard) === JSON.stringify((d.nodes.a1 as ArtboardNode).props.artboard) && back.doc.nodes.a1.transform.join() === d.nodes.a1.transform.join())

  // Where a new layer goes.
  check('a new layer with an artboard selected goes into it, on top', whereNew(d, 'a1').parent === 'a1' && whereNew(d, 'a1').index === d.nodes.a1.children!.length)
  check('drawn on another artboard than the selected layer’s, it goes on that one', whereNew(d, 'r', [nx + 5, ny + 5]).parent === 'a2')
  check('drawn on the selected layer’s own artboard, above that layer', whereNew(d, 'r', [PASTEBOARD + 5, PASTEBOARD + 5]).parent === 'a1' && whereNew(d, 'r', [PASTEBOARD + 5, PASTEBOARD + 5]).index === (placeOf(d, 'r')!.index + 1))
}

// --- symbols ----------------------------------------------------------------------------------
console.log('\nsymbols')
{
  let d = base()
  d = insertNode(d, rect('r1', 100, 100, 50, 40), 'root', 0)
  d = insertNode(d, pixel('p1', 'set-1'), 'root', 1)
  d = makeSymbol(d, ['r1', 'p1'], [100, 100, 150, 140], { symbolId: 's1', instanceId: 'i1', rootId: 'sroot', name: 'Badge' })
  const s = symbolById(d, 's1')!
  check('New Symbol: the layers become its contents, at the origin, the canvas their box', !!s && s.content.width === 50 && s.content.height === 40 && s.content.nodes.r1.transform[4] === 0 && s.content.nodes.r1.transform[5] === 0)
  check('and an instance takes their place, where the topmost was, showing them where they were', !d.nodes.r1 && !d.nodes.p1 && d.nodes.i1?.kind === 'symbol' && d.nodes.root.children!.join() === 'i1' && d.nodes.i1.transform[4] === 100 && d.nodes.i1.transform[5] === 100)
  check('the symbol’s tiles are the document’s', tileSetsOf(d).includes('set-1'))
  d = placeSymbol(d, 's1', 'i2', 'root', 1, 400, 300)
  check('placed again, centred on the point', d.nodes.i2.transform[4] === 375 && d.nodes.i2.transform[5] === 280 && instancesOf(d, 's1').length === 2)
  // As plain layers.
  const ex = expandDoc(d)
  check('expanded, an instance is a group of copies of its symbol’s layers', ex.nodes.i1.kind === 'group' && ex.nodes.i1.children!.join() === 'i1~r1,i1~p1' && ex.nodes['i1~r1'].kind === 'vector')
  check('each through the instance’s transform', ex.nodes['i2~r1'].transform[4] === 375 && ex.nodes['i1~r1'].transform[4] === 100)
  check('the instance’s opacity and mode are the group’s', expandDoc({ ...d, nodes: { ...d.nodes, i1: { ...d.nodes.i1, opacity: 0.5, blend: 'multiply' } } }).nodes.i1.opacity === 0.5)
  const red = s.content
  const blue = { ...red, nodes: { ...red.nodes, r1: { ...red.nodes.r1, props: { ...(red.nodes.r1 as DocNode & { kind: 'vector' }).props, appearance: [fillItem(solid([0, 0, 1]))] } } as DocNode } }
  const d3 = setSymbolContent(d, 's1', blue)
  const ex3 = expandDoc(d3)
  check('edit the symbol and every instance follows', (ex3.nodes['i1~r1'] as DocNode & { kind: 'vector' }).props.appearance[0].paint.kind === 'solid' && JSON.stringify((ex3.nodes['i2~r1'] as DocNode & { kind: 'vector' }).props.appearance[0].paint) === JSON.stringify(solid([0, 0, 1])))
  check('an instance unchanged, and its symbol unchanged, keeps its copies', expandDoc({ ...d, name: 'other' }).nodes['i1~r1'] === ex.nodes['i1~r1'])
  check('renamed', symbolById(renameSymbol(d, 's1', 'Seal'), 's1')!.name === 'Seal')
  // Nested: an instance inside a symbol.
  let n = d
  n = makeSymbol(n, ['i2'], [375, 280, 425, 320], { symbolId: 's2', instanceId: 'i3', rootId: 'sroot2', name: 'Outer' })
  const exn = expandDoc(n)
  check('an instance inside a symbol is expanded too', exn.nodes['i3~i2']?.kind === 'group' && exn.nodes['i3~i2~r1']?.kind === 'vector' && exn.nodes['i3~i2~r1'].transform[4] === 375)
  // Break Link, Replace, Delete.
  let k = 0
  const fresh = () => `new${++k}`
  const broken = breakLink(d, 'i1', fresh)
  const g = Object.values(broken.nodes).find((x) => x.kind === 'group' && x.id !== 'root')!
  check('Break Link: a group of its own in its place, copies through its transform', !broken.nodes.i1 && broken.nodes.root.children!.includes(g.id) && g.children!.length === 2 && broken.nodes[g.children![0]].transform[4] === 100)
  check('the other instance still follows the symbol', instancesOf(broken, 's1').map((x) => x.id).join() === 'i2')
  const d4 = { ...d, symbols: [...d.symbols!, { ...s, id: 's9', name: 'Other' }] }
  check('Replace: the instance shows another symbol, keeping its place', (replaceSymbol(d4, 'i2', 's9').nodes.i2 as DocNode & { kind: 'symbol' }).props.symbol === 's9' && replaceSymbol(d4, 'i2', 's9').nodes.i2.transform[4] === 375)
  const del = deleteSymbol(d, 's1', fresh)
  check('Delete: the symbol goes, its instances become groups of their own', !symbolById(del, 's1') && !Object.values(del.nodes).some((x) => x.kind === 'symbol') && Object.values(del.nodes).filter((x) => x.kind === 'group' && x.id !== 'root').length === 2)
  // Files.
  const back = readDocJson(docToJson(d))
  check('written and read back, the symbols and their instances come back', back.ok && symbolById(back.doc, 's1')?.content.nodes.r1?.kind === 'vector' && back.doc.nodes.i1?.kind === 'symbol' && back.warnings.length === 0, back.ok ? back.warnings.join('; ') : back.error)
  // Copy and paste into another document: the symbol comes too.
  const frag = fragmentOf(d, ['i2'], 'fr')
  check('copied, an instance takes its symbol with it', frag.symbols?.map((x) => x.id).join() === 's1')
  const pasted = pasteFragment(base(), frag, { parent: 'root', index: 0, newId: () => `p${++k}` })
  check('pasted into another document, the symbol is added there', symbolById(pasted.doc, 's1')?.name === 'Badge' && pasted.ids.length === 1)
}

console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
