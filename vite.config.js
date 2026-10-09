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

// Dev server twin of the firebase.json rewrite: /w/<id> → wrap.html.
const shareLinkPage = () => ({
  name: 'year-wrap-share-page',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (/^\/w\/[^/.]+\/?(\?.*)?$/.test(req.url || '')) req.url = '/wrap.html'
      next()
    })
  },
})

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [vue(), versionFile(), shareLinkPage()],
  // The Year-Wrap preview imports the video templates from video/, which has
  // its own node_modules in a dev checkout. One copy of React and Remotion,
  // or hooks and the Player's context break.
  resolve: { dedupe: ['react', 'react-dom', 'remotion'] },
  // Two pages: the dashboard, and wrap.html — the public page a parent opens
  // from a year-wrap share link (/w/<id>, see firebase.json). Separate entry,
  // so parents never download the dashboard.
  build: {
    rolldownOptions: {
      input: { main: 'index.html', wrap: 'wrap.html' },
    },
  },
  define: {
    __BUILD_ID__: JSON.stringify(command === 'build' ? BUILD_ID : 'dev'),
  },
}))
