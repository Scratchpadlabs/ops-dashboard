import { ref, onMounted, onBeforeUnmount } from 'vue'

/**
 * Keep a page's data fresh without a manual reload: re-run its loader every
 * few minutes while the tab is visible, and when the tab regains focus after
 * being away. Loaders are called with { silent: true } so they can skip the
 * full-page spinner and error toasts — the data just updates in place.
 *
 * Never refreshes while a dialog is open or the user is typing, so an edit in
 * progress is not yanked out from under them.
 */
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000
export const DEFAULT_FOCUS_GAP_MS = 60 * 1000

/** Pure decision, exported for tests. */
export function shouldRefresh({ nowMs, lastMs, gapMs, visible, busy, blocked }) {
  if (!visible || busy || blocked) return false
  return nowMs - lastMs >= gapMs
}

function userIsBusy() {
  if (typeof document === 'undefined') return false
  // PrimeVue renders a mask behind every open modal Dialog / ConfirmDialog.
  if (document.querySelector('.p-dialog-mask')) return true
  const el = document.activeElement
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

export function useAutoRefresh(loadFn, { intervalMs = DEFAULT_INTERVAL_MS, focusGapMs = DEFAULT_FOCUS_GAP_MS, paused = () => false } = {}) {
  const lastRefreshedAt = ref(Date.now())
  let busy = false
  let timer = null

  async function refresh() {
    if (busy) return
    busy = true
    try {
      await loadFn({ silent: true })
    } catch (e) {
      console.warn('Auto-refresh failed', e)
    } finally {
      busy = false
      lastRefreshedAt.value = Date.now()
    }
  }

  function maybe(gapMs) {
    const ok = shouldRefresh({
      nowMs: Date.now(), lastMs: lastRefreshedAt.value, gapMs,
      visible: document.visibilityState === 'visible', busy, blocked: paused() || userIsBusy(),
    })
    if (ok) refresh()
  }

  const onFocus = () => maybe(focusGapMs)

  onMounted(() => {
    lastRefreshedAt.value = Date.now()
    // Check often, refresh rarely: a missed tick (dialog open) retries soon.
    timer = setInterval(() => maybe(intervalMs), 30_000)
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
  })
  onBeforeUnmount(() => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onFocus)
    window.removeEventListener('focus', onFocus)
  })

  return { lastRefreshedAt, refreshNow: refresh }
}
