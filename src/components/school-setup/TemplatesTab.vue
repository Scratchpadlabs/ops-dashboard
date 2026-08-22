<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div class="text-sm font-bold text-slate-900">Config Templates</div>
      <Button label="Save Current School As Template" icon="pi pi-save" size="small" :disabled="!schoolId" @click="openSaveDialog" />
    </div>

    <div v-if="loading" class="flex items-center justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>
    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="templates" size="small" stripedRows>
        <Column field="name" header="Name">
          <template #body="{ data }">
            <div class="font-medium text-sm text-slate-900">{{ data.name }}</div>
            <div class="text-xs text-slate-400">{{ data.description }}</div>
          </template>
        </Column>
        <Column header="Counts">
          <template #body="{ data }">
            <div class="flex flex-wrap gap-1">
              <span v-for="sec in SECTIONS" :key="sec.key" class="text-xs text-slate-500">{{ sec.label }}: {{ data.counts?.[sec.key] || 0 }}</span>
            </div>
          </template>
        </Column>
        <Column field="created_by" header="Created By" style="width:180px" />
        <Column header="" style="width:100px">
          <template #body="{ data }">
            <Button label="Apply" size="small" text @click="openApplyDialog(data)" />
          </template>
        </Column>
      </DataTable>
      <div v-if="!templates.length" class="text-center text-sm text-slate-400 py-8">No templates saved yet</div>
    </div>

    <!-- ── Save Dialog ──────────────────────────────────────────────────── -->
    <Dialog v-model:visible="saveDialogVisible" header="Save Current School As Template" modal :style="{ width: '460px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Name *</label>
          <InputText v-model="saveForm.name" class="w-full" placeholder="e.g. Standard Foundation Setup" />
        </div>
        <div>
          <label class="form-label">Description</label>
          <Textarea v-model="saveForm.description" class="w-full" rows="2" />
        </div>
        <p class="text-xs text-slate-400">Snapshots terms, grading scales, assessments, co-scholastic activities, remark categories, and months from the currently selected school.</p>
        <div v-if="saveError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ saveError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="saveDialogVisible = false" />
        <Button label="Save Template" :loading="saving" @click="saveTemplate" />
      </template>
    </Dialog>

    <!-- ── Apply Dialog ─────────────────────────────────────────────────── -->
    <Dialog v-model:visible="applyDialogVisible" :header="`Apply Template — ${applyingTemplate?.name || ''}`" modal :style="{ width: '480px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Target School *</label>
          <Select v-model="applyForm.targetSchoolId" :options="allSchools" optionLabel="name" optionValue="id" class="w-full" filter />
        </div>
        <div>
          <label class="form-label mb-2 block">Sections</label>
          <div class="grid grid-cols-2 gap-1.5">
            <label v-for="sec in SECTIONS" :key="sec.key" class="flex items-center gap-2 text-sm">
              <Checkbox v-model="applyForm.sections" :value="sec.key" />
              {{ sec.label }} ({{ applyingTemplate?.counts?.[sec.key] || 0 }})
            </label>
          </div>
        </div>
        <div>
          <label class="form-label mb-2 block">If a doc already exists at the target</label>
          <div class="flex gap-4">
            <label class="flex items-center gap-2 text-sm"><RadioButton v-model="applyForm.strategy" value="skip" />Skip it (keep target's version)</label>
            <label class="flex items-center gap-2 text-sm"><RadioButton v-model="applyForm.strategy" value="overwrite" />Overwrite with template's version</label>
          </div>
        </div>
        <div v-if="applyProgress.message" class="text-sm text-slate-500">{{ applyProgress.message }}</div>
        <div v-if="applyError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ applyError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="applyDialogVisible = false" />
        <Button label="Apply Template" :loading="applying" @click="confirmApply" />
      </template>
    </Dialog>

  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { getDocs, addDoc, query, orderBy, writeBatch, serverTimestamp } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import Checkbox from 'primevue/checkbox'
import RadioButton from 'primevue/radiobutton'
import ProgressSpinner from 'primevue/progressspinner'

import { schoolCollection, schoolDoc, rootSchoolsCollection, configTemplatesCollection } from '../../firebase/schoolCollections.js'
import { db } from '../../firebase/config'
import { auth } from '../../firebase/config'

const props = defineProps({ schoolId: { type: String, default: null } })
const confirm = useConfirm()
const toast = useToast()

const SECTIONS = [
  { key: 'terms', label: 'Terms' },
  { key: 'grading_scales', label: 'Grading Scales' },
  { key: 'assessments', label: 'Assessments' },
  { key: 'co_scholastic_activities', label: 'Co-Scholastic' },
  { key: 'remark_categories', label: 'Remarks' },
  { key: 'months', label: 'Months' },
]

const templates = ref([])
const loading = ref(false)
const allSchools = ref([])

async function loadTemplates() {
  loading.value = true
  try {
    const snap = await getDocs(query(configTemplatesCollection(), orderBy('name')))
    templates.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load templates', e)
    templates.value = []
  } finally {
    loading.value = false
  }
}

async function loadSchools() {
  try {
    const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name')))
    allSchools.value = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.isActive !== false)
  } catch (e) {
    console.error('Could not load schools', e)
  }
}

// ── Save current school as template ─────────────────────────────────────
const saveDialogVisible = ref(false)
const saveForm = reactive({ name: '', description: '' })
const saveError = ref('')
const saving = ref(false)

function openSaveDialog() {
  saveForm.name = ''
  saveForm.description = ''
  saveError.value = ''
  saveDialogVisible.value = true
}

async function saveTemplate() {
  if (!saveForm.name.trim()) { saveError.value = 'Name is required'; return }
  saveError.value = ''
  saving.value = true
  try {
    const payload = { name: saveForm.name.trim(), description: saveForm.description.trim(), counts: {} }
    for (const sec of SECTIONS) {
      const snap = await getDocs(schoolCollection(props.schoolId, sec.key))
      payload[sec.key] = snap.docs.map(d => ({ _id: d.id, ...d.data() }))
      payload.counts[sec.key] = payload[sec.key].length
    }
    payload.created_at = serverTimestamp()
    payload.created_by = auth.currentUser?.email || 'unknown'
    await addDoc(configTemplatesCollection(), payload)
    saveDialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Template saved', life: 2500 })
    await loadTemplates()
  } catch (e) {
    console.error(e)
    saveError.value = e.message?.includes('longer than') || e.code === 'invalid-argument'
      ? 'This snapshot is too large for a single document. Reduce scope or ask for the subcollection fallback to be built.'
      : 'Something went wrong. Try again.'
  } finally {
    saving.value = false
  }
}

// ── Apply template to a school ───────────────────────────────────────────
const applyDialogVisible = ref(false)
const applyingTemplate = ref(null)
const applyForm = reactive({ targetSchoolId: null, sections: SECTIONS.map(s => s.key), strategy: 'skip' })
const applyError = ref('')
const applying = ref(false)
const applyProgress = reactive({ message: '' })

function openApplyDialog(template) {
  applyingTemplate.value = template
  Object.assign(applyForm, { targetSchoolId: null, sections: SECTIONS.map(s => s.key), strategy: 'skip' })
  applyError.value = ''
  applyProgress.message = ''
  applyDialogVisible.value = true
}

function confirmApply() {
  if (!applyForm.targetSchoolId) { applyError.value = 'Select a target school'; return }
  if (!applyForm.sections.length) { applyError.value = 'Select at least one section'; return }
  applyError.value = ''
  confirm.require({
    message: `Apply "${applyingTemplate.value.name}" to "${applyForm.targetSchoolId}"? Strategy: ${applyForm.strategy === 'skip' ? 'skip existing docs' : 'overwrite existing docs'}.`,
    header: 'Apply Template', icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Apply',
    accept: runApply,
  })
}

async function runApply() {
  applying.value = true
  applyProgress.message = 'Reading target school data...'
  try {
    const ops = []
    for (const key of applyForm.sections) {
      const items = applyingTemplate.value[key] || []
      if (!items.length) continue
      let existingIds = new Set()
      if (applyForm.strategy === 'skip') {
        const existingSnap = await getDocs(schoolCollection(applyForm.targetSchoolId, key))
        existingIds = new Set(existingSnap.docs.map(d => d.id))
      }
      items.forEach(item => {
        if (applyForm.strategy === 'skip' && existingIds.has(item._id)) return
        const { _id, ...data } = item
        ops.push({ ref: schoolDoc(applyForm.targetSchoolId, key, _id), data })
      })
    }

    applyProgress.message = `Writing ${ops.length} doc(s)...`
    let done = 0
    for (let i = 0; i < ops.length; i += 450) {
      const chunk = ops.slice(i, i + 450)
      const batch = writeBatch(db)
      chunk.forEach(op => batch.set(op.ref, {
        ...op.data, updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
      }, { merge: applyForm.strategy === 'skip' }))
      await batch.commit()
      done += chunk.length
      applyProgress.message = `Wrote ${done}/${ops.length} doc(s)...`
    }
    applyProgress.message = `Done — ${done} doc(s) applied to "${applyForm.targetSchoolId}".`
    toast.add({ severity: 'success', summary: 'Template applied', life: 3000 })
  } catch (e) {
    console.error(e)
    applyError.value = 'Something went wrong while applying. Some docs may have been written.'
  } finally {
    applying.value = false
  }
}

onMounted(() => { loadTemplates(); loadSchools() })
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
