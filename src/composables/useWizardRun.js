/**
 * Wizard run persistence — shared by the New School and Reset School wizards.
 *
 * A run lives in `setup_wizard_runs/<runId>`:
 *   {school_id, type: 'new'|'reset', current_step, steps: {key: {status,
 *    completed_at, summary}}, created_by, created_at, updated_at}
 *
 * Every step transition writes immediately, so closing the browser mid-way
 * loses nothing — reopening School Setup finds the in-progress run and offers
 * to continue from the step it stopped at. That is the whole point: these
 * wizards span imports and file wrangling that take a while, and losing
 * progress would push people back to doing it by hand.
 */
import { ref, computed } from 'vue'
import {
  doc, getDoc, getDocs, setDoc, query, where, orderBy, limit, serverTimestamp,
} from 'firebase/firestore'
import { db, auth } from '../firebase/config'
import { wizardRunsCollection, wizardRunDoc } from '../firebase/schoolCollections.js'

export const STATUS_PENDING = 'pending'
export const STATUS_DONE = 'done'
export const STATUS_SKIPPED = 'skipped'

const runDoc = wizardRunDoc

export function useWizardRun(type, steps) {
  const run = ref(null)
  const loading = ref(false)
  const saving = ref(false)

  const currentStep = computed(() => run.value?.current_step || steps[0].key)
  const stepStates = computed(() => run.value?.steps || {})
  const currentIndex = computed(() => Math.max(0, steps.findIndex(s => s.key === currentStep.value)))

  const doneCount = computed(() =>
    steps.filter(s => [STATUS_DONE, STATUS_SKIPPED].includes(stepStates.value[s.key]?.status)).length)
  const percent = computed(() => Math.round(doneCount.value / steps.length * 100))

  function statusOf(key) { return stepStates.value[key]?.status || STATUS_PENDING }
  function summaryOf(key) { return stepStates.value[key]?.summary || '' }

  /**
   * A step is reachable if it is done/skipped (go back and review), is the
   * current step, or is the FIRST pending step (go forward one). Jumping
   * ahead past unfinished work is what produces half-configured schools.
   */
  function isUnlocked(key) {
    const i = steps.findIndex(s => s.key === key)
    if (i <= currentIndex.value) return true
    for (let j = currentIndex.value; j < i; j++) {
      if (![STATUS_DONE, STATUS_SKIPPED].includes(statusOf(steps[j].key))) return false
    }
    return true
  }

  /** Any in-progress run of this type, so School Setup can offer "Continue". */
  async function findResumable(schoolId = null) {
    const clauses = [where('type', '==', type), where('status', '==', 'in_progress')]
    if (schoolId) clauses.push(where('school_id', '==', schoolId))
    try {
      const snap = await getDocs(query(
        wizardRunsCollection(), ...clauses, orderBy('updated_at', 'desc'), limit(5)))
      return snap.docs.map(d => ({ ...d.data(), id: d.id }))
    } catch (e) {
      // An ordering/index problem must not hide the resume affordance
      // entirely — fall back to an unordered read.
      console.error('Could not query wizard runs in order; retrying unordered', e)
      const snap = await getDocs(query(wizardRunsCollection(), ...clauses, limit(5)))
      return snap.docs.map(d => ({ ...d.data(), id: d.id }))
    }
  }

  async function start(schoolId = null) {
    const id = doc(wizardRunsCollection()).id
    const payload = {
      school_id: schoolId || null,
      type,
      status: 'in_progress',
      current_step: steps[0].key,
      steps: Object.fromEntries(steps.map(s => [s.key, { status: STATUS_PENDING }])),
      created_by: auth.currentUser?.email || 'unknown',
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    }
    await setDoc(runDoc(id), payload)
    run.value = { id, ...payload }
    return run.value
  }

  async function load(runId) {
    loading.value = true
    try {
      const snap = await getDoc(runDoc(runId))
      run.value = snap.exists() ? { ...snap.data(), id: snap.id } : null
      return run.value
    } finally {
      loading.value = false
    }
  }

  async function patch(fields) {
    if (!run.value) return
    saving.value = true
    try {
      await setDoc(runDoc(run.value.id), { ...fields, updated_at: serverTimestamp() }, { merge: true })
      run.value = { ...run.value, ...fields }
    } finally {
      saving.value = false
    }
  }

  /** Mark a step done (or skipped) with its one-line summary, then advance. */
  async function completeStep(key, summary = '', { skipped = false, advance = true } = {}) {
    const nextSteps = {
      ...stepStates.value,
      [key]: { status: skipped ? STATUS_SKIPPED : STATUS_DONE, summary, completed_at: new Date().toISOString() },
    }
    const i = steps.findIndex(s => s.key === key)
    const next = advance && i >= 0 && i + 1 < steps.length ? steps[i + 1].key : currentStep.value
    await patch({ steps: nextSteps, current_step: next })
    return next
  }

  async function goTo(key) {
    if (!isUnlocked(key)) return false
    await patch({ current_step: key })
    return true
  }

  async function setSchool(schoolId) { await patch({ school_id: schoolId }) }

  async function finish(summary = '') {
    await patch({ status: 'complete', finished_summary: summary, finished_at: serverTimestamp() })
  }

  async function abandon() { await patch({ status: 'abandoned' }) }

  return {
    run, loading, saving, steps,
    currentStep, currentIndex, stepStates, doneCount, percent,
    statusOf, summaryOf, isUnlocked,
    findResumable, start, load, patch, completeStep, goTo, setSchool, finish, abandon,
  }
}
