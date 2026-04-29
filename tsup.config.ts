import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: true,
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  target: 'node20',
})
