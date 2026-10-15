/**
 * How src/ may depend on itself (part of check:static, scripts/run-checks.mjs).
 *
 * - No import cycles that exist at run time: a cycle means modules that
 *   start up in an order nobody chose. Type-only imports aren't counted
 *   (tsPreCompilationDeps: false); they vanish when the code is built.
 * - The core runs anywhere (the checks run it in Node): the document, tiles,
 *   colour, geometry, text and lib/ never reach up into the app, the
 *   interface, the engine's hosts or the renderer (its CPU references,
 *   render/ref/, aside: they run in Node too).
 */
module.exports = {
  forbidden: [
    {
      name: 'no-runtime-cycles',
      severity: 'error',
      from: { path: '^src' },
      to: { circular: true },
    },
    {
      name: 'core-stays-core',
      comment: 'doc/, tiles/, color/, geom/, text/ and lib/ run in Node and in either thread: they mustn\'t import the app, the interface, the engine or the renderer.',
      severity: 'error',
      from: { path: '^src/(doc|tiles|color|geom|text|lib)/' },
      // render/ref/ is the CPU references, which run in Node with the core (ARCHITECTURE.md, Source layout).
      to: { path: '^src/(app|ui|engine|render|commands|tools)/', pathNot: '^src/render/ref/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: false,
    tsConfig: { fileName: 'tsconfig.json' },
    exclude: { path: '(^|/)wasm/' },
  },
}
