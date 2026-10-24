/**
 * New layers' names: after their group inside one ("Home 4"), after their
 * kind elsewhere ("Pencil 4"), numbered on from the highest (doc/tree.ts'
 * nameIn), with the number written in three digits when Edit → Interface
 * says so ("Home 004"), so a long list sorts.
 */
import { nameIn } from '../doc/tree'
import type { Doc, NodeId } from '../doc/types'
import { interfacePrefs } from '../ui/interface'

export const layerName = (doc: Doc, parent: NodeId, base: string) => nameIn(doc, parent, base, interfacePrefs().get().padNumbers ? 3 : 0)
