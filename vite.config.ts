import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Offline start (the app must open with no network at all — e.g. on a train
 * with the phone plugged in over a USB cable).
 *
 * The service worker itself lives in `public/sw.js` so it is served from the
 * site root. After Vite has written the bundle, this plugin injects the list of
 * this build's hashed files into `dist/sw.js` and gives the build an id: the SW
 * precaches every file of the build on install and names its cache after the
 * id, so an old build's cache is dropped instead of lingering.
 */
function offlinePrecache(): Plugin {
  let files: string[] = []
  return {
    name: 'tsunagu-offline-precache',
    apply: 'build',
    generateBundle(_options, bundle) {
      files = Object.keys(bundle)
        .filter((f) => f !== 'index.html' && !f.endsWith('.map'))
        .map((f) => '/' + f)
        .sort()
    },
    closeBundle() {
      const swPath = resolve(process.cwd(), 'dist/sw.js')
      if (!existsSync(swPath)) return
      const id = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 8)
      const precache = JSON.stringify(['/', '/index.html', '/manifest.webmanifest', ...files])
      const sw = readFileSync(swPath, 'utf8')
        .replace("const BUILD_ID = 'dev'", `const BUILD_ID = '${id}'`)
        .replace('const BUILD_ASSETS = []', `const BUILD_ASSETS = ${precache}`)
      writeFileSync(swPath, sw)
    },
  }
}

export default defineConfig({ plugins: [react(), offlinePrecache()] })
