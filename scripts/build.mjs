import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputPath = resolve(projectRoot, 'dist');

// Restrict recursive cleanup to this project's build output on every platform.
if (dirname(outputPath) !== projectRoot || basename(outputPath) !== 'dist') {
  throw new Error('Unexpected build output path.');
}

// Rolldown's native cleanup can abort on Windows. Node's cleanup also avoids
// carrying stale hashed assets into the service worker's precache manifest.
await rm(outputPath, { recursive: true, force: true });
await build({ root: projectRoot, build: { outDir: outputPath, emptyOutDir: false } });
