<template>
  <!-- ── Step-up reauth gate — same pattern as Import.vue/ImportReview.vue -->
  <div v-if="!isElevated" class="flex items-center justify-center py-20">
    <div class="bg-white rounded-xl border border-slate-200 p-6 w-full max-w-sm">
      <div class="flex items-center gap-2 mb-1">
        <i class="pi pi-shield text-slate-400"></i>
        <div class="text-sm font-bold text-slate-900">Confirm your password to continue</div>
      </div>
      <p class="text-xs text-slate-400 mb-4">Import templates control what gets written into School Setup's data — re-enter your password to proceed.</p>
      <Password v-model="password" class="w-full" input-class="w-full" placeholder="Password" :feedback="false" toggleMask @keyup.enter="submitReauth" />
      <div v-if="reauthError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ reauthError }}</div>
      <Button label="Continue" class="w-full mt-4" :loading="reauthing" @click="submitReauth" />
    </div>
  </div>

  <div v-else>
    <div class="flex items-center gap-3 mb-4">
      <Button icon="pi pi-arrow-left" text rounded @click="router.push({ name: 'import' })" />
      <div class="text-sm font-bold text-slate-900">Import Templates</div>
    </div>

    <div class="bg-white rounded-xl border border-slate-200 p-4 mb-4 text-xs text-slate-500">
      Students, Teachers, Subjects and Assessments are built-in and always available — this page is for
      <b>additional</b> entities (e.g. Remarks) you want to import through the same upload → extract → review →
      commit pipeline. A column's <b>key</b> must be the exact Firestore field name to write — it is never
      auto-generated or guessed.
    </div>

    <div v-if="loading" class="flex items-center justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>
    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden mb-4">
      <div class="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
        <div class="text-sm font-bold text-slate-900">Custom Templates</div>
        <Button label="New Template" icon="pi pi-plus" size="small" @click="openCreateDialog" />
      </div>
      <DataTable :value="templates" size="small" stripedRows>
        <Column field="name" header="Name">
          <template #body="{ data }">
            <div class="font-medium text-sm text-slate-900">{{ data.name }}</div>
            <div class="text-xs text-slate-400">{{ data.description }}</div>
          </template>
        </Column>
        <Column header="Target Collection" style="width:220px">
          <template #body="{ data }"><span class="font-mono text-xs text-slate-600">schools/&#123;schoolId&#125;/{{ data.targetCollectionName }}</span></template>
        </Column>
        <Column header="Columns" style="width:100px">
          <template #body="{ data }">{{ (data.columns || []).length }}</template>
        </Column>
        <Column header="Status" style="width:100px">
          <template #body="{ data }">
            <span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="data.status === 'archived' ? 'bg-slate-100 text-slate-500' : 'bg-green-50 text-green-700'">{{ data.status }}</span>
          </template>
        </Column>
        <Column header="" style="width:180px">
          <template #body="{ data }">
            <div class="flex gap-1">
              <Button label="Edit" size="small" text @click="openEditDialog(data)" />
              <Button label="Download Sample" size="small" text @click="downloadSample(data)" />
              <Button icon="pi pi-trash" size="small" text severity="danger" @click="confirmDelete(data)" />
            </div>
          </template>
        </Column>
      </DataTable>
      <div v-if="!templates.length" class="text-center text-sm text-slate-400 py-10">No custom templates yet</div>
    </div>

    <!-- ── Create/Edit dialog ───────────────────────────────────────────── -->
    <Dialog v-model:visible="editDialogVisible" :header="editing?.isNew ? 'New Template' : `Edit — ${editing?.name || ''}`" modal :style="{ width: '640px' }">
      <div v-if="editing" class="space-y-4 pt-2">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="form-label">Template ID (slug) *</label>
            <InputText v-model="editing.slug" class="w-full" :disabled="!editing.isNew" placeholder="e.g. remarks" />
            <p class="text-[11px] text-slate-400 mt-1">Lowercase letters/digits/underscore. Cannot be changed after creation.</p>
          </div>
          <div>
            <label class="form-label">Name *</label>
            <InputText v-model="editing.name" class="w-full" placeholder="e.g. Remarks" />
          </div>
        </div>
        <div>
          <label class="form-label">Description</label>
          <InputText v-model="editing.description" class="w-full" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="form-label">Target Collection Name *</label>
            <InputText v-model="editing.targetCollectionName" class="w-full" placeholder="e.g. remark_entries" />
            <p class="text-[11px] text-slate-400 mt-1">Written to schools/&#123;schoolId&#125;/&#123;this&#125;/&#123;docId&#125;</p>
          </div>
          <div>
            <label class="form-label">Key Field (for update-matching)</label>
            <Select v-model="editing.keyField" :options="keyFieldOptions" showClear placeholder="always create new" class="w-full" />
          </div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-1.5">
            <label class="form-label mb-0">Columns *</label>
            <Button label="Add Column" icon="pi pi-plus" size="small" text @click="addColumn" />
          </div>
          <div class="space-y-2">
            <div v-for="(col, i) in editing.columns" :key="i" class="grid grid-cols-12 gap-1.5 items-center">
              <InputText v-model="col.key" placeholder="field_key" class="col-span-3" size="small" />
              <InputText v-model="col.label" placeholder="Label" class="col-span-3" size="small" />
              <InputText v-model="col.notes" placeholder="extraction hint (optional)" class="col-span-3" size="small" />
              <label class="col-span-1 flex items-center gap-1 text-xs"><Checkbox v-model="col.required" binary />Req</label>
              <label class="col-span-1 flex items-center gap-1 text-xs"><Checkbox v-model="col.essential" binary />Key</label>
              <Button icon="pi pi-times" text size="small" class="col-span-1" @click="editing.columns.splice(i, 1)" />
            </div>
          </div>
          <p class="text-[11px] text-slate-400 mt-1">Key = the exact Firestore field name to write. Label = what reviewers see. "Req" flags a missing value as an error. "Key" marks it as one of the always-shown columns in review.</p>
        </div>

        <div>
          <label class="form-label">Extraction Hints (for scanned/unstructured uploads only)</label>
          <Textarea v-model="editing.extractionHints" class="w-full" rows="2" placeholder="e.g. Dates as YYYY-MM-DD. ..." />
          <p class="text-[11px] text-slate-400 mt-1">
            A well-formed CSV/XLSX is matched deterministically by header and never reaches the LLM — this only
            matters for scanned PDFs/images with no readable header row.
          </p>
        </div>

        <div class="flex items-center gap-2">
          <Checkbox v-model="editing.archived" binary inputId="archived" />
          <label for="archived" class="text-sm text-slate-600">Archived (hidden from the Import dropdown, existing jobs keep working)</label>
        </div>

        <div v-if="saveError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ saveError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="editDialogVisible = false" />
        <Button label="Save" :loading="saving" @click="saveTemplate" />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Password from 'primevue/password'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import Checkbox from 'primevue/checkbox'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

import { useStepUpAuth } from '../composables/useStepUpAuth.js'
import { listImportTemplatesRemote, saveImportTemplateRemote, deleteImportTemplateRemote } from '../utils/api.js'
import { downloadCsv } from '../utils/importTemplates.js'

const router = useRouter()
const confirm = useConfirm()
const toast = useToast()

const { isElevated, reauthenticate } = useStepUpAuth()
const password = ref('')
const reauthing = ref(false)
const reauthError = ref('')

async function submitReauth() {
  if (!password.value) { reauthError.value = 'Enter your password'; return }
  reauthError.value = ''
  reauthing.value = true
  try {
    await reauthenticate(password.value)
    password.value = ''
  } catch (e) {
    reauthError.value = e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential'
      ? 'Incorrect password'
      : (e.message || 'Could not verify your password')
  } finally {
    reauthing.value = false
  }
}

const templates = ref([])
const loading = ref(false)

async function loadTemplates() {
  loading.value = true
  try {
    templates.value = await listImportTemplatesRemote({ includeArchived: true })
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not load templates', detail: e.message, life: 4000 })
  } finally {
    loading.value = false
  }
}

const editDialogVisible = ref(false)
const editing = ref(null)
const saving = ref(false)
const saveError = ref('')

const keyFieldOptions = computed(() => (editing.value?.columns || []).map(c => c.key).filter(Boolean))

function openCreateDialog() {
  editing.value = {
    isNew: true, slug: '', name: '', description: '', targetCollectionName: '',
    keyField: null, columns: [{ key: '', label: '', notes: '', required: false, essential: true }],
    extractionHints: '', archived: false,
  }
  saveError.value = ''
  editDialogVisible.value = true
}

function openEditDialog(tpl) {
  editing.value = {
    isNew: false, slug: tpl.slug, name: tpl.name, description: tpl.description || '',
    targetCollectionName: tpl.targetCollectionName, keyField: tpl.keyField || null,
    columns: (tpl.columns || []).map(c => ({ ...c })),
    extractionHints: tpl.extractionHints || '', archived: tpl.status === 'archived',
  }
  saveError.value = ''
  editDialogVisible.value = true
}

function addColumn() {
  editing.value.columns.push({ key: '', label: '', notes: '', required: false, essential: false })
}

async function saveTemplate() {
  saveError.value = ''
  saving.value = true
  try {
    await saveImportTemplateRemote({
      slug: editing.value.slug,
      name: editing.value.name,
      description: editing.value.description,
      targetCollectionName: editing.value.targetCollectionName,
      keyField: editing.value.keyField || '',
      columns: editing.value.columns,
      extractionHints: editing.value.extractionHints,
      status: editing.value.archived ? 'archived' : 'active',
    })
    editDialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Template saved', life: 2500 })
    await loadTemplates()
  } catch (e) {
    saveError.value = e.message || 'Could not save template'
  } finally {
    saving.value = false
  }
}

function confirmDelete(tpl) {
  confirm.require({
    message: `Delete the "${tpl.name}" template? Existing staged imports created from it are unaffected but can no longer be re-processed.`,
    header: 'Delete Template',
    icon: 'pi pi-exclamation-triangle',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteImportTemplateRemote({ slug: tpl.slug })
        toast.add({ severity: 'success', summary: 'Template deleted', life: 2500 })
        await loadTemplates()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Could not delete', detail: e.message, life: 4000 })
      }
    },
  })
}

function downloadSample(tpl) {
  const header = (tpl.columns || []).map(c => c.label || c.key)
  const csv = [header.join(',')].join('\n')
  downloadCsv(`${tpl.slug || 'template'}_sample.csv`, csv)
}

onMounted(loadTemplates)
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
