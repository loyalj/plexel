import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // The engine worker is a module worker. Unlike Fresyn's AudioWorklet, a
  // dedicated worker has a module loader in every browser that has WebGPU,
  // so it can share chunks with the page instead of inlining everything.
  worker: { format: 'es' },
  build: {
    // Every browser with WebGPU runs ES2022. Vite's default target is older,
    // and lowers class fields to defineProperty helpers in the engine's hot
    // code for nothing.
    target: 'es2022',
    // Nothing that lacks modulepreload can run this app anyway.
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // React on its own, so a release that only touches the app leaves
        // the largest file a returning browser has cached where it was.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
        },
      },
    },
  },
  server: {
    // Cross-origin isolation, for SharedArrayBuffer. public/_headers sets the
    // same pair on Cloudflare Pages.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
