<template>
  <div class="pt-4 space-y-6">
    <!-- ── School fields ────────────────────────────────────────────────── -->
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <div class="text-sm font-bold text-slate-900 mb-3">School</div>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="form-label">Name</label>
          <InputText v-model="schoolForm.name" class="w-full" />
        </div>
        <div class="flex items-center gap-2 mt-5">
          <label class="form-label mb-0">Active</label>
          <ToggleButton v-model="schoolForm.isActive" onLabel="Yes" offLabel="No" size="small" />
        </div>
      </div>
      <div v-if="schoolFormError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ schoolFormError }}</div>
      <Button label="Save" size="small" class="mt-3" :loading="savingSchool" @click="saveSchool" />
    </div>

    <!-- ── Hygiene panel ────────────────────────────────────────────────── -->
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <div class="flex items-center justify-between mb-3">
        <div class="text-sm font-bold text-slate-900">Hygiene Check</div>
        <Button label="Re-scan" icon="pi pi-refresh" size="small" text :loading="scanning" @click="runScan" />
      </div>
      <div v-if="scanning" class="flex items-center justify-center py-8">
        <ProgressSpinner style="width:28px;height:28px" />
      </div>
      <div v-else-if="!warnings.length" class="text-sm text-emerald-600 py-4">✓ No issues found.</div>
      <div v-else class="space-y-2">
        <div v-for="(w, i) in warnings" :key="i" class="flex items-center justify-between gap-3 border border-amber-200 bg-amber-50 rounded-lg px-3 py-2">
          <span class="text-sm text-amber-800">{{ w.message }}</span>
          <Button :label="w.actionLabel" size="small" outlined @click="runWarningAction(w)" />
        </div>
      </div>
    </div>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, watch, onMounted } from 'vue'
import { getDocs, updateDoc, deleteDoc, getDoc, serverTimestamp } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import ToggleButton from 'primevue/togglebutton'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

import { schoolCollection, schoolDoc, rootSchoolDoc } from '../../firebase/schoolCollections.js'
import { auth } from '../../firebase/config'
import { regenerateStudentsSchemaClassOptions, isJunkDoc } from '../../utils/schoolSetupHelpers.js'

const props = defineProps({ schoolId: { type: String, default: null }, school: { type: Object, default: null } })
const emit = defineEmits(['saved'])
const confirm = useConfirm()
const toast = useToast()

// ── School fields ────────────────────────────────────────────────────────
const schoolForm = reactive({ name: '', isActive: true })
const schoolFormError = ref('')
const savingSchool = ref(false)

watch(() => props.school, (s) => {
  schoolForm.name = s?.name || ''
  schoolForm.isActive = s?.isActive !== false
}, { immediate: true })

async function saveSchool() {
  if (!schoolForm.name.trim()) { schoolFormError.value = 'Name is required'; return }
  schoolFormError.value = ''
  savingSchool.value = true
  try {
    await updateDoc(rootSchoolDoc(props.schoolId), {
      name: schoolForm.name.trim(), isActive: schoolForm.isActive,
      updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    })
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 })
    emit('saved')
  } catch (e) {
    schoolFormError.value = 'Something went wrong. Try again.'
  } finally {
    savingSchool.value = false
  }
}

// ── Hygiene scan (read-only detection; every fix below is opt-in + confirm) ─
const warnings = ref([])
const scanning = ref(false)

async function runScan() {
  if (!props.schoolId) { warnings.value = []; return }
  scanning.value = true
  const found = []
  try {
    const [terms, scales, subjects, classes, assessments, coScholastic, sheets, studentsSchema] = await Promise.all([
      getDocs(schoolCollection(props.schoolId, 'terms')),
      getDocs(schoolCollection(props.schoolId, 'grading_scales')),
      getDocs(schoolCollection(props.schoolId, 'subjects')),
      getDocs(schoolCollection(props.schoolId, 'classes')),
      getDocs(schoolCollection(props.schoolId, 'assessments')),
      getDocs(schoolCollection(props.schoolId, 'co_scholastic_activities')),
      getDocs(schoolCollection(props.schoolId, 'smart_sheet_entries')),
      getDoc(schoolDoc(props.schoolId, 'config', 'students_schema')),
    ])

    const termIds = new Set(terms.docs.map(d => d.id))
    const scaleIds = new Set(scales.docs.map(d => d.id))
    const subjectIds = new Set(subjects.docs.map(d => d.id))
    const classIds = new Set(classes.docs.map(d => d.id))

    // 1. Stray/test docs (only field is `a`)
    const junkCollections = [
      ['terms', terms], ['grading_scales', scales], ['subjects', subjects], ['classes', classes],
      ['assessments', assessments], ['co_scholastic_activities', coScholastic],
    ]
    for (const [name, snap] of junkCollections) {
      snap.docs.forEach(d => {
        if (isJunkDoc(d.data())) {
          found.push({ message: `Junk doc ${name}/${d.id} (only field "a")`, actionLabel: 'Delete doc', action: 'delete', collection: name, id: d.id })
        }
      })
    }

    // 2. Sheet docs referencing a nonexistent term
    sheets.docs.forEach(d => {
      const termId = d.data().termId
      if (termId && !termIds.has(termId)) {
        found.push({ message: `smart_sheet_entries/${d.id} references missing term "${termId}"`, actionLabel: 'Delete doc', action: 'delete', collection: 'smart_sheet_entries', id: d.id })
      }
    })

    // 3. Subjects referenced by classes but missing from subjects
    classes.docs.forEach(d => {
      const data = d.data()
      ;(data.subjects || []).forEach(s => {
        if (s.subjectId && !subjectIds.has(s.subjectId)) {
          found.push({ message: `classes/${d.id} references missing subject "${s.subjectId}"`, actionLabel: 'Delete class doc', action: 'delete', collection: 'classes', id: d.id })
        }
      })
    })

    // 4. Assessments referencing missing gradingScaleId/termId/subjectId
    assessments.docs.forEach(d => {
      const data = d.data()
      if (data.termId && !termIds.has(data.termId)) {
        found.push({ message: `assessments/${d.id} references missing term "${data.termId}"`, actionLabel: 'Delete doc', action: 'delete', collection: 'assessments', id: d.id })
      }
      if (data.subjectId && !subjectIds.has(data.subjectId)) {
        found.push({ message: `assessments/${d.id} references missing subject "${data.subjectId}"`, actionLabel: 'Delete doc', action: 'delete', collection: 'assessments', id: d.id })
      }
      if (data.gradingScaleId && !scaleIds.has(data.gradingScaleId)) {
        found.push({ message: `assessments/${d.id} references missing grading scale "${data.gradingScaleId}"`, actionLabel: 'Delete doc', action: 'delete', collection: 'assessments', id: d.id })
      }
    })

    // 5. students_schema class options vs live class list
    if (studentsSchema.exists()) {
      const columns = studentsSchema.data().columns || []
      const col = columns.find(c => c.key === 'currentClassId')
      if (col) {
        const liveIds = Array.from(classIds).sort()
        const currentOptions = [...(col.options || [])].sort()
        if (JSON.stringify(liveIds) !== JSON.stringify(currentOptions)) {
          found.push({ message: `config/students_schema currentClassId options (${currentOptions.length}) don't match live classes (${liveIds.length})`, actionLabel: 'Fix', action: 'fix-schema' })
        }
      }
    }

    warnings.value = found
  } catch (e) {
    console.error('Hygiene scan failed', e)
    toast.add({ severity: 'error', summary: 'Scan failed', detail: 'Could not complete hygiene check', life: 3000 })
  } finally {
    scanning.value = false
  }
}

function runWarningAction(w) {
  if (w.action === 'delete') {
    confirm.require({
      message: `Delete ${w.collection}/${w.id}? This cannot be undone.`,
      header: 'Delete Document', icon: 'pi pi-exclamation-triangle',
      rejectLabel: 'Cancel', acceptLabel: 'Delete', acceptClass: 'p-button-danger',
      accept: async () => {
        try {
          await deleteDoc(schoolDoc(props.schoolId, w.collection, w.id))
          toast.add({ severity: 'info', summary: 'Deleted', life: 2000 })
          await runScan()
        } catch (e) {
          toast.add({ severity: 'error', summary: 'Error', detail: 'Could not delete', life: 3000 })
        }
      },
    })
  } else if (w.action === 'fix-schema') {
    confirm.require({
      message: 'Regenerate config/students_schema currentClassId options from the live class list?',
      header: 'Fix Schema Options', icon: 'pi pi-wrench',
      rejectLabel: 'Cancel', acceptLabel: 'Fix',
      accept: async () => {
        try {
          const classesSnap = await getDocs(schoolCollection(props.schoolId, 'classes'))
          await regenerateStudentsSchemaClassOptions(props.schoolId, classesSnap.docs.map(d => d.id))
          toast.add({ severity: 'success', summary: 'Fixed', life: 2000 })
          await runScan()
        } catch (e) {
          toast.add({ severity: 'error', summary: 'Error', detail: 'Could not fix', life: 3000 })
        }
      },
    })
  }
}

watch(() => props.schoolId, runScan)
onMounted(runScan)
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
