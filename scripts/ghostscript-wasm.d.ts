/** Ghostscript compiled to WebAssembly (dev only): check-interchange draws EPS files with it. */
declare module '@jspawn/ghostscript-wasm' {
  interface GhostscriptInstance {
    callMain(args: string[]): number
    FS: {
      writeFile(path: string, data: Uint8Array | string): void
      readFile(path: string): Uint8Array
      readdir(path: string): string[]
      mkdir(path: string): void
    }
  }
  export default function GhostscriptModule(options: {
    print?: (s: string) => void
    printErr?: (s: string) => void
    instantiateWasm?: (imports: WebAssembly.Imports, ok: (instance: WebAssembly.Instance) => void) => object
  }): Promise<GhostscriptInstance>
}
