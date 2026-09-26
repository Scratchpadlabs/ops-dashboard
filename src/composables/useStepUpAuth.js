import { ref, computed } from 'vue'
import { EmailAuthProvider, reauthenticateWithCredential, onAuthStateChanged } from 'firebase/auth'
import { auth } from '../firebase/config'
import { STEP_UP_KEY, IDLE_LIMIT_MS, restoreStepUp, serializeStepUp } from '../utils/stepUpSession.js'

// Module-level (singleton) state. Persisted to sessionStorage for this tab
// only, so reloading a restricted page within 30 minutes of activity does
// not ask for the password again; a new tab, a closed browser, signing out
// or 30 idle minutes all do.
function readStored(uid) {
  try { return restoreStepUp(sessionStorage.getItem(STEP_UP_KEY), uid, Date.now()) } catch { return null }
}
function writeStored(uid, at) {
  try {
    if (uid && at) sessionStorage.setItem(STEP_UP_KEY, serializeStepUp(uid, at))
    else sessionStorage.removeItem(STEP_UP_KEY)
  } catch { /* storage unavailable (private mode) — in-memory only */ }
}

const lastActivityAt = ref(readStored(auth.currentUser?.uid))
const now = ref(Date.now())
setInterval(() => { now.value = Date.now() }, 10_000)

// A different account (or none) never inherits the window.
let knownUid = auth.currentUser?.uid || null
onAuthStateChanged(auth, (user) => {
  const uid = user?.uid || null
  if (uid === knownUid) return
  knownUid = uid
  lastActivityAt.value = readStored(uid)
  if (!uid) writeStored(null, null)
})

const isElevated = computed(() =>
  lastActivityAt.value !== null && (now.value - lastActivityAt.value) < IDLE_LIMIT_MS
)

let lastWritten = 0
function touch(at) {
  lastActivityAt.value = at
  // Mouse moves arrive constantly; the stored copy only needs to be fresh
  // to within a few seconds of a 30-minute window.
  if (at - lastWritten > 15_000) {
    lastWritten = at
    writeStored(auth.currentUser?.uid, at)
  }
}

export function useStepUpAuth() {
  function markActivity() {
    // Only refresh an already-elevated session — otherwise activity alone
    // (e.g. moving the mouse on the password gate) could resurrect an
    // expired session without re-checking the password.
    if (isElevated.value) touch(Date.now())
  }

  async function reauthenticate(password) {
    const credential = EmailAuthProvider.credential(auth.currentUser.email, password)
    await reauthenticateWithCredential(auth.currentUser, credential)
    lastWritten = 0
    touch(Date.now())
  }

  return { isElevated, markActivity, reauthenticate }
}

/** Forget the step-up window (sign-out). */
export function clearStepUp() {
  lastActivityAt.value = null
  writeStored(null, null)
}
