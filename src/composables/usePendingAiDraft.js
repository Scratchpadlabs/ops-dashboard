// Hand-off point between the AI Assistant panel and whichever existing page
// owns a given proposalKind's create/edit form. The assistant never writes
// anything itself — it calls setPendingAiDraft(), navigates to the target
// page, and that page's own onMounted calls takePendingAiDraft() to pre-fill
// its EXISTING create/edit dialog state, exactly as if a human had typed it.
// The existing Save/Confirm button and its write call are never touched
// here — see AiAssistantPanel.vue's registry and each target view's own
// "AI draft" onMounted branch.
//
// sessionStorage (not the query string) so a large drafted proposal (e.g. a
// long columns list) doesn't have to round-trip through the URL.
const STORAGE_PREFIX = 'ops.aiDraft.'

export function setPendingAiDraft(proposalKind, proposal) {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + proposalKind, JSON.stringify(proposal))
  } catch (e) {
    console.error('Could not stage AI draft', e)
  }
}

// Reads AND clears — a draft is consumed once, so returning to the page
// later never silently re-applies a stale draft over manual edits.
export function takePendingAiDraft(proposalKind) {
  const key = STORAGE_PREFIX + proposalKind
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    sessionStorage.removeItem(key)
    return JSON.parse(raw)
  } catch (e) {
    console.error('Could not read staged AI draft', e)
    return null
  }
}
