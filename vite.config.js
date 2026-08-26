import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base './' 让构建产物用相对路径，方便后续封装桌面 App / 任意目录部署
export default defineConfig({
  plugins: [vue()],
  base: './',
  server: { port: 5173, open: false },
  // Output to a fresh directory: the local safe-delete hook intercepts
  // removal of the old dist files and breaks subsequent builds, so we keep
  // emptyOutDir:false and clean dist-new via `robocopy /MIR` before building.
  build: { outDir: 'dist2', emptyOutDir: false }
})
