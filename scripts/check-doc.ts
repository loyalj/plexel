/**
 * The document model: creating documents, every edit, the tree's rules,
 * history, the names history gives each step, and the loader's repairs.
 *
 * Edits are pure, so most of this is "this document in, that one out".
 * The loader gets the hardest treatment: it's handed broken, hostile and
 * future documents and must always come back with a usable one, or a
 * clear refusal, and never a throw.
 *
 * Run with: npm run check:doc
 */
import { describeEdit } from '../src/doc/describe'
import {
  DEFAULT_PROFILES,
  DOC_FORMAT,
  addGroup,
  addAdjustment,
  addEffect,
  addMask,
  carried,
  convertToSmartObject,
  dropLostSets,
  moveEffect,
  setFx,
  setParams,
  setSmartContent,
  setTiles,
  clipToBelow,
  compose,
  crop,
  invertAffine,
  moveBy,
  releaseClip,
  setMaskProps,
  setSelection,
  tileSetsOf,
  transformNode,
  addPattern,
  addChannel,
  removeChannel,
  removePattern,
  renameChannel,
  renamePattern,
  setChannelTiles,
  fillsAsShapes,
  createDoc,
  insertNode,
  moveNode,
  removeNode,
  renameDoc,
  renameNode,
  resizeCanvas,
  setBlend,
  setLocked,
  setOpacity,
  setResolution,
  setTiling,
  setVisible,
  shiftNode,
  type NewDocOptions,
} from '../src/doc/edit'
import { HISTORY_LIMIT, canRedo, canUndo, commit, initHistory, jumpTo, redo, redoLabel, steps, undo, undoLabel } from '../src/doc/history'
import { NODE_DEFS, NODE_KINDS, makeNode } from '../src/doc/nodes'
import { DOC_APP, docToJson, readDocJson } from '../src/doc/serialize'
import { freshName, layerRows, neighbourOf, placeOf, subtree } from '../src/doc/tree'
import { MAX_SIDE, type Doc, type DocNode } from '../src/doc/types'
import { fragmentLayers, fragmentOf, pasteFragment, pixelFragment } from '../src/doc/fragment'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}

const OPTS: NewDocOptions = { name: 'Poster', width: 2000, height: 1000, resolution: 300, mode: 'rgb', depth: 16, profile: DEFAULT_PROFILES.rgb }
const fresh = () => createDoc(OPTS, 'root')
const children = (d: Doc, id = d.root) => d.nodes[id].children ?? []

/** A doc with groups a, b, c at the top (c on top) and d inside b. */
function sample(): Doc {
  let d = fresh()
  d = addGroup(d, 'a', 'A', 'root', 0)
  d = addGroup(d, 'b', 'B', 'root', 1)
  d = addGroup(d, 'c', 'C', 'root', 2)
  d = addGroup(d, 'd', 'D', 'b', 0)
  return d
}

// --- the registry -------------------------------------------------------------
console.log('\nnode kinds')
for (const kind of NODE_KINDS) {
  const def = NODE_DEFS[kind]
  const n = makeNode(kind, 'x')
  check(`${kind}: a new node has its def’s defaults`, JSON.stringify(n.props) === JSON.stringify(def.defaults()))
  check(`${kind}: its defaults read back as themselves, with no warnings`, (() => {
    const w: string[] = []
    return JSON.stringify(def.readProps(def.defaults(), (m) => w.push(m))) === JSON.stringify(def.defaults()) && w.length === 0
  })())
  check(`${kind}: garbage props read as the defaults`, JSON.stringify(def.readProps('nonsense', () => {})) === JSON.stringify(def.defaults()))
  check(`${kind}: containers have children and others don’t`, def.container === Array.isArray(n.children))
}
check('a new group passes through; every other kind blends normally', NODE_KINDS.every((k) => makeNode(k, 'x').blend === (k === 'group' ? 'pass-through' : 'normal')))
check('compound shapes only take shapes', NODE_DEFS.boolean.accepts!('vector') && !NODE_DEFS.boolean.accepts!('pixel'))

// --- creating -------------------------------------------------------------------
console.log('\ncreating')
const d0 = fresh()
check('a new document has its size, resolution, mode and depth', d0.width === 2000 && d0.height === 1000 && d0.resolution === 300 && d0.mode === 'rgb' && d0.depth === 16)
check('and an empty root group', d0.nodes.root.kind === 'group' && children(d0).length === 0)
const huge = createDoc({ ...OPTS, width: 1e9, height: -4, resolution: 0, name: '   ' }, 'root')
check('sizes are clamped to 1..300,000 and a blank name becomes Untitled', huge.width === MAX_SIDE && huge.height === 1 && huge.resolution === 1 && huge.name === 'Untitled')

// --- edits --------------------------------------------------------------------------
console.log('\nedits')
const s = sample()
check('groups go in at the index given, bottom first', children(s).join() === 'a,b,c' && children(s, 'b').join() === 'd')
check('the layers panel lists them top first, nested', layerRows(s).map((r) => `${r.node.id}${r.depth}`).join() === 'c0,b0,d1,a0')
check('a folded group hides its children in the list', layerRows(s, new Set(['b'])).map((r) => r.node.id).join() === 'c,b,a')
check('an id already used is refused', insertNode(s, makeNode('group', 'a'), 'root', 0) === s)
check('a mask can’t go among layers', insertNode(s, makeNode('mask', 'm'), 'root', 0) === s)
check('a pixel layer can’t go in a compound shape', insertNode(insertNode(s, makeNode('boolean', 'bo'), 'root', 0), makeNode('pixel', 'p'), 'bo', 0).nodes.p === undefined)

const removed = removeNode(s, 'b')
check('removing a group removes everything in it', !removed.nodes.b && !removed.nodes.d && children(removed).join() === 'a,c')
check('the root can’t be removed', removeNode(s, 'root') === s)
check('removing what isn’t there changes nothing', removeNode(s, 'nope') === s)
check('an edit leaves the document it was given alone', children(s).join() === 'a,b,c' && !!s.nodes.d)

const moved = moveNode(s, 'a', 'root', 2)
check('a layer moves to the top', children(moved).join() === 'b,c,a')
check('a move to where it already is changes nothing', moveNode(s, 'c', 'root', 2) === s)
check('a group can’t move into itself', moveNode(s, 'b', 'b', 0) === s)
check('or into its own child', moveNode(s, 'b', 'd', 0) === s)
const into = moveNode(s, 'c', 'd', 0)
check('a layer can move into another group', children(into).join() === 'a,b' && children(into, 'd').join() === 'c' && placeOf(into, 'c')?.parent === 'd')
check('shift up moves one step towards the top', children(shiftNode(s, 'a', 1)).join() === 'b,a,c')
check('shift at the top stays put', shiftNode(s, 'c', 1) === s)
check('shift at the bottom stays put', shiftNode(s, 'a', -1) === s)

check('renaming trims, and a blank name is refused', renameNode(s, 'a', '  Sky ').nodes.a.name === 'Sky' && renameNode(s, 'a', '  ') === s)
check('renaming to the same name changes nothing', renameNode(s, 'a', 'A') === s)
check('hiding hides; hiding again changes nothing', !setVisible(s, 'a', false).nodes.a.visible && setVisible(s, 'a', true) === s)
check('opacity is clamped to 0..1', setOpacity(s, 'a', 3).nodes.a.opacity === 1 && setOpacity(s, 'a', -1).nodes.a.opacity === 0)
const p = insertNode(s, makeNode('pixel', 'p'), 'root', 0)
check('pass-through is refused on a pixel layer', setBlend(p, 'p', 'pass-through') === p)
check('a blend mode is set', setBlend(p, 'p', 'multiply').nodes.p.blend === 'multiply')
check('a lock is set, and setting it again changes nothing', (() => {
  const l = setLocked(s, 'a', { all: true })
  return l.nodes.a.locked.all && setLocked(l, 'a', { all: true }) === l
})())
check('an unchanged edit shares the untouched nodes', setVisible(s, 'a', false).nodes.b === s.nodes.b)
check('subtree lists a group and everything under it', subtree(s, 'b').join() === 'b,d')
check('fresh names count up past the ones in use', freshName(addGroup(s, 'e', 'Group 1', 'root', 0), 'Group') === 'Group 2')

// --- the canvas -----------------------------------------------------------------------
console.log('\nthe canvas')
const big = resizeCanvas(s, 3000, 1000, { x: 0.5, y: 0.5 })
check('Canvas Size changes the size', big.width === 3000 && big.height === 1000)
check('anchored in the middle, top-level layers move by half the growth', children(big).every((id) => big.nodes[id].transform[4] === 500 && big.nodes[id].transform[5] === 0))
// Every transform is in document pixels (ARCHITECTURE.md), nested ones too.
check('nested layers move the same, since their transforms are in document pixels too', big.nodes.d.transform[4] === 500)
const tl = resizeCanvas(s, 3000, 1500, { x: 0, y: 0 })
check('anchored top left, nothing moves', children(tl).every((id) => tl.nodes[id].transform[4] === 0 && tl.nodes[id].transform[5] === 0))
const back = resizeCanvas(big, 2000, 1000, { x: 0.5, y: 0.5 })
check('growing and shrinking around the same anchor puts layers back', children(back).every((id) => back.nodes[id].transform[4] === 0))
check('the same size changes nothing', resizeCanvas(s, 2000, 1000, { x: 1, y: 1 }) === s)
check('resolution is metadata: the pixel size stays', setResolution(s, 72).width === 2000 && setResolution(s, 72).resolution === 72)
check('renaming the document trims, and refuses a blank name', renameDoc(s, ' Flyer ').name === 'Flyer' && renameDoc(s, '') === s)

const name = (a: Doc, b: Doc) => describeEdit(a, b)

console.log('\nmoving, transforming and cropping')
{
  // A pixel layer p inside group b, with a mask, and q clipped to p.
  let t = insertNode(s, makeNode('pixel', 'p', 'P'), 'b', 0)
  t = addMask(t, 'p', 'pm', null, 1)
  t = insertNode(t, makeNode('pixel', 'q', 'Q'), 'p', 0)
  const moved = moveBy(t, 'b', 10, -5)
  check('moving a group carries everything inside it, masks too', ['b', 'd', 'p', 'pm', 'q'].every((id) => moved.nodes[id].transform[4] === 10 && moved.nodes[id].transform[5] === -5))
  check('and nothing outside it', moved.nodes.a.transform[4] === 0 && moved.nodes.c.transform[4] === 0)
  const lone = moveBy(t, 'p', 3, 4)
  check('moving a layer carries its mask', lone.nodes.pm.transform[4] === 3 && lone.nodes.p.transform[5] === 4)
  check('but not layers clipped to it', lone.nodes.q.transform[4] === 0 && !carried(t, 'p').has('q'))
  check('a move of nothing is no edit', moveBy(t, 'p', 0, 0) === t && moveBy(t, 'root', 5, 5) === t)
  const turn: [number, number, number, number, number, number] = [0, 1, -1, 0, 100, 0]
  const turned = transformNode(lone, 'p', turn)
  check('a transform composes onto the one there', JSON.stringify(turned.nodes.p.transform) === JSON.stringify(compose(turn, lone.nodes.p.transform)))
  const undone = compose(invertAffine(turn), turn)
  check('an affine and its inverse cancel', undone.every((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) < 1e-12))
  check('names a transform', name(lone, turned) === 'Transform' || name(lone, turned) === 'Move Layers', name(lone, turned))

  const sel = setSelection(t, 'sel-1')
  const cropped = crop(sel, { x: 100, y: 50, width: 800, height: 600, angle: 0 })
  check('cropping makes the canvas the rectangle', cropped.width === 800 && cropped.height === 600)
  check('and moves every layer by its corner, keeping their pixels', cropped.nodes.p.transform[4] === -100 && cropped.nodes.d.transform[5] === -50)
  check('and drops the selection', cropped.selection === null)
  const straight = crop(t, { x: 0, y: 0, width: 500, height: 500, angle: 90 })
  const pt = straight.nodes.p.transform
  check('straightening turns the layers the other way', Math.abs(pt[0]) < 1e-12 && Math.abs(pt[1] + 1) < 1e-12)
}

console.log('\nselections, masks and clipping')
{
  const a = setSelection(s, 'sel-1')
  check('a selection is a tile set', a.selection?.tiles === 'sel-1')
  check('setting the same selection is no edit', setSelection(a, 'sel-1') === a && setSelection(s, null) === s)
  check('the selection’s tiles are kept with the document’s', tileSetsOf(a).includes('sel-1'))
  check('names: Select, Modify Selection, Deselect', name(s, a) === 'Select' && name(a, setSelection(a, 'sel-2')) === 'Modify Selection' && name(a, setSelection(a, null)) === 'Deselect')
  const round = readDocJson(docToJson(a))
  check('the selection saves and loads', round.ok && round.doc.selection?.tiles === 'sel-1')

  let m = insertNode(s, makeNode('pixel', 'p', 'P'), 'root', 0)
  const withMask = addMask(m, 'p', 'pm', 'mask-1', 0)
  check('a mask goes on a layer', withMask.nodes.p.masks.includes('pm') && withMask.nodes.pm.kind === 'mask')
  check('starting hidden or revealed', withMask.nodes.pm.kind === 'mask' && withMask.nodes.pm.props.outside === 0)
  check('names Add Layer Mask', name(m, withMask) === 'Add Layer Mask')
  check('a mask can’t go on a mask, or on the root', addMask(withMask, 'pm', 'x', null, 1) === withMask && addMask(m, 'root', 'x', null, 1) === m)
  check('its tiles are kept with the document’s', tileSetsOf(withMask).includes('mask-1'))
  const inv = setMaskProps(withMask, 'pm', { invert: true })
  check('inverting a mask', inv.nodes.pm.kind === 'mask' && inv.nodes.pm.props.invert && name(withMask, inv) === 'Invert Mask')
  check('changing nothing is no edit', setMaskProps(withMask, 'pm', { invert: false }) === withMask)
  check('deleting a mask names it', name(withMask, removeNode(withMask, 'pm')) === 'Delete Layer Mask', name(withMask, removeNode(withMask, 'pm')))
  check('deleting a layer with a mask names the layer', name(withMask, removeNode(withMask, 'p')) === 'Delete “P”', name(withMask, removeNode(withMask, 'p')))

  m = insertNode(m, makeNode('pixel', 'q', 'Q'), 'root', 1)
  const clipped = clipToBelow(m, 'q')
  check('Create Clipping Mask puts the layer inside the one below', children(clipped, 'p').includes('q') && !children(clipped).includes('q'))
  check('not onto a group, which clips nothing', clipToBelow(s, 'b') === s)
  const released = releaseClip(clipped, 'q')
  check('Release puts it back just above', children(released).indexOf('q') === children(released).indexOf('p') + 1)
  check('releasing a layer that isn’t clipped is no edit', releaseClip(s, 'd') === s)
}

console.log('\nadjustments, filters, effects and smart objects')
{
  let d = addAdjustment(s, 'adj', 'Curves 1', 'curves', {}, 'root', 1)
  check('an adjustment goes among the layers', children(d).includes('adj') && d.nodes.adj.kind === 'adjustment')
  check('names New Adjustment', name(s, d) === 'New Adjustment')
  d = insertNode(d, makeNode('pixel', 'p', 'P'), 'root', 0)
  const withFilter = addEffect(d, 'p', makeNode('filter', 'f1', 'Gaussian Blur', { filter: 'gaussian', params: { radius: 4 } }))
  check('a live filter goes in a layer’s effects', withFilter.nodes.p.effects.includes('f1'))
  check('and among the layers too, as a filter layer', insertNode(d, makeNode('filter', 'f2'), 'root', 0).nodes.root.children?.includes('f2') === true)
  const both = addEffect(withFilter, 'p', makeNode('adjustment', 'a2', 'Invert', { adjustment: 'invert' }))
  check('an adjustment can be one of a layer’s effects too', both.nodes.p.effects.join() === 'f1,a2')
  check('effects reorder', moveEffect(both, 'a2', 0).nodes.p.effects.join() === 'a2,f1')
  check('an effect can’t go on an adjustment layer', addEffect(both, 'adj', makeNode('filter', 'f3')) === both)
  const tuned = setParams(withFilter, 'f1', { radius: 9 })
  check('a filter’s settings change, and the step names it', tuned.nodes.f1.kind === 'filter' && tuned.nodes.f1.props.params.radius === 9 && name(withFilter, tuned) === 'Edit “Gaussian Blur”')
  check('the same settings are no edit', setParams(tuned, 'f1', { radius: 9 }) === tuned)
  const styled = setFx(d, 'p', [{ kind: 'drop-shadow', enabled: true, params: { distance: 8 } }])
  check('layer effects are set together, as Layer Style', styled.nodes.p.fx.length === 1 && name(d, styled) === 'Layer Style')
  const round = readDocJson(docToJson(both.nodes.p && setFx(both, 'p', [{ kind: 'stroke', enabled: false, params: { size: 4 } }, { kind: 'from-the-future', enabled: true, params: {} }])))
  check('effects, filters and layer effects save and load', round.ok && round.doc.nodes.p.effects.join() === 'f1,a2' && round.doc.nodes.p.fx.length === 2 && round.doc.nodes.p.fx[0].enabled === false)
  const bad = readDocJson(JSON.stringify({ format: DOC_FORMAT, app: DOC_APP, doc: { ...JSON.parse(docToJson(d)).doc, nodes: { ...JSON.parse(docToJson(d)).doc.nodes, p: { ...JSON.parse(docToJson(d)).doc.nodes.p, fx: 'shiny' } } } }))
  check('a layer’s effects that aren’t a list are dropped, and said so', bad.ok && bad.doc.nodes.p.fx.length === 0 && bad.warnings.some((w) => /effects/.test(w)))

  let px = setTiles(d, 'p', 'tiles-p')
  px = insertNode(px, makeNode('pixel', 'q', 'Q', { tiles: 'tiles-q' }), 'root', 1)
  const smart = convertToSmartObject(px, ['p', 'q'], 'so', 'so-root', 'Smart', { x: 10, y: 20, width: 300, height: 200 })
  const so = smart.nodes.so
  check('Convert to Smart Object takes the layers out and puts one in their place', !smart.nodes.p && !smart.nodes.q && children(smart).includes('so') && so.kind === 'embedded')
  check('their contents are a document of their own, moved to its corner', so.kind === 'embedded' && so.props.content!.width === 300 && so.props.content!.nodes.p.transform[4] === -10 && so.transform[4] === 10)
  check('in the same order', so.kind === 'embedded' && so.props.content!.nodes['so-root'].children!.join() === 'p,q')
  check('and their tiles are still the document’s', tileSetsOf(smart).includes('tiles-p') && tileSetsOf(smart).includes('tiles-q'))
  const back = readDocJson(docToJson(smart))
  check('a smart object saves and loads, contents and all', back.ok && back.doc.nodes.so.kind === 'embedded' && back.doc.nodes.so.props.content?.nodes.q.kind === 'pixel', back.ok ? back.warnings.join(' | ') : back.error)
  check('lost tiles inside a smart object are cleared too', (() => {
    const x = dropLostSets(smart, new Set(['tiles-q']))
    return x.nodes.so.kind === 'embedded' && x.nodes.so.props.content!.nodes.q.kind === 'pixel' && (x.nodes.so.props.content!.nodes.q as { props: { tiles: string | null } }).props.tiles === null
  })())
  const edited = setSmartContent(smart, 'so', { ...(so as { props: { content: Doc } }).props.content, width: 400 })
  check('editing the contents is one step', name(smart, edited) === 'Edit Contents')
  check('layers from different groups can’t be converted together', convertToSmartObject(sample(), ['a', 'd'], 'x', 'xr', 'X', { x: 0, y: 0, width: 1, height: 1 }) === sample() || !convertToSmartObject(sample(), ['a', 'd'], 'x', 'xr', 'X', { x: 0, y: 0, width: 1, height: 1 }).nodes.x)
}

// --- history ------------------------------------------------------------------------------
console.log('\nhistory')
let h = initHistory(fresh())
check('a new history has nothing to undo', !canUndo(h) && !canRedo(h) && undoLabel(h) === null)
const d1 = addGroup(h.present, 'g1', 'G1', 'root', 0)
h = commit(h, d1, false, describeEdit(h.present, d1))
check('a commit can be undone, and is named', canUndo(h) && undoLabel(h) === 'New Group', String(undoLabel(h)))
check('committing the same state adds no step', commit(h, h.present) === h)
const d2 = setOpacity(h.present, 'g1', 0.5)
h = commit(h, d2, false, describeEdit(h.present, d2))
const d3 = setOpacity(h.present, 'g1', 0.4)
h = commit(h, d3, true)
check('a coalesced commit folds into the step it joins', steps(h).labels.join() === 'Open,New Group,Opacity', steps(h).labels.join())
h = undo(h)
check('undo goes back one step', h.present === d1 && redoLabel(h) === 'Opacity')
h = redo(h)
check('redo brings it back', h.present === d3)
h = jumpTo(h, 0)
check('jumping to the start undoes everything', h.present.nodes.g1 === undefined && steps(h).current === 0)
h = jumpTo(h, 2)
check('and jumping forward redoes it', h.present === d3)
h = undo(h)
const d4 = renameDoc(h.present, 'Other')
h = commit(h, d4, false, describeEdit(h.present, d4))
check('a new edit after an undo drops the steps ahead', !canRedo(h) && steps(h).labels.join() === 'Open,New Group,Rename Document')
let long = initHistory(0)
for (let i = 1; i <= HISTORY_LIMIT + 10; i++) long = commit(long, i, false, `step ${i}`)
check(`history keeps the last ${HISTORY_LIMIT} steps`, long.past.length === HISTORY_LIMIT && long.past[0] === 10 && long.labels[0] === 'step 10')

// --- names for steps ------------------------------------------------------------------------
console.log('\nstep names')
check('a new group', name(s, addGroup(s, 'z', 'Z', 'root', 0)) === 'New Group')
check('deleting a group names it', name(s, removeNode(s, 'b')) === 'Delete “B”', name(s, removeNode(s, 'b')))
check('moving', name(s, moveNode(s, 'a', 'root', 2)) === 'Move Layer')
check('moving into another group', name(s, moveNode(s, 'c', 'd', 0)) === 'Move Layer')
check('renaming a layer', name(s, renameNode(s, 'a', 'Sky')) === 'Rename Layer')
check('hiding names the layer', name(s, setVisible(s, 'a', false)) === 'Hide “A”')
check('opacity', name(s, setOpacity(s, 'a', 0.3)) === 'Opacity')
check('canvas size', name(s, resizeCanvas(s, 10, 10, { x: 0.5, y: 0.5 })) === 'Canvas Size', name(s, resizeCanvas(s, 10, 10, { x: 0.5, y: 0.5 })))
check('resolution', name(s, setResolution(s, 96)) === 'Resolution')
check('renaming the document', name(s, renameDoc(s, 'X')) === 'Rename Document')

// --- saving and loading ------------------------------------------------------------------------
console.log('\nsaving and loading')
const rich = setBlend(setLocked(setOpacity(insertNode(s, makeNode('pixel', 'p', 'Paint', { resample: 'lanczos' }), 'd', 0), 'p', 0.25), 'p', { pixels: true }), 'p', 'screen')
const round = readDocJson(docToJson(rich))
check('a document survives the round trip exactly', round.ok && JSON.stringify(round.doc) === JSON.stringify(rich))
check('with no warnings', round.ok && round.warnings.length === 0, round.ok ? round.warnings.join('; ') : '')

const wrap = (doc: unknown, format = DOC_FORMAT) => JSON.stringify({ format, app: DOC_APP, doc })
const refused = (r: ReturnType<typeof readDocJson>, pattern: RegExp) => !r.ok && pattern.test(r.error)
check('a newer format is refused, saying so', refused(readDocJson(wrap({}, DOC_FORMAT + 1)), /newer version/), JSON.stringify(readDocJson(wrap({}, DOC_FORMAT + 1))))
check('broken JSON is refused', refused(readDocJson('{"format":1,'), /not valid JSON/))
check('other JSON is refused', refused(readDocJson('{"hello":1}'), /not a Plexel document/))
{
  const old = readDocJson(docToJson(rich).replace(`"app":"${DOC_APP}"`, '"app":"pixlayer"'))
  check('a document saved before the rename (by “Pixlayer”) still opens', old.ok && JSON.stringify(old.doc) === JSON.stringify(rich))
}
check('a missing format is refused', refused(readDocJson(JSON.stringify({ app: DOC_APP, doc: {} })), /format/))

const repaired = (body: Record<string, unknown>) => {
  const r = readDocJson(wrap(body))
  if (!r.ok) throw new Error(r.error)
  return r
}
const empty = repaired({})
check('an empty body gives a usable document', empty.doc.width === 1920 && empty.doc.nodes[empty.doc.root].kind === 'group')
check('with a warning that the root was made', empty.warnings.some((w) => /top-level/.test(w)), empty.warnings.join('; '))

const base = JSON.parse(docToJson(s)).doc
const hostile = repaired({
  ...base,
  width: 'wide',
  height: 4e9,
  mode: 'hsv',
  depth: 12,
  nodes: {
    ...base.nodes,
    // b holds itself and a missing node, d is also listed under c, and c
    // holds a mask among its layers.
    b: { ...base.nodes.b, children: ['d', 'b', 'ghost'] },
    c: { ...base.nodes.c, children: ['d', 'm'] },
    m: { ...makeNode('mask', 'm') },
    lost: { ...makeNode('group', 'lost', 'Lost') },
    weird: { kind: 'hologram', name: 'From the future' },
    bad: 'not a node',
  },
})
const hd = hostile.doc
check('a bad width falls back and an enormous height is clamped', hd.width === 1920 && hd.height === MAX_SIDE)
check('an unknown colour mode and depth fall back', hd.mode === 'rgb' && hd.depth === 8)
check('a node holding itself loses that reference', !(hd.nodes.b.children ?? []).includes('b'))
check('a missing child is removed', !(hd.nodes.b.children ?? []).includes('ghost'))
const parentsOfD = Object.values(hd.nodes).filter((n) => n.children?.includes('d')).map((n) => n.id)
check('a node listed in two places is kept in one', parentsOfD.length === 1, parentsOfD.join())
check('a mask among layers is taken out', !(hd.nodes.c.children ?? []).includes('m'))
check('an orphaned layer is put back at the top, not lost', (hd.nodes[hd.root].children ?? []).includes('lost'))
check('an orphaned mask is dropped', !hd.nodes.m)
check('an unknown kind is dropped', !hd.nodes.weird && !hd.nodes.bad)
check('every repair is reported', hostile.warnings.length >= 7, `${hostile.warnings.length}: ${hostile.warnings.join(' | ')}`)
check('and the repaired document reads back with no further repairs', (() => {
  const again = readDocJson(docToJson(hd))
  return again.ok && again.warnings.length === 0
})())

const blendy = repaired({ ...base, nodes: { ...base.nodes, a: { ...base.nodes.a, kind: 'pixel', blend: 'pass-through', children: [] } } })
check('pass-through on a non-group becomes normal', blendy.doc.nodes.a.blend === 'normal' && blendy.warnings.some((w) => /pass-through/.test(w)))

const cyclic = repaired({ ...base, nodes: { ...base.nodes, b: { ...base.nodes.b, children: ['d'] }, d: { ...base.nodes.d, children: ['b'] } } })
check('a cycle between two groups is broken', !(cyclic.doc.nodes.d.children ?? []).includes('b'))

// --- fragments: what the clipboard holds -----------------------------------------------
console.log('\nfragments')
{
  let src = sample()
  // b (holding d) gets a mask and an adjustment effect; a compound shape of two shapes on top.
  src = addMask(src, 'b', 'bm', 'maskset', 1)
  src = addEffect(src, 'b', makeNode('adjustment', 'be', 'Levels', { adjustment: 'levels', params: {} }))
  src = insertNode(src, makeNode('pixel', 'px', 'Pixels', { tiles: 'pxset' }), 'd', 0)
  const comp = makeNode('boolean', 'cp', 'Compound', { ops: { s2: 'subtract' } })
  src = insertNode(src, comp, 'root', 3)
  src = insertNode(src, makeNode('vector', 's1', 'One', { appearance: [{ kind: 'fill', enabled: true, opacity: 1, blend: 'normal', paint: { kind: 'solid', colour: [1, 0, 0], swatch: 'sw1' } }] }), 'cp', 0)
  src = insertNode(src, makeNode('vector', 's2', 'Two'), 'cp', 1)
  src = {
    ...src,
    swatches: [
      { id: 'sw1', name: 'Red', kind: 'global', colour: { space: 'rgb', profile: { builtin: 'srgb' }, c: [1, 0, 0] } },
      { id: 'sw2', name: 'Unused', kind: 'spot', colour: { space: 'rgb', profile: { builtin: 'srgb' }, c: [0, 0, 1] } },
    ],
    textStyles: { character: [{ id: 'cs', name: 'Em', basedOn: null, char: {} }], paragraph: [] },
  }
  src = setSelection(src, 'selset')

  const frag = fragmentOf(src, ['cp', 'd', 'b', 'nope'], 'fr')
  check('a fragment holds the chosen layers in painting order, a layer inside a chosen one not twice', fragmentLayers(frag).join() === 'b,cp', fragmentLayers(frag).join())
  check('with everything they hold: children, masks, effects, a compound’s shapes', ['b', 'd', 'px', 'bm', 'be', 'cp', 's1', 's2'].every((id) => !!frag.nodes[id]) && !frag.nodes.a && !frag.nodes.c)
  check('it keeps the source’s mode, depth and profile, and no selection', frag.mode === src.mode && frag.depth === src.depth && frag.selection === null && frag.root === 'fr')
  check('only the swatches its paints link to come along, and the text styles', frag.swatches?.map((x) => x.id).join() === 'sw1' && frag.textStyles?.character.length === 1)
  check('its tile sets are found as a document’s are', tileSetsOf(frag).sort().join() === 'maskset,pxset')

  let k = 0
  const ids = (p: string) => `${p}${++k}`
  let target = createDoc({ ...OPTS, name: 'Other' }, 'root2')
  target = addGroup(target, 'g', 'G', 'root2', 0)
  target = addGroup(target, 'h', 'H', 'root2', 1)
  const once = pasteFragment(target, frag, { parent: 'root2', index: 1, offset: [10, -5], newId: ids })
  const pd = once.doc
  check('pasting gives every node a new id', once.ids.length === 2 && Object.keys(pd.nodes).filter((id) => !(id in target.nodes)).length === 8 && !pd.nodes.b && !pd.nodes.cp)
  check('the layers go in where asked, bottom first', (pd.nodes.root2.children ?? []).join() === ['g', ...once.ids, 'h'].join(), (pd.nodes.root2.children ?? []).join())
  const nb = pd.nodes[once.ids[0]]
  const ncp = pd.nodes[once.ids[1]] as DocNode & { kind: 'boolean' }
  check(
    'children, masks and effects point at the new ids',
    pd.nodes[nb.children![0]]?.name === 'D' && pd.nodes[nb.masks[0]]?.kind === 'mask' && pd.nodes[nb.effects[0]]?.kind === 'adjustment' && pd.nodes[pd.nodes[nb.children![0]].children![0]]?.name === 'Pixels',
  )
  const s2 = ncp.children!.find((id) => pd.nodes[id].name === 'Two')!
  check('a compound shape’s operations follow its shapes to their new ids', ncp.props.ops[s2] === 'subtract' && Object.keys(ncp.props.ops).length === 1)
  check('the offset moves the layers, what they hold, and their masks', nb.transform[4] === 10 && nb.transform[5] === -5 && pd.nodes[nb.masks[0]].transform[4] === 10 && pd.nodes[nb.children![0]].transform[4] === 10)
  check('the pixels and masks keep their tile sets', tileSetsOf(pd).sort().join() === 'maskset,pxset')
  check('the swatches and text styles it uses come along', pd.swatches?.map((x) => x.id).join() === 'sw1' && pd.textStyles?.character[0]?.id === 'cs')
  const twice = pasteFragment(pd, frag, { parent: 'root2', index: 0, newId: ids, rename: (n) => `${n} copy` })
  check('pasting again gives new ids again, and names as asked', twice.ids.every((id) => !(id in pd.nodes)) && twice.doc.nodes[twice.ids[0]].name === 'B copy')
  check('a swatch or style it already has isn’t added twice', twice.doc.swatches?.length === 1 && twice.doc.textStyles?.character.length === 1)
  check('the source is left as it was', fragmentLayers(frag).join() === 'b,cp' && !!src.nodes.b && src.nodes.cp.children!.length === 2)

  // Into a compound shape, a pixel layer can't go: it goes on top instead.
  const pix = pixelFragment(src, 'r', 'p', 'Layer', 'copied', [1, 0, 0, 1, 3, 4])
  check('a pixel fragment is one pixel layer, placed by its transform, in the source’s mode', fragmentLayers(pix).join() === 'p' && pix.nodes.p.kind === 'pixel' && pix.nodes.p.transform[4] === 3 && pix.mode === src.mode && !pix.swatches)
  const intoComp = pasteFragment(src, pix, { parent: 'cp', index: 0, newId: ids })
  check('where it can’t go, it goes on top of the document', intoComp.ids.length === 1 && (intoComp.doc.nodes.root.children ?? []).at(-1) === intoComp.ids[0])
  check('an empty fragment pastes nothing', pasteFragment(src, fragmentOf(src, [], 'e'), { parent: 'root', index: 0, newId: ids }).doc === src)
}

console.log('\npatterns, alpha channels and fill layers')
{
  let d = fresh()
  d = addPattern(d, { id: 'p1', name: 'Bricks', tiles: 'pat-set', width: 40, height: 30 })
  d = addChannel(d, { id: 'c1', name: 'Alpha 1', tiles: 'ch-set', transform: [1, 0, 0, 1, 0, 0] })
  const fill = makeNode('fill', 'f1', 'Gradient Fill', { paint: { kind: 'gradient', type: 'reflected', stops: [{ at: 0, colour: [1, 0, 0], alpha: 1 }, { at: 1, colour: [0, 0, 1], alpha: 0.5 }], angle: 30, scale: 100, reverse: false, line: [10, 20, 300, 40] } })
  d = insertNode(d, fill, 'root', 0)
  const pat = makeNode('vector', 'v1', 'Shape', { geometry: { kind: 'shape', shape: { type: 'ellipse', x: 0, y: 0, w: 50, h: 50 } }, appearance: [{ kind: 'fill', enabled: true, paint: { kind: 'pattern', pattern: 'p1', colour: [0, 0, 0], background: [1, 1, 1], backgroundAlpha: 1, size: 40, angle: 0 }, opacity: 1, blend: 'normal' }], graphicStyle: null })
  d = insertNode(d, pat, 'root', 1)
  check('a document’s tile sets include its patterns and channels', ['pat-set', 'ch-set'].every((s) => tileSetsOf(d).includes(s)))
  const back = readDocJson(docToJson(d))
  check(
    'patterns, channels and fill layers read back as written, with no warnings',
    back.ok && back.warnings.length === 0 && JSON.stringify(back.doc.patterns) === JSON.stringify(d.patterns) && JSON.stringify(back.doc.channels) === JSON.stringify(d.channels) && JSON.stringify(back.doc.nodes.f1) === JSON.stringify(d.nodes.f1),
    back.ok ? back.warnings.join('; ') : back.error,
  )
  const bad = readDocJson(JSON.stringify({ format: DOC_FORMAT, app: DOC_APP, doc: { ...JSON.parse(docToJson(d)).doc, patterns: [{ id: 'x' }, 7, { id: 'p9', tiles: 's', width: 99999, height: 3 }], channels: [{ id: 'c1' }, { id: 'c1' }] } }))
  check('damaged patterns and channels are left out or clamped, and said', bad.ok && bad.doc.patterns?.length === 1 && bad.doc.patterns[0].width === 1024 && bad.doc.channels?.length === 1 && bad.warnings.length > 0)
  const lost = dropLostSets(d, new Set(['pat-set', 'ch-set']))
  check('a lost pattern goes, a lost channel is kept empty', !lost.patterns?.length && lost.channels?.[0].tiles === null)
  const cropped = crop(d, { x: 30, y: 40, width: 100, height: 100, angle: 0 })
  check('Crop moves the alpha channels with the layers', JSON.stringify(cropped.channels?.[0].transform) === JSON.stringify([1, 0, 0, 1, -30, -40]))
  const grown = resizeCanvas(d, d.width + 100, d.height, { x: 1, y: 0 })
  check('and so does Canvas Size', grown.channels?.[0].transform[4] === 100)
  check('Save Selection into a channel replaces its pixels and puts it back in place', setChannelTiles(cropped, 'c1', 'new').channels?.[0].tiles === 'new' && setChannelTiles(cropped, 'c1', 'new').channels?.[0].transform[4] === 0)
  check('channels rename, move and go', renameChannel(d, 'c1', 'Hair').channels?.[0].name === 'Hair' && !removeChannel(d, 'c1').channels)
  check('patterns rename and go', renamePattern(d, 'p1', 'Tiles').patterns?.[0].name === 'Tiles' && !removePattern(d, 'p1').patterns)
  const frag = fragmentOf(d, ['v1'], 'fr')
  check('a fragment carries the patterns its layers paint with, and no channels', frag.patterns?.length === 1 && frag.patterns[0].id === 'p1' && !frag.channels)
  const into = pasteFragment(fresh(), frag, { parent: 'root', index: 0, newId: (p) => `${p}${Math.random()}` })
  check('and pasting brings them into a document without them', into.doc.patterns?.[0]?.id === 'p1')
  const shapes = fillsAsShapes(d)
  const s = shapes.nodes.f1
  check(
    'for other formats, a fill layer is a shape over the canvas with its paint',
    s.kind === 'vector' && s.props.geometry?.kind === 'shape' && s.props.geometry.shape.type === 'rect' && s.props.appearance[0].paint === (d.nodes.f1 as DocNode & { kind: 'fill' }).props.paint,
  )
  check('a fill layer may hold clipped layers, as any layer may', NODE_DEFS.fill.container && NODE_DEFS.group.accepts!('fill'))
}

// --- what's selected when the selected layer goes ---------------------------------------------
console.log('\nthe layer selected in place of one that goes')
{
  // root: [a, g: [g1, g2], c] in painting order; the panel shows c, g (g2, g1), a.
  let d = createDoc({ name: 'N', width: 10, height: 10, resolution: 72, mode: 'rgb', depth: 8, profile: DEFAULT_PROFILES.rgb }, 'root')
  d = insertNode(d, makeNode('pixel', 'a', 'a'), 'root', 0)
  d = insertNode(d, makeNode('group', 'g', 'g'), 'root', 1)
  d = insertNode(d, makeNode('pixel', 'g1', 'g1'), 'g', 0)
  d = insertNode(d, makeNode('pixel', 'g2', 'g2'), 'g', 1)
  d = insertNode(d, makeNode('pixel', 'c', 'c'), 'root', 2)
  const all = (gone: string[]) => (id: string) => !gone.includes(id) && id !== 'root'
  check('the layer below it', neighbourOf(d, 'c', all(['c'])) === 'g')
  check('the bottom one goes: the one above it', neighbourOf(d, 'a', all(['a'])) === 'g')
  check('in a group, its neighbour in the group', neighbourOf(d, 'g2', all(['g2'])) === 'g1' && neighbourOf(d, 'g1', all(['g1'])) === 'g2')
  check('the last in a group: the group', neighbourOf(d, 'g1', all(['g1', 'g2'])) === 'g')
  check('passing over others that went with it', neighbourOf(d, 'c', all(['c', 'g', 'g1', 'g2'])) === 'a')
  check('nothing left: nothing', neighbourOf(d, 'a', all(['a', 'g', 'g1', 'g2', 'c'])) === null)
}

console.log('\ntiled documents')
{
  const d0 = fresh()
  const tiled = setTiling(d0, 'both')
  check('a fresh document isn’t tiled, and has no field for it', d0.tiled === undefined && !('tiled' in d0))
  check('Tiled is a step named for it', tiled.tiled === 'both' && describeEdit(d0, tiled) === 'Tiled')
  check('setting what it already is changes nothing', setTiling(tiled, 'both') === tiled && setTiling(d0, 'off') === d0)
  check('off again leaves no field', !('tiled' in setTiling(tiled, 'off')))
  const rd = (text: string | unknown) => {
    const r = readDocJson(text)
    if (!r.ok) throw new Error(r.error)
    return r
  }
  const across = setTiling(d0, 'x')
  check('across only survives saving and reading', rd(docToJson(across)).doc.tiled === 'x' && rd(docToJson(across)).warnings.length === 0)
  check('a document saved before tiling reads as not tiled, quietly', rd(docToJson(d0)).doc.tiled === undefined && rd(docToJson(d0)).warnings.length === 0)
  const bad = rd(JSON.parse(docToJson({ ...d0, tiled: 'diagonal' as never })))
  check('a tiling this version doesn’t know reads as off, with a warning', bad.doc.tiled === undefined && bad.warnings.some((w) => /tiled/i.test(w)), bad.warnings.join('; '))
  const layered = insertNode(setTiling(fresh(), 'both'), makeNode('pixel', 'p', 'P', { tiles: 'tiles-p' }), 'root', 0)
  const smart = convertToSmartObject(layered, ['p'], 'so', 'so-root', 'Smart', { x: 0, y: 0, width: 100, height: 100 })
  const so = smart.nodes.so
  check('a smart object’s contents aren’t a tile of their own, though the document is', smart.tiled === 'both' && so?.kind === 'embedded' && !!so.props.content && so.props.content.tiled === undefined)
}

console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
