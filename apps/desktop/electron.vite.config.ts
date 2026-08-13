import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = import.meta.dirname;

// `@alexandria/core` and its dependencies are bundled into the main process
// rather than externalised: the app then ships as plain JS with nothing to
// resolve at runtime. Only Electron itself and node builtins stay external —
// `node:sqlite` in particular must come from the Electron runtime.
// transformers.js and its ONNX runtime stay external: they load `.node`
// binaries and model files at runtime, which a bundler cannot inline.
const nodeExternals = [
  'electron',
  /^node:/,
  '@huggingface/transformers',
  'onnxruntime-node',
  'sharp',
];

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: nodeExternals,
        input: resolve(root, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external: nodeExternals,
        input: resolve(root, 'src/preload/index.ts'),
        // Emitted as CommonJS on purpose: Electron only treats a preload script
        // as ESM when it ends in `.mjs`, and this package is `type: module`, so
        // a plain `.js` bundle would be loaded as CJS and fail to parse.
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    build: {
      rollupOptions: {
        input: resolve(root, 'src/renderer/index.html'),
      },
    },
    plugins: [react(), tailwind()],
  },
});
