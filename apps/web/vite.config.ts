import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// @domain = lógica pura compartida (packages/domain/src): calendario, nómina, efectivo.
const domain = fileURLToPath(new URL('../../packages/domain/src', import.meta.url));
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@domain': domain } },
  server: { fs: { allow: ['../..'] } },
});
