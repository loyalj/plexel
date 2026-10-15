/**
 * What a file is, from its first bytes (and its name): kept apart from the
 * readers, so knowing a file is a PSD or an SVG doesn't load what opens it.
 */

/** A Photoshop file (PSD or PSB): 8BPS. */
export const isPsd = (head: Uint8Array) => head[0] === 0x38 && head[1] === 0x42 && head[2] === 0x50 && head[3] === 0x53

/** An SVG: by its name, or an svg element (after any XML declaration, comments and doctype) at its start. */
export const isSvg = (head: Uint8Array, name: string) => /\.svgz?$/i.test(name) || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg|<svg)/i.test(new TextDecoder().decode(head))
