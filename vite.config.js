import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// One id per build: baked into the bundle as __BUILD_ID__ and written to
// dist/version.json, so an open tab can tell a new deploy is live
// (src/composables/useAppVersion.js).
const BUILD_ID = new Date().toISOString()

const versionFile = () => ({
  name: 'ops-version-file',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId: BUILD_ID }) })
  },
})

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [vue(), versionFile()],
  define: {
    __BUILD_ID__: JSON.stringify(command === 'build' ? BUILD_ID : 'dev'),
  },
}))
