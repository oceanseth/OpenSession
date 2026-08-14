import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The desktop app reuses the web app's parsing + GitHub client code verbatim
// via the @oslib alias so both surfaces render sessions identically.
const oslib = fileURLToPath(new URL('../app/src/lib', import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: './', // electron loads dist/index.html from file://
  resolve: {
    alias: { '@oslib': oslib },
  },
  server: {
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
});
