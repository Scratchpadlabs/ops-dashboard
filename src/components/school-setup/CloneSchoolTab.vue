<template>
  <div class="pt-4 max-w-2xl">
    <div class="bg-white rounded-xl border border-slate-200 p-4 space-y-4">
      <div>
        <label class="form-label">Source School</label>
        <div class="text-sm text-slate-700">{{ sourceSchoolName }} <span class="text-xs text-slate-400">(current selection)</span></div>
      </div>

      <div>
        <label class="form-label mb-2 block">Target</label>
        <div class="flex gap-1.5">
          <button
            type="button" class="px-3 py-1.5 rounded-lg text-sm font-medium border"
            :class="mode === 'new' ? 'bg-violet-50 border-violet-200 text-violet-700' : 'border-slate-200 text-slate-500'"
            @click="mode = 'new'"
          >New School</button>
          <button
            type="button" class="px-3 py-1.5 rounded-lg text-sm font-medium border"
            :class="mode === 'existing' ? 'bg-violet-50 border-violet-200 text-violet-700' : 'border-slate-200 text-slate-500'"
            @click="mode = 'existing'"
          >Copy Into Existing School</button>
        </div>
      </div>

      <div v-if="mode === 'new'" class="grid grid-cols-2 gap-4">
        <div>
          <label class="form-label">Target School Name *</label>
          <InputText v-model="targetName" class="w-full" placeholder="e.g. New School Name" @update:modelValue="onNameChange" />
        </div>
        <div>
          <label class="form-label">Target School ID (slug) *</label>
          <InputText v-model="targetId" class="w-full font-mono text-sm" />
        </div>
      </div>
      <div v-else>
        <label class="form-label">Target School *</label>
        <Select
          v-model="existingTargetId" :options="otherSchools" optionLabel="name" optionValue="id"
          placeholder="Select a school" class="w-full" filter @focus="loadOtherSchools"
        />
        <p class="text-xs text-slate-400 mt-1">
          Writes into a school that already has its own data. Only the collections below are offered here —
          structural setup (subjects, classes, terms, etc.) isn't, since a shared doc ID could silently
          overwrite something the target school already has.
        </p>
      </div>

      <div v-if="mode === 'new'">
        <label class="form-label mb-2 block">Copy</label>
        <div class="grid grid-cols-2 gap-1.5">
          <label v-for="opt in standardOptions" :key="opt.key" class="flex items-center gap-2 text-sm">
            <Checkbox v-model="selected" :value="opt.key" />
            {{ opt.label }}
          </label>
        </div>
      </div>

      <div>
        <label class="form-label mb-2 block">Also copy (opt-in — confirm with Sid before relying on these)</label>
        <div class="grid grid-cols-2 gap-1.5">
          <label v-for="opt in optInOptions" :key="opt.key" class="flex items-center gap-2 text-sm">
            <Checkbox v-model="selected" :value="opt.key" />
            {{ opt.label }}
          </label>
        </div>
      </div>

      <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
      <div v-if="progress.total" class="text-sm text-slate-500">{{ progress.message }}</div>

      <div v-if="flaggedRefs.length" class="text-sm bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-700">
        <div class="font-semibold mb-1">Review manually — these fields look like class/subject references copied as-is (source school's IDs, not remapped to the target):</div>
        <div v-for="f in flaggedRefs" :key="`${f.collection}/${f.id}`" class="text-xs">
          {{ f.collection }}/{{ f.id }}: {{ f.fields.join(', ') }}
        </div>
      </div>

      <Button label="Clone School" :loading="cloning" @click="confirmClone" />
    </div>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { getDocs, getDoc, doc, query, orderBy, writeBatch, serverTimestamp } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Checkbox from 'primevue/checkbox'
import Select from 'primevue/select'
import ConfirmDialog from 'primevue/confirmdialog'

import { schoolCollection, schoolDoc, rootSchoolDoc, rootSchoolsCollection } from '../../firebase/schoolCollections.js'
import { db } from '../../firebase/config'
import { auth } from '../../firebase/config'
import { slugify } from '../../utils/assessmentHelpers.js'

const props = defineProps({ schoolId: { type: String, default: null }, school: { type: Object, default: null } })
const confirm = useConfirm()
const toast = useToast()

const sourceSchoolName = computed(() => props.school?.name || props.schoolId || '(none selected)')

const standardOptions = [
  { key: 'terms', label: 'Terms' },
  { key: 'grading_scales', label: 'Grading Scales' },
  { key: 'subjects', label: 'Subjects (with curricular goals)' },
  { key: 'remark_categories', label: 'Remark Categories' },
  { key: 'months', label: 'Months' },
  { key: 'co_scholastic_activities', label: 'Co-Scholastic Activities' },
  { key: 'assessments', label: 'Assessments' },
  { key: 'classes', label: 'Classes (structure only, no teachers/progress)' },
  { key: 'config', label: 'Config Schemas' },
]
// Loosely-referenced content collections — safe to add to a school that
// already has its own data, since nothing in this app looks them up by ID.
// The `mode === 'existing'` flow only ever offers these (never standardOptions),
// so a shared doc ID with the target can't silently overwrite live structural
// data (a subject, a class, ...).
const optInOptions = [
  { key: 'playbooks', label: 'Playbooks' },
  { key: 'activities', label: 'Activities' },
  { key: 'surveys', label: 'Surveys (definitions only, not assignments/responses)' },
  { key: 'avatars', label: 'Avatars' },
]

// ── Target: a brand-new school, or an opt-in write into an existing one ────
const mode = ref('new') // 'new' | 'existing'
const targetName = ref('')
const targetId = ref('')
const existingTargetId = ref(null)
const otherSchools = ref([])
const selected = ref(standardOptions.map(o => o.key))
const formError = ref('')
const cloning = ref(false)
const progress = reactive({ total: 0, done: 0, message: '' })
const flaggedRefs = ref([]) // [{ collection, id, fields }] — classId/subjectId-shaped fields copied as-is

async function loadOtherSchools() {
  if (otherSchools.value.length) return
  try {
    const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name')))
    otherSchools.value = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.id !== props.schoolId && s.isActive !== false)
  } catch (e) {
    console.error('Could not load schools', e)
  }
}

let idManuallyEdited = false
function onNameChange() {
  if (!idManuallyEdited) targetId.value = slugify(targetName.value).toUpperCase() || slugify(targetName.value)
}

function validate() {
  if (!props.schoolId) return 'Select a source school first'
  if (mode.value === 'existing') {
    if (!existingTargetId.value) return 'Select a target school'
    if (!selected.value.some(k => optInOptions.some(o => o.key === k))) return 'Select at least one collection to copy'
    return ''
  }
  if (!targetName.value.trim()) return 'Target school name is required'
  if (!targetId.value.trim()) return 'Target school ID is required'
  if (targetId.value.trim() === props.schoolId) return 'Target ID must differ from the source school'
  return ''
}

// Recursively flags any field whose NAME looks like a class/subject
// reference (classId, classIds, subjectId, subjectIds, ...) at any depth —
// `activities`/`surveys`/`playbooks`/`avatars` have no fixed schema in this
// app, so this is a structural guess, not a shape-specific check. Copied
// verbatim from the source school, such a value is almost certainly a
// source-school ID that won't resolve against the target's own classes/
// subjects — flagged for a human to fix, never auto-remapped.
function findRefFields(data, path = '') {
  const hits = []
  if (Array.isArray(data)) {
    data.forEach((v, i) => hits.push(...findRefFields(v, `${path}[${i}]`)))
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      const p = path ? `${path}.${k}` : k
      if (/classid|subjectid/i.test(k)) hits.push(p)
      hits.push(...findRefFields(v, p))
    }
  }
  return hits
}

async function confirmClone() {
  formError.value = validate()
  if (formError.value) return

  if (mode.value === 'new') {
    const rootSnap = await getDoc(rootSchoolDoc(targetId.value.trim()))
    if (rootSnap.exists()) { formError.value = `A school with ID "${targetId.value.trim()}" already exists`; return }
    confirm.require({
      message: `Clone "${sourceSchoolName.value}" into new school "${targetName.value.trim()}" (${targetId.value.trim()})? This will copy ${selected.value.length} collection type(s). Nothing auto-fixes — review the target afterward.`,
      header: 'Clone School', icon: 'pi pi-exclamation-triangle',
      rejectLabel: 'Cancel', acceptLabel: 'Clone',
      accept: runClone,
    })
    return
  }

  const targetName_ = otherSchools.value.find(s => s.id === existingTargetId.value)?.name || existingTargetId.value
  const optInSelectedCount = selected.value.filter(k => optInOptions.some(o => o.key === k)).length
  confirm.require({
    message: `Copy ${optInSelectedCount} collection(s) from "${sourceSchoolName.value}" into the EXISTING school "${targetName_}"? Docs whose ID doesn't already exist there keep it; anything that collides gets a fresh ID rather than overwriting the target's doc.`,
    header: 'Copy Into Existing School', icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Copy',
    accept: runClone,
  })
}

async function runClone() {
  cloning.value = true
  formError.value = ''
  progress.total = 0
  progress.done = 0
  progress.message = 'Reading source data...'
  flaggedRefs.value = []
  try {
    const targetSchoolId = mode.value === 'new' ? targetId.value.trim() : existingTargetId.value
    const ops = [] // { ref, data }

    if (mode.value === 'new') {
      ops.push({ ref: rootSchoolDoc(targetSchoolId), data: { id: targetSchoolId, name: targetName.value.trim(), isActive: true, created_at: serverTimestamp(), created_by: auth.currentUser?.email || 'unknown' } })
    }

    // In 'existing' mode, only ever touch the opt-in content collections —
    // never the structural ones, even if `selected` still carries them over
    // from a prior 'new' session.
    const keysToCopy = mode.value === 'existing'
      ? selected.value.filter(k => optInOptions.some(o => o.key === k))
      : selected.value

    for (const key of keysToCopy) {
      if (key === 'config') {
        const snap = await getDocs(schoolCollection(props.schoolId, 'config')).catch(() => null)
        ;(snap?.docs || []).forEach(d => ops.push({ ref: schoolDoc(targetSchoolId, 'config', d.id), data: d.data() }))
        continue
      }
      const snap = await getDocs(schoolCollection(props.schoolId, key))

      // Existing-school mode: preserve the source doc ID unless the target
      // already has a doc there, in which case fall back to a fresh auto-ID
      // rather than risk overwriting a doc the target already owns.
      let existingIds = new Set()
      if (mode.value === 'existing' && snap.docs.length) {
        const targetSnap = await getDocs(schoolCollection(targetSchoolId, key)).catch(() => null)
        existingIds = new Set((targetSnap?.docs || []).map(d => d.id))
      }

      snap.docs.forEach(d => {
        let data = { ...d.data() }
        if (key === 'classes') {
          data = {
            ...data,
            subjects: (data.subjects || []).map(s => ({ subjectId: s.subjectId, teacherId: '', isCompleted: false, completedAt: null, topics: (s.topics || []).map(t => ({ ...t, isCompleted: false, completedAt: null })) })),
          }
        }

        const useFreshId = mode.value === 'existing' && existingIds.has(d.id)
        const ref = useFreshId ? doc(schoolCollection(targetSchoolId, key)) : schoolDoc(targetSchoolId, key, d.id)

        if (mode.value === 'existing') {
          const fields = findRefFields(data)
          if (fields.length) flaggedRefs.value.push({ collection: key, id: useFreshId ? `${d.id} → ${ref.id}` : d.id, fields })
        }

        ops.push({ ref, data })
      })
    }

    progress.total = ops.length
    progress.message = `Writing ${progress.total} doc(s)...`

    for (let i = 0; i < ops.length; i += 450) {
      const chunk = ops.slice(i, i + 450)
      const batch = writeBatch(db)
      chunk.forEach(op => batch.set(op.ref, op.data, { merge: true }))
      await batch.commit()
      progress.done += chunk.length
      progress.message = `Wrote ${progress.done}/${progress.total} doc(s)...`
    }

    progress.message = `Done — ${progress.done} doc(s) written to "${targetSchoolId}".`
    toast.add({ severity: 'success', summary: mode.value === 'new' ? 'School cloned' : 'Copied into school', detail: targetSchoolId, life: 3000 })
  } catch (e) {
    console.error(e)
    formError.value = 'Something went wrong during cloning. Check the console — some docs may have been written.'
  } finally {
    cloning.value = false
  }
}
</script>

<style scoped>
.form-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: #64748b;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
</style>
