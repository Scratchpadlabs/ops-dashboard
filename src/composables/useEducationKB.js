/**
 * Education knowledge base — app-side orchestration.
 *
 * src/utils/educationKB.js holds the pure, deterministic knowledge (shared
 * seed with the import parser). This composable adds the three things that
 * need the app: the Firestore `kb_entries` overlay, the LLM fallback, and
 * the human-confirmation write that turns an answer into permanent knowledge.
 *
 * The escalation ladder, in order — never skip a rung:
 *   1. DETERMINISTIC  classify() against seed + learned overlay. Free, instant.
 *   2. LLM            only for `unknown`, once per value, via classify_value.
 *   3. HUMAN CONFIRM  the answer is shown as a SUGGESTION. Nothing is written
 *                     until a person accepts it.
 *   4. CACHE FOREVER  on accept, the value lands in kb_entries and rung 1
 *                     answers it from then on — including "other" answers,
 *                     which are cached precisely so the model is never asked
 *                     about that value again.
 */
import { ref, computed } from 'vue'
import { getDocs, setDoc, serverTimestamp } from 'firebase/firestore'
import { kbEntriesCollection, kbEntryDoc, importAliasesCollection } from '../firebase/schoolCollections.js'
import { auth } from '../firebase/config'
import { classifyValueRemote } from '../utils/api.js'
import {
  classify as classifyLocal, buildOverlay, canonicalize, band,
  SUBJECT, COSCHOLASTIC, GRADE, SECTION, UNKNOWN, OTHER,
} from '../utils/educationKB.js'

// Shared across every consumer — the overlay is small, global, and changes
// only when someone confirms a classification.
const entries = ref([])
const overlay = ref(new Map())
const loaded = ref(false)
let loadPromise = null

// In-flight//completed LLM answers this session, keyed by canonicalized value.
// Stops a table with 40 identical unknown cells firing 40 model calls.
const llmCache = new Map()

async function fetchEntries() {
  const snap = await getDocs(kbEntriesCollection())
  entries.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  overlay.value = buildOverlay(entries.value)
  loaded.value = true
}

export function useEducationKB() {
  function loadKB(force = false) {
    if (!loadPromise || force) {
      loadPromise = fetchEntries().catch(e => {
        // A missing/unreadable overlay must never break a screen — the
        // seeded KB alone still classifies the overwhelming majority.
        console.error('Could not load kb_entries; using seeded KB only', e)
        loaded.value = true
        loadPromise = null
      })
    }
    return loadPromise
  }

  /** Rung 1. Deterministic classification against seed + learned overlay. */
  function classify(value, expect = null) {
    return classifyLocal(value, { expect, overlay: overlay.value })
  }

  /**
   * Rung 2. Ask the model — ONLY for values rung 1 called unknown.
   *
   * Returns the same result shape as classify() with `source: 'llm'`, or a
   * `source: 'unavailable'` result when no model answered. Never writes.
   * Callers must render whatever comes back as a suggestion to confirm.
   */
  async function classifyWithLLM(value, { context = '' } = {}) {
    const canon = canonicalize(value)
    if (!canon) return classifyLocal(value)

    const local = classifyLocal(value, { overlay: overlay.value })
    if (local.type !== UNKNOWN) return local

    if (llmCache.has(canon)) return llmCache.get(canon)

    const promise = classifyValueRemote({ value, context })
      .then(r => ({
        type: r.type || UNKNOWN,
        canonical: r.canonical || null,
        confidence: r.confidence ?? 0,
        source: r.source || 'llm',
        reason: r.reason || '',
        alternatives: [],
      }))
      .catch(e => {
        console.error('classify_value failed', e)
        llmCache.delete(canon) // a transient failure must stay retryable
        return { type: UNKNOWN, canonical: null, confidence: 0, source: 'unavailable',
                 reason: e.message || 'Could not reach the classifier', alternatives: [] }
      })

    llmCache.set(canon, promise)
    return promise
  }

  /**
   * Rungs 3+4. A human accepted a classification — make it permanent.
   *
   * `type` may be OTHER: caching a "none of the above" is exactly as
   * valuable as a positive answer, because it is what stops this value being
   * sent to the model ever again.
   */
  async function confirmClassification(value, type, canonical, { source = 'human' } = {}) {
    const canon = canonicalize(value)
    if (!canon) throw new Error('Cannot learn an empty value')

    const payload = {
      value: canon,
      original: (value || '').trim(),
      type,
      canonical: type === OTHER ? '' : ((canonical || value) || '').trim(),
      learned_from: source,
      confirmed_by: auth.currentUser?.email || 'unknown',
      confirmed_at: serverTimestamp(),
    }
    await setDoc(kbEntryDoc(canon), payload, { merge: true })

    // Reflect it locally straight away so the next cell resolves without a
    // round trip, and drop any cached model answer for the same value.
    entries.value = [...entries.value.filter(e => e.id !== canon), { id: canon, ...payload }]
    overlay.value = buildOverlay(entries.value)
    llmCache.delete(canon)
    return payload
  }

  async function forgetClassification(canonValue) {
    const canon = canonicalize(canonValue)
    await setDoc(kbEntryDoc(canon), { value: canon, type: 'retired',
      retired_by: auth.currentUser?.email || 'unknown', retired_at: serverTimestamp() }, { merge: true })
    entries.value = entries.value.filter(e => e.id !== canon)
    overlay.value = buildOverlay(entries.value)
    llmCache.delete(canon)
  }

  /**
   * One-time migration of compatible `import_aliases` into kb_entries.
   *
   * import_aliases records SPELLING ('eng' -> the school's configured
   * 'English'); kb_entries records MEANING. An alias is compatible when its
   * target still classifies to a known family — then the source spelling is
   * worth remembering as that family. Aliases whose target the KB can't place
   * are skipped rather than guessed at, and reported so they can be handled
   * by hand.
   *
   * Idempotent: an existing kb_entries doc for a value is never overwritten
   * (a human-confirmed entry always outranks a derived one). `dryRun` returns
   * the same report without writing, for the preview.
   */
  async function migrateImportAliases({ dryRun = true } = {}) {
    await loadKB()
    const snap = await getDocs(importAliasesCollection())
    const existing = new Set(entries.value.map(e => e.id))
    const planned = []
    const skipped = []

    for (const d of snap.docs) {
      const a = d.data() || {}
      const from = canonicalize(a.from || '')
      const to = (a.to || '').trim()
      if (!from || !to) { skipped.push({ from: a.from || d.id, reason: 'incomplete alias' }); continue }
      if (existing.has(from)) { skipped.push({ from, reason: 'already in the knowledge base' }); continue }

      // The alias TYPE tells us which family to read the target as: import
      // aliases use 'class' for sections and 'subject' for subjects.
      const expect = a.type === 'class' ? SECTION : SUBJECT
      const r = classifyLocal(to, { expect, overlay: overlay.value })
      if (r.type === UNKNOWN || !r.canonical) {
        skipped.push({ from, to, reason: `target "${to}" is not in the knowledge base` })
        continue
      }
      planned.push({ value: from, original: a.from || from, type: r.type, canonical: r.canonical, to })
    }

    if (!dryRun) {
      for (const p of planned) {
        await setDoc(kbEntryDoc(p.value), {
          value: p.value, original: p.original, type: p.type, canonical: p.canonical,
          learned_from: 'import_aliases_migration',
          confirmed_by: auth.currentUser?.email || 'unknown',
          confirmed_at: serverTimestamp(),
        }, { merge: true })
      }
      if (planned.length) await loadKB(true)
    }

    return { planned, skipped }
  }

  const learnedCount = computed(() => entries.value.length)

  return {
    // state
    entries, overlay, loaded, learnedCount,
    // ladder
    loadKB, classify, classifyWithLLM, confirmClassification, forgetClassification,
    // maintenance
    migrateImportAliases,
    // re-exports so consumers need only this composable
    band, canonicalize,
    SUBJECT, COSCHOLASTIC, GRADE, SECTION, UNKNOWN, OTHER,
  }
}
