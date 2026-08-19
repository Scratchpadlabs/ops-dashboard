<template>
  <div class="pt-4 max-w-2xl">
    <div class="bg-white rounded-xl border border-slate-200 p-4 space-y-4">
      <div>
        <label class="form-label">Source School</label>
        <div class="text-sm text-slate-700">{{ sourceSchoolName }} <span class="text-xs text-slate-400">(current selection)</span></div>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="form-label">Target School Name *</label>
          <InputText v-model="targetName" class="w-full" placeholder="e.g. New School Name" @update:modelValue="onNameChange" />
        </div>
        <div>
          <label class="form-label">Target School ID (slug) *</label>
          <InputText v-model="targetId" class="w-full font-mono text-sm" />
        </div>
      </div>

      <div>
        <label class="form-label mb-2 block">Copy</label>
        <div class="grid grid-cols-2 gap-1.5">
          <label v-for="opt in standardOptions" :key="opt.key" class="flex items-center gap-2 text-sm">
            <Checkbox v-model="selected" :value="opt.key" />
            {{ opt.label }}
          </label>
        </div>
      </div>

      <div>
        <label class="form-label mb-2 block">Also copy (opt-in — not confirmed as belonging in a clone)</label>
        <div class="grid grid-cols-2 gap-1.5">
          <label v-for="opt in optInOptions" :key="opt.key" class="flex items-center gap-2 text-sm">
            <Checkbox v-model="selected" :value="opt.key" />
            {{ opt.label }}
          </label>
        </div>
      </div>

      <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
      <div v-if="progress.total" class="text-sm text-slate-500">{{ progress.message }}</div>

      <Button label="Clone School" :loading="cloning" @click="confirmClone" />
    </div>

  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { getDocs, getDoc, writeBatch, serverTimestamp } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Checkbox from 'primevue/checkbox'

import { schoolCollection, schoolDoc, rootSchoolDoc } from '../../firebase/schoolCollections.js'
import { db } from '../../firebase/config'
import { auth } from '../../firebase/config'
import { slugify } from '../../utils/assessmentHelpers.js'
import { isJunkDoc } from '../../utils/schoolSetupHelpers.js'

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
  // Confirmed by ops: playbooks and activities go to every new school, so they
  // are standard rather than opt-in (spec §9 Q3). Avatars stay opt-in — never
  // confirmed either way.
  { key: 'playbooks', label: 'Playbooks' },
  { key: 'activities', label: 'Activities' },
]
const optInOptions = [
  { key: 'avatars', label: 'Avatars' },
]

const targetName = ref('')
const targetId = ref('')
const selected = ref(standardOptions.map(o => o.key))
const formError = ref('')
const cloning = ref(false)
const progress = reactive({ total: 0, done: 0, message: '' })

let idManuallyEdited = false
function onNameChange() {
  if (!idManuallyEdited) targetId.value = slugify(targetName.value).toUpperCase() || slugify(targetName.value)
}

function validate() {
  if (!props.schoolId) return 'Select a source school first'
  if (!targetName.value.trim()) return 'Target school name is required'
  if (!targetId.value.trim()) return 'Target school ID is required'
  if (targetId.value.trim() === props.schoolId) return 'Target ID must differ from the source school'
  return ''
}

async function confirmClone() {
  formError.value = validate()
  if (formError.value) return

  const rootSnap = await getDoc(rootSchoolDoc(targetId.value.trim()))
  if (rootSnap.exists()) { formError.value = `A school with ID "${targetId.value.trim()}" already exists`; return }

  confirm.require({
    message: `Clone "${sourceSchoolName.value}" into new school "${targetName.value.trim()}" (${targetId.value.trim()})? This will copy ${selected.value.length} collection type(s). Nothing auto-fixes — review the target afterward.`,
    header: 'Clone School', icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Clone',
    accept: runClone,
  })
}

async function runClone() {
  cloning.value = true
  formError.value = ''
  progress.total = 0
  progress.done = 0
  progress.message = 'Reading source data...'
  try {
    const targetSchoolId = targetId.value.trim()
    const ops = [] // { ref, data }
    const skipped = [] // ids of stub docs deliberately not copied

    ops.push({ ref: rootSchoolDoc(targetSchoolId), data: { id: targetSchoolId, name: targetName.value.trim(), isActive: true, created_at: serverTimestamp(), created_by: auth.currentUser?.email || 'unknown' } })

    for (const key of selected.value) {
      if (key === 'config') {
        const snap = await getDocs(schoolCollection(props.schoolId, 'config')).catch(() => null)
        ;(snap?.docs || []).forEach(d => {
          if (isJunkDoc(d.data())) { skipped.push(`config/${d.id}`); return }
          ops.push({ ref: schoolDoc(targetSchoolId, 'config', d.id), data: d.data() })
        })
        continue
      }
      const snap = await getDocs(schoolCollection(props.schoolId, key))
      snap.docs.forEach(d => {
        // Bootstrap stubs are never worth carrying into a fresh school, and a
        // clone is exactly how one school's leftovers become every school's.
        if (isJunkDoc(d.data())) { skipped.push(`${key}/${d.id}`); return }
        let data = { ...d.data() }
        if (key === 'classes') {
          data = {
            ...data,
            subjects: (data.subjects || []).map(s => ({ subjectId: s.subjectId, teacherId: '', isCompleted: false, completedAt: null, topics: (s.topics || []).map(t => ({ ...t, isCompleted: false, completedAt: null })) })),
          }
        }
        ops.push({ ref: schoolDoc(targetSchoolId, key, d.id), data })
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

    // Say what was left behind rather than dropping it silently — if a doc is
    // missing from the new school, this is the first place to look.
    const skipNote = skipped.length
      ? ` Skipped ${skipped.length} stub doc(s) carrying only "a": ${skipped.join(', ')}.`
      : ''
    if (skipped.length) console.info('Clone skipped stub docs:', skipped)
    progress.message = `Done — ${progress.done} doc(s) written to "${targetSchoolId}".${skipNote}`
    toast.add({
      severity: 'success',
      summary: 'School cloned',
      detail: skipped.length ? `${targetSchoolId} — ${skipped.length} stub doc(s) skipped` : targetSchoolId,
      life: 4000,
    })
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
