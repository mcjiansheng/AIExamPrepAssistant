import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 开发时 /api 转发到本机后端（server v1 默认 8765 端口）；后端没启动时前端自动改用演示后端。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8765', changeOrigin: false } },
  },
  preview: { host: '127.0.0.1', port: 4173 },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
