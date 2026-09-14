import { defineConfig } from 'vite';

// GitHub Pages 部署用相对路径，保证子路径下资源可用
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    target: 'es2018',
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  },
  server: {
    port: 5173,
    open: false
  }
});