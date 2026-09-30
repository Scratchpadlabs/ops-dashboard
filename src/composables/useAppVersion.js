import { ref } from 'vue'

/**
 * New-deploy detection. Every build stamps __BUILD_ID__ into the bundle and
 * writes the same id to /version.json (vite.config.js). An open tab polls
 * that file and, when it differs, offers a reload — so nobody keeps working
 * on a stale dashboard for days. Hosting serves everything no-cache, and the
 * query string defeats any intermediate cache on top.
 */
const CHECK_EVERY_MS = 5 * 60 * 1000
// eslint-disable-next-line no-undef
const CURRENT = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'

const updateAvailable = ref(false)
let started = false
let lastCheck = 0

async function check() {
  if (CURRENT === 'dev' || updateAvailable.value) return
  lastCheck = Date.now()
  try {
    const res = await fetch(`/version.json?ts=${lastCheck}`, { cache: 'no-store' })
    if (!res.ok) return
    const { buildId } = await res.json()
    if (buildId && buildId !== CURRENT) updateAvailable.value = true
  } catch { /* offline or mid-deploy — try again next time */ }
}

function onVisible() {
  if (document.visibilityState === 'visible' && Date.now() - lastCheck > 60_000) check()
}

export function useAppVersion() {
  if (!started) {
    started = true
    setInterval(() => { if (document.visibilityState === 'visible') check() }, CHECK_EVERY_MS)
    document.addEventListener('visibilitychange', onVisible)
    // A lazy chunk from the previous deploy is gone once a new one is live;
    // Vite reports that here — reloading picks up the new build.
    window.addEventListener('vite:preloadError', (e) => {
      e.preventDefault()
      window.location.reload()
    })
    check()
  }
  return { updateAvailable, reload: () => window.location.reload() }
}
