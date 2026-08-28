import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The demo builds tickwork from source so `npm run demo` needs no build step,
// and a single React copy is guaranteed by workspace hoisting + dedupe.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      tickwork: fileURLToPath(new URL('../packages/tickwork/src/index.ts', import.meta.url)),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: { port: 5173, host: true },
  build: { outDir: 'dist', sourcemap: true },
});
