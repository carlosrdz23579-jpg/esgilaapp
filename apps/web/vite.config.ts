import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// @domain = lógica pura compartida (packages/domain/src): calendario, nómina, efectivo.
const domain = fileURLToPath(new URL('../../packages/domain/src', import.meta.url));
export default defineConfig({
  plugins: [react()],
  // Fecha de compilación (hora de México) para saber qué versión está abriendo cada quien.
  define: { __BUILD__: JSON.stringify(new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'short', timeStyle: 'short' })) },
  resolve: { alias: { '@domain': domain } },
  server: { fs: { allow: ['../..'] } },
});
