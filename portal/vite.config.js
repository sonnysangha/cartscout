import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The brand (tokens, fonts, Scout, motion, confetti) lives in ../extension and is imported, never copied.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  server: { fs: { allow: [repoRoot] } },
});
