/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // GitHub Pages 子路径部署也能正确加载资源
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 180000,
  },
})
