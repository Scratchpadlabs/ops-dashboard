<template>
  <Dialog v-model:visible="model" header="Exam scheme" modal :style="{ width: '900px' }">
    <!-- ── No scheme yet ──────────────────────────────────────────────────
         A school with no scheme gets no assessments, deliberately: one
         framework applied everywhere would be wrong silently. So this is a
         real state with a real choice, not an empty form. -->
    <div v-if="!scheme && !loading" class="space-y-4">
      <div class="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <div class="text-sm font-semibold text-slate-800 mb-1">
          {{ schoolId }} has no exam scheme yet
        </div>
        <p class="text-xs text-slate-500">
          A scheme says how this school examines — which exams, out of how many marks, and
          which subjects carry a practical. Nothing is assumed from other schools, because a
          school that examines differently would otherwise get columns that look right and
          disagree with its own report card at the end of term.
        </p>
      </div>

      <div class="grid gap-3 md:grid-cols-3">
        <button v-for="opt in startOptions" :key="opt.key" type="button"
                class="text-left rounded-lg border border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 p-3 transition"
                :disabled="opt.disabled" :class="{ 'opacity-40 cursor-not-allowed': opt.disabled }"
                @click="opt.run">
          <div class="text-sm font-semibold text-slate-800 mb-1">
            <i :class="opt.icon" class="mr-1 text-xs"></i>{{ opt.label }}
          </div>
          <p class="text-[11px] text-slate-500">{{ opt.hint }}</p>
        </button>
      </div>

      <div v-if="otherSchools.length" class="pt-1">
        <label class="form-label">Copy from</label>
        <Select v-model="copyFromId" :options="otherSchools" optionLabel="name" optionValue="id"
                placeholder="A school that already has one" class="w-full" filter />
      </div>
    </div>

    <div v-else-if="loading" class="flex justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>

    <!-- ── The scheme ─────────────────────────────────────────────────────-->
    <div v-else class="space-y-5">
      <div>
        <label class="form-label">Scheme name *</label>
        <InputText v-model="scheme.name" class="w-full" placeholder="e.g. CBSE — 2026-27" />
        <p v-if="scheme.source" class="text-[11px] text-slate-400 mt-1">{{ scheme.source }}</p>
      </div>

      <!-- Splits -->
      <section>
        <div class="text-xs font-bold text-slate-700 mb-1">Written + internal splits</div>
        <p class="text-[11px] text-slate-500 mb-2">
          How a 100-mark exam divides. Every subject takes one of these; "standard" is what a
          subject takes when nothing else is chosen for it.
        </p>
        <div class="grid gap-2 md:grid-cols-3">
          <div v-for="name in splitNames" :key="name"
               class="rounded-lg border border-slate-200 px-3 py-2">
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs font-semibold text-slate-700">{{ name }}</span>
              <Button v-if="name !== 'standard'" icon="pi pi-times" text size="small"
                      severity="secondary" @click="removeSplit(name)" />
            </div>
            <div class="flex items-center gap-1">
              <InputNumber v-model="scheme.splits[name].written" :min="0" class="w-20" inputClass="text-xs" />
              <span class="text-slate-400 text-xs">+</span>
              <InputNumber v-model="scheme.splits[name].internal" :min="0" class="w-20" inputClass="text-xs" />
              <span class="text-[11px] text-slate-400 ml-1">
                = {{ (scheme.splits[name].written || 0) + (scheme.splits[name].internal || 0) }}
              </span>
            </div>
          </div>
          <button type="button" class="rounded-lg border border-dashed border-slate-300 text-xs text-slate-500 px-3 py-2 hover:border-blue-400"
                  @click="addSplit">
            <i class="pi pi-plus text-[10px] mr-1"></i>Add a split
          </button>
        </div>
      </section>

      <!-- Exams -->
      <section>
        <div class="flex items-center justify-between mb-1">
          <div class="text-xs font-bold text-slate-700">Exams</div>
          <Button label="Add exam" icon="pi pi-plus" size="small" text @click="addExam" />
        </div>
        <p class="text-[11px] text-slate-500 mb-2">
          Each becomes two assessments per subject — a Written and an Internal document, because
          a report card prints them as separate columns. <span class="font-mono">key</span> is
          part of the document id, so changing it on a live school creates new assessments
          beside the old ones.
        </p>
        <div v-for="(exam, ei) in scheme.exams" :key="ei"
             class="rounded-lg border border-slate-200 px-3 py-2 mb-2">
          <div class="flex flex-wrap items-end gap-2 mb-2">
            <div><label class="form-label">Name</label>
              <InputText v-model="exam.name" class="w-52" /></div>
            <div><label class="form-label">Key</label>
              <InputText v-model="exam.key" class="w-24 font-mono" /></div>
            <div><label class="form-label">Term</label>
              <Select v-model="exam.term" :options="[{ l: 'I', v: 1 }, { l: 'II', v: 2 }]"
                      optionLabel="l" optionValue="v" class="w-20" /></div>
            <div><label class="form-label">Order</label>
              <InputNumber v-model="exam.order" :min="1" class="w-20" /></div>
            <div class="flex items-center gap-1.5 pb-1.5">
              <Checkbox v-model="exam.splitVaries" binary :inputId="`sv${ei}`" />
              <label :for="`sv${ei}`" class="text-[11px] text-slate-600">
                marks split by subject
              </label>
            </div>
            <template v-if="!exam.splitVaries">
              <div><label class="form-label">Written becomes</label>
                <InputNumber v-model="exam.convertTo" :min="1" class="w-24" /></div>
              <div><label class="form-label">Internal</label>
                <InputNumber v-model="exam.internal" :min="0" class="w-20" /></div>
            </template>
            <Button icon="pi pi-trash" text size="small" severity="danger" class="ml-auto"
                    @click="scheme.exams.splice(ei, 1)" />
          </div>

          <div class="pl-1">
            <div class="text-[11px] text-slate-500 mb-1">
              Written paper by grade — leave the mark blank to take it from the subject's split
            </div>
            <div v-for="(band, bi) in exam.writtenBands" :key="bi" class="flex items-center gap-1.5 mb-1">
              <span class="text-[11px] text-slate-400">grades</span>
              <InputNumber v-model="band.minGrade" class="w-16" :min="-3" :max="12" />
              <span class="text-[11px] text-slate-400">to</span>
              <InputNumber v-model="band.maxGrade" class="w-16" :min="-3" :max="12" />
              <span class="text-[11px] text-slate-400">out of</span>
              <InputNumber v-model="band.max" class="w-20" :min="1" placeholder="from split" />
              <Button icon="pi pi-times" text size="small" severity="secondary"
                      @click="exam.writtenBands.splice(bi, 1)" />
            </div>
            <Button label="Add band" icon="pi pi-plus" text size="small"
                    @click="exam.writtenBands.push({ minGrade: 1, maxGrade: 12, max: null })" />
          </div>
        </div>
      </section>

      <!-- Subject splits — the table that stops a guess becoming a decision -->
      <section>
        <div class="flex items-center justify-between mb-1">
          <div class="text-xs font-bold text-slate-700">
            Which subjects carry a practical
            <span v-if="proposedCount" class="ml-2 text-[10px] font-normal bg-amber-100 text-amber-800 rounded px-1.5 py-0.5">
              {{ proposedCount }} unconfirmed
            </span>
          </div>
          <div class="flex gap-1">
            <Button label="Suggest from names" icon="pi pi-sparkles" size="small" text
                    :disabled="!subjects.length" @click="seedSplits" />
            <Button v-if="proposedCount" label="Confirm all" icon="pi pi-check" size="small" text
                    @click="confirmAll" />
          </div>
        </div>
        <p class="text-[11px] text-slate-500 mb-2">
          Every subject the school teaches, and the split it takes. "Suggest from names" guesses
          once from the subject name; nothing it guesses is trusted until confirmed here. This
          list is why a school can spell the same subject two ways without them being examined
          differently by accident.
        </p>
        <DataTable :value="subjectRows" size="small" stripedRows paginator :rows="10" class="text-xs">
          <Column field="name" header="Subject" style="width:200px" />
          <Column header="Split" style="width:170px">
            <template #body="{ data }">
              <Select :modelValue="data.splitName" :options="splitNames" class="w-40"
                      @update:modelValue="v => setSplit(data, v)" />
            </template>
          </Column>
          <Column header="Marks" style="width:90px">
            <template #body="{ data }">
              <span class="text-slate-500">
                {{ scheme.splits[data.splitName]?.written }} + {{ scheme.splits[data.splitName]?.internal }}
              </span>
            </template>
          </Column>
          <Column header="" style="width:150px">
            <template #body="{ data }">
              <span v-if="data.proposed"
                    class="text-[10px] bg-amber-50 text-amber-800 border border-amber-200 rounded px-1.5 py-0.5 cursor-pointer"
                    v-tooltip="data.reason" @click="confirmOne(data)">unconfirmed — click to confirm</span>
              <span v-else class="text-[10px] text-slate-400" v-tooltip="data.reason">confirmed</span>
            </template>
          </Column>
          <Column field="count" header="Used by" style="width:80px">
            <template #body="{ data }"><span class="text-slate-400">{{ data.count }}</span></template>
          </Column>
        </DataTable>
      </section>

      <!-- Grades the scheme was not actually written from -->
      <section>
        <div class="text-xs font-bold text-slate-700 mb-1">Grades taken on trust</div>
        <p class="text-[11px] text-slate-500 mb-2">
          Grades this scheme covers by extension rather than from a document. They still get
          assessments; the preview says they are unverified so nobody assumes otherwise.
        </p>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="g in scheme.unverifiedGrades" :key="g"
                class="text-[11px] bg-amber-50 text-amber-800 border border-amber-200 rounded px-2 py-0.5">
            grade {{ g }}
            <i class="pi pi-times text-[9px] ml-1 cursor-pointer" @click="removeUnverified(g)"></i>
          </span>
          <Select v-model="addUnverified" :options="gradeOptions" placeholder="Add…" class="w-28"
                  @update:modelValue="onAddUnverified" />
        </div>
      </section>

      <div v-if="verdict.errors.length" class="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
        <div class="text-xs font-semibold text-red-700 mb-1">
          {{ verdict.errors.length }} thing(s) must be fixed before this can be saved
        </div>
        <div class="text-[11px] text-red-700 space-y-0.5">
          <div v-for="(e, i) in verdict.errors" :key="i">{{ e }}</div>
        </div>
      </div>
      <div v-if="verdict.warnings.length" class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
        <div class="text-[11px] text-amber-800 space-y-0.5">
          <div v-for="(w, i) in verdict.warnings" :key="i">{{ w }}</div>
        </div>
      </div>
      <div v-if="error" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{{ error }}</div>
    </div>

    <template #footer>
      <Button label="Close" text @click="model = false" />
      <Button v-if="scheme" label="Save scheme" icon="pi pi-check" :loading="saving"
              :disabled="!verdict.ok" @click="save" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { getDoc, getDocs, setDoc, serverTimestamp } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Select from 'primevue/select'
import Checkbox from 'primevue/checkbox'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import ProgressSpinner from 'primevue/progressspinner'

import { schoolDoc, rootSchoolsCollection } from '../../firebase/schoolCollections.js'
import { auth } from '../../firebase/config'
import {
  EXAM_SCHEME_DOC, exampleScheme, proposeSubjectSplits, validateScheme, nameKey,
} from '../../utils/examScheme.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  schoolId: { type: String, default: null },
  subjects: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:visible', 'saved'])
const toast = useToast()

const model = computed({
  get: () => props.visible,
  set: v => emit('update:visible', v),
})

const scheme = ref(null)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const otherSchools = ref([])
const copyFromId = ref(null)
const addUnverified = ref(null)

const splitNames = computed(() => Object.keys(scheme.value?.splits || {}))
const verdict = computed(() => scheme.value
  ? validateScheme(scheme.value)
  : { ok: false, errors: [], warnings: [] })

/**
 * One row per subject NAME, not per subject document. A school teaches
 * "English" at ten grades and examines it one way; ten identical rows would be
 * ten chances to set nine of them and miss one.
 */
const subjectRows = computed(() => {
  if (!scheme.value) return []
  const byKey = new Map()
  for (const s of props.subjects) {
    const name = s.name || s.id
    const key = nameKey(name)
    if (!key) continue
    if (!byKey.has(key)) {
      const entry = scheme.value.subjectSplits?.[key]
      byKey.set(key, {
        key,
        name,
        splitName: entry?.splitName || 'standard',
        reason: entry?.reason || 'not set — takes the standard split',
        proposed: !!entry?.proposed,
        count: 0,
      })
    }
    byKey.get(key).count++
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
})

const proposedCount = computed(() => subjectRows.value.filter(r => r.proposed).length)
const gradeOptions = computed(() => Array.from({ length: 12 }, (_, i) => i + 1)
  .filter(g => !(scheme.value?.unverifiedGrades || []).includes(g)))

async function load() {
  if (!props.schoolId) return
  loading.value = true
  error.value = ''
  try {
    const snap = await getDoc(schoolDoc(props.schoolId, 'config', EXAM_SCHEME_DOC))
    scheme.value = snap.exists() ? snap.data() : null
    if (!scheme.value) await loadOtherSchools()
  } catch (e) {
    console.error(e)
    error.value = 'Could not read this school\'s exam scheme.'
  } finally {
    loading.value = false
  }
}

// Only the schools that actually HAVE a scheme — offering one that does not is
// a click that fails.
async function loadOtherSchools() {
  try {
    const snap = await getDocs(rootSchoolsCollection())
    const ids = snap.docs.map(d => ({ id: d.id, name: d.data().name || d.id }))
      .filter(s => s.id !== props.schoolId)
    const checks = await Promise.all(ids.map(async s => {
      const d = await getDoc(schoolDoc(s.id, 'config', EXAM_SCHEME_DOC)).catch(() => null)
      return d?.exists?.() ? s : null
    }))
    otherSchools.value = checks.filter(Boolean)
  } catch (e) {
    console.error(e)
  }
}

watch(() => [props.visible, props.schoolId], ([v]) => { if (v) load() }, { immediate: true })

const startOptions = computed(() => [
  {
    key: 'blank', icon: 'pi pi-file', label: 'Build it from scratch',
    hint: 'One exam, one split. Everything else you add as this school actually examines.',
    run: startBlank,
  },
  {
    key: 'copy', icon: 'pi pi-copy', label: 'Copy another school\'s',
    hint: otherSchools.value.length
      ? 'Its exams and splits, with the subject list re-matched against this school.'
      : 'No other school has a scheme yet.',
    disabled: !otherSchools.value.length || !copyFromId.value,
    run: startCopy,
  },
  {
    key: 'example', icon: 'pi pi-book', label: 'Start from the CBSE example',
    hint: 'Four periodic tests, 80+20 / 70+30 / 50+50 splits, Pre-Boards at grade 10 — read '
        + 'from one school\'s marks sheet and report cards. A starting point, not a standard.',
    run: startExample,
  },
])

function startBlank() {
  scheme.value = {
    name: '',
    splits: { standard: { written: 80, internal: 20 } },
    exams: [{ key: 'exam1', name: 'Exam 1', term: 1, order: 1, splitVaries: true,
              writtenBands: [{ minGrade: 1, maxGrade: 12, max: null }] }],
    gradeOverrides: {},
    unverifiedGrades: [],
    subjectSplits: {},
  }
}

function startExample() {
  scheme.value = exampleScheme()
  seedSplits()
}

async function startCopy() {
  loading.value = true
  try {
    const snap = await getDoc(schoolDoc(copyFromId.value, 'config', EXAM_SCHEME_DOC))
    const copied = snap.data()
    // The exams and splits carry over; the subject list does NOT. Another
    // school's subject names are not this school's, and copying them would
    // silently apply decisions made about different subjects.
    scheme.value = { ...copied, subjectSplits: {}, name: `${copied.name || 'Copied scheme'}` }
    seedSplits()
    toast.add({ severity: 'info', summary: 'Copied',
                detail: 'Subject splits were not copied — confirm them for this school.', life: 4000 })
  } catch (e) {
    console.error(e)
    error.value = 'Could not copy that scheme.'
  } finally {
    loading.value = false
  }
}

function seedSplits() {
  const proposal = proposeSubjectSplits(props.subjects)
  // Never overwrite a decision already made: a re-seed fills gaps only.
  const existing = scheme.value.subjectSplits || {}
  for (const [key, entry] of Object.entries(proposal)) {
    if (!existing[key]) existing[key] = entry
  }
  scheme.value.subjectSplits = { ...existing }
}

function setSplit(row, splitName) {
  scheme.value.subjectSplits = {
    ...scheme.value.subjectSplits,
    [row.key]: { name: row.name, splitName, reason: 'set for this school', proposed: false },
  }
}

function confirmOne(row) {
  const entry = scheme.value.subjectSplits[row.key]
  scheme.value.subjectSplits = {
    ...scheme.value.subjectSplits,
    [row.key]: { ...entry, proposed: false, reason: `${entry.reason} — confirmed` },
  }
}

function confirmAll() {
  const out = {}
  for (const [k, v] of Object.entries(scheme.value.subjectSplits || {})) {
    out[k] = v.proposed ? { ...v, proposed: false, reason: `${v.reason} — confirmed` } : v
  }
  scheme.value.subjectSplits = out
}

function addSplit() {
  let n = 1
  while (scheme.value.splits[`split${n}`]) n++
  scheme.value.splits = { ...scheme.value.splits, [`split${n}`]: { written: 70, internal: 30 } }
}

function removeSplit(name) {
  const used = Object.values(scheme.value.subjectSplits || {}).filter(e => e.splitName === name)
  if (used.length) {
    error.value = `"${name}" is used by ${used.length} subject(s) — change those first.`
    return
  }
  const { [name]: _drop, ...rest } = scheme.value.splits
  scheme.value.splits = rest
}

function addExam() {
  let n = scheme.value.exams.length + 1
  while (scheme.value.exams.some(e => e.key === `exam${n}`)) n++
  scheme.value.exams.push({
    key: `exam${n}`, name: `Exam ${n}`, term: 1,
    order: Math.max(0, ...scheme.value.exams.map(e => e.order || 0)) + 1,
    splitVaries: true, writtenBands: [{ minGrade: 1, maxGrade: 12, max: null }],
  })
}

function onAddUnverified(g) {
  if (g == null) return
  scheme.value.unverifiedGrades = [...(scheme.value.unverifiedGrades || []), g].sort((a, b) => a - b)
  addUnverified.value = null
}
function removeUnverified(g) {
  scheme.value.unverifiedGrades = scheme.value.unverifiedGrades.filter(x => x !== g)
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    await setDoc(schoolDoc(props.schoolId, 'config', EXAM_SCHEME_DOC), {
      ...scheme.value,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })
    toast.add({ severity: 'success', summary: 'Exam scheme saved', life: 2500 })
    emit('saved', scheme.value)
    model.value = false
  } catch (e) {
    console.error(e)
    error.value = 'Could not save the scheme. Check the console.'
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.form-label {
  display: block; font-size: 11px; font-weight: 500; color: #64748b;
  margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.04em;
}
</style>
