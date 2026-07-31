import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { builtinModules } from 'module';
import { config as loadDotenv } from 'dotenv';

// Node built-in modules must be external for Electron main process
const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);
// Keep the SDK's module boundary: bundling it makes Rollup's CJS namespace
// helper crash on inherited enumerable exports from the external `ws` package.
const googleGenAiExternals = ['@google/genai', /^@google\/genai\//];
const mcpExternals = [/^@modelcontextprotocol\/(?:client|core|server)(?:\/.*)?$/];
const ignoredWatchPaths = [
  '**/release/**',
  '**/dist/**',
  '**/dist-electron/**',
  '**/dist-wsl-agent/**',
  '**/dist-lima-agent/**',
  '**/dist-mcp/**',
];

export default defineConfig(({ command }) => {
  // Production builds load `.env.prod` so VITE_* / Hub URLs match prod.
  if (command === 'build') {
    const prodEnvPath = resolve(__dirname, '.env.prod');
    if (existsSync(prodEnvPath)) {
      loadDotenv({ path: prodEnvPath, override: true });
    }
  }

  return {
    plugins: [
      react(),
      electron([
        {
          entry: 'src/main/index.ts',
          onstart(args) {
            args.startup();
          },
          vite: {
            build: {
              outDir: 'dist-electron/main',
              // Prevent hashed chunk accumulation across rebuilds (otherwise
              // electron-builder packs multi-GB stale output into app.asar).
              emptyOutDir: true,
              rollupOptions: {
                external: [
                  ...nodeBuiltins,
                  ...googleGenAiExternals,
                  'better-sqlite3',
                  'bufferutil',
                  'utf-8-validate',
                  'electron',
                  // Externalize large CJS-compatible main-process dependencies
                  // NOTE: ESM-only packages (@mariozechner/pi-coding-agent, pi-ai, electron-store, uuid)
                  // must stay bundled — CJS require() can't load them
                  '@anthropic-ai/sdk',
                  '@larksuiteoapi/node-sdk',
                  'openai',
                  ...mcpExternals,
                  'electron-updater',
                  'chokidar',
                  'archiver',
                  'ngrok',
                  'ws',
                  'glob',
                  'dotenv',
                  '@slack/bolt',
                  '@slack/web-api',
                  'aws-jwt-verify',
                ],
                output: {
                  // Ensure consistent interop for CJS/ESM
                  interop: 'auto',
                  // Stable chunk/asset names (no content hash). emptyOutDir wipes
                  // dist on rebuild; hashed pi-ai provider chunks left a live
                  // Electron process requiring deleted filenames. Do not use
                  // inlineDynamicImports — that eagerly loads photon-node and
                  // crashes on missing photon_rs_bg.wasm at startup.
                  chunkFileNames: '[name].js',
                  assetFileNames: '[name][extname]',
                },
              },
            },
          },
        },
        {
          entry: 'src/preload/index.ts',
          onstart(args) {
            args.reload();
          },
          vite: {
            build: {
              outDir: 'dist-electron/preload',
              emptyOutDir: true,
              rollupOptions: {
                external: ['electron'],
              },
            },
          },
        },
      ]),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@main': resolve(__dirname, 'src/main'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    server: {
      port: 6767,
      strictPort: true,
      watch: {
        ignored: ignoredWatchPaths,
      },
      proxy: {
        '/vecos-oauth-relay': {
          target: 'http://127.0.0.1:19890',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/vecos-oauth-relay/, ''),
        },
      },
    },
    build: {
      sourcemap: process.env.NODE_ENV !== 'production',
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
