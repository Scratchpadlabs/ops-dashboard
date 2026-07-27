import { ref, computed } from 'vue'
import { EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth'
import { auth } from '../firebase/config'

const IDLE_LIMIT_MS = 30 * 60 * 1000

// Module-level (singleton) state, in-memory only: a reload or new tab always
// re-prompts, even inside the 30-minute window — idle tracking is about
// "still actively working in this open tab," not surviving a reload.
const lastActivityAt = ref(null)
const now = ref(Date.now())
setInterval(() => { now.value = Date.now() }, 10_000)

const isElevated = computed(() =>
  lastActivityAt.value !== null && (now.value - lastActivityAt.value) < IDLE_LIMIT_MS
)

export function useStepUpAuth() {
  function markActivity() {
    // Only refresh an already-elevated session — otherwise activity alone
    // (e.g. moving the mouse on the password gate) could resurrect an
    // expired session without re-checking the password.
    if (isElevated.value) lastActivityAt.value = Date.now()
  }

  async function reauthenticate(password) {
    const credential = EmailAuthProvider.credential(auth.currentUser.email, password)
    await reauthenticateWithCredential(auth.currentUser, credential)
    lastActivityAt.value = Date.now()
  }

  return { isElevated, markActivity, reauthenticate }
}
