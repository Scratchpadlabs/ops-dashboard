<template>
  <div>
    <div class="bg-white rounded-xl border border-slate-200 p-5 mb-5">
      <div class="text-sm font-bold text-slate-900 mb-1">Manage Fields</div>
      <p class="text-xs text-slate-400 mb-4">
        Fields registered here are recognized by the next Student/Teacher import — a matching CSV column is read,
        type-checked, and written onto the matched record (matched by ID) without any code change.
      </p>

      <div class="flex gap-2 mb-4">
        <button
          v-for="k in KINDS" :key="k.value" type="button"
          class="px-3 py-1.5 rounded-lg text-sm font-semibold"
          :class="kind === k.value ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'"
          @click="kind = k.value"
        >{{ k.label }}</button>
        <div class="flex-1"></div>
        <Button label="Add Field" icon="pi pi-plus" size="small" @click="openAdd" />
      </div>

      <DataTable :value="fields" size="small" stripedRows :loading="loading">
        <Column field="label" header="Label" />
        <Column field="key" header="Key"><template #body="{ data }"><span class="font-mono text-xs">{{ data.key }}</span></template></Column>
        <Column header="Type"><template #body="{ data }">{{ FIELD_TYPE_LABELS[data.type] || data.type }}</template></Column>
        <Column header="Options"><template #body="{ data }">
          <span v-if="data.type === 'enum'" class="text-xs text-slate-500">{{ (data.enumValues || []).join(', ') }}</span>
        </template></Column>
        <Column header="CSV header aliases"><template #body="{ data }">
          <span class="text-xs text-slate-500">{{ (data.aliases || []).join(', ') || '—' }}</span>
        </template></Column>
        <Column header="" style="width:110px"><template #body="{ data }">
          <div class="flex gap-2 justify-end">
            <button type="button" class="text-slate-400 hover:text-slate-700" @click="openEdit(data)"><i class="pi pi-pencil"></i></button>
            <button type="button" class="text-slate-400 hover:text-red-500" @click="confirmDeactivate(data)"><i class="pi pi-trash"></i></button>
          </div>
        </template></Column>
      </DataTable>
      <div v-if="!loading && !fields.length" class="text-center text-sm text-slate-400 py-10">
        No {{ kind }} fields registered yet.
      </div>
    </div>

    <!-- ── Add/Edit Dialog ──────────────────────────────────────────────── -->
    <Dialog v-model:visible="dialogVisible" :header="editingId ? 'Edit Field' : 'Add Field'" modal :style="{ width: '520px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Label *</label>
          <InputText v-model="form.label" class="w-full" placeholder="e.g. Blood Group" @update:modelValue="onLabelInput" />
        </div>
        <div>
          <label class="form-label">Key *</label>
          <InputText v-model="form.key" class="w-full font-mono text-sm" :disabled="!!editingId" @update:modelValue="onKeyInput" />
          <p class="text-xs mt-1" :class="keyError ? 'text-red-500' : 'text-slate-400'">
            {{ keyError || 'The Firestore field name this writes to — camelCase, locked after first save.' }}
          </p>
        </div>
        <div>
          <label class="form-label">Type *</label>
          <Select
            v-model="form.type" :options="typeOptions" optionLabel="label" optionValue="value"
            class="w-full" :disabled="!!editingId"
          />
          <p class="text-xs text-slate-400 mt-1" v-if="editingId">Type is locked after first save — existing data was written under the old type.</p>
        </div>
        <div v-if="form.type === 'enum'">
          <label class="form-label">Choices (comma-separated) *</label>
          <InputText v-model="enumValuesText" class="w-full" placeholder="A+, A-, B+, B-, O+, O-" />
        </div>
        <div>
          <label class="form-label">CSV header aliases (comma-separated)</label>
          <InputText v-model="aliasesText" class="w-full" placeholder="blood group, bg, blood grp" />
          <p class="text-xs text-slate-400 mt-1">Any of these column headers in an import file will map to this field.</p>
        </div>
        <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="dialogVisible = false" />
        <Button label="Save" :loading="saving" @click="save" />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import ConfirmDialog from 'primevue/confirmdialog'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import {
  FIELD_TYPES, FIELD_TYPE_LABELS, listenFieldDefs, saveFieldDef, deactivateFieldDef, validateFieldKey,
} from '../composables/useFieldSchema.js'

const confirm = useConfirm()
const toast = useToast()

const KINDS = [{ value: 'student', label: 'Students' }, { value: 'staff', label: 'Teachers / Staff' }]
const typeOptions = FIELD_TYPES.map(t => ({ value: t, label: FIELD_TYPE_LABELS[t] }))
const kind = ref('student')
const fields = ref([])
const loading = ref(true)
let unsub = null

function subscribe() {
  unsub?.()
  loading.value = true
  unsub = listenFieldDefs(kind.value, (list) => { fields.value = list; loading.value = false })
}
watch(kind, subscribe)
onMounted(subscribe)
onUnmounted(() => unsub?.())

// ── Add/Edit form ────────────────────────────────────────────────────────
const dialogVisible = ref(false)
const editingId = ref(null)
const form = ref({ label: '', key: '', type: 'string' })
const enumValuesText = ref('')
const aliasesText = ref('')
const keyError = ref('')
const formError = ref('')
const saving = ref(false)

function slugify(label) {
  const words = String(label || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return ''
  return words[0].toLowerCase() + words.slice(1).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('')
}

let keyEditedManually = false
function onLabelInput() {
  if (!editingId.value && !keyEditedManually) form.value.key = slugify(form.value.label)
  checkKey()
}
function onKeyInput() {
  keyEditedManually = true
  checkKey()
}
function checkKey() {
  const others = fields.value.filter(f => f.id !== editingId.value).map(f => f.key)
  const result = validateFieldKey(form.value.key, kind.value, others)
  keyError.value = form.value.key && !result.ok ? result.message : ''
}

function openAdd() {
  editingId.value = null
  keyEditedManually = false
  form.value = { label: '', key: '', type: 'string' }
  enumValuesText.value = ''
  aliasesText.value = ''
  keyError.value = ''
  formError.value = ''
  dialogVisible.value = true
}
function openEdit(data) {
  editingId.value = data.id
  keyEditedManually = true
  form.value = { label: data.label, key: data.key, type: data.type }
  enumValuesText.value = (data.enumValues || []).join(', ')
  aliasesText.value = (data.aliases || []).join(', ')
  keyError.value = ''
  formError.value = ''
  dialogVisible.value = true
}

const parsedList = (text) => text.split(',').map(s => s.trim()).filter(Boolean)

async function save() {
  formError.value = ''
  if (!form.value.label.trim()) { formError.value = 'Label is required.'; return }
  checkKey()
  if (keyError.value) { formError.value = keyError.value; return }
  if (form.value.type === 'enum' && !parsedList(enumValuesText.value).length) {
    formError.value = 'Add at least one choice for a Choice list field.'
    return
  }
  saving.value = true
  try {
    await saveFieldDef({
      kind: kind.value,
      key: form.value.key,
      label: form.value.label.trim(),
      type: form.value.type,
      enumValues: parsedList(enumValuesText.value),
      aliases: parsedList(aliasesText.value),
      isNew: !editingId.value,
    })
    toast.add({ severity: 'success', summary: 'Field saved', life: 2000 })
    dialogVisible.value = false
  } catch (e) {
    console.error('Save field failed', e)
    formError.value = e.message || 'Could not save — try again.'
  } finally {
    saving.value = false
  }
}

function confirmDeactivate(data) {
  confirm.require({
    message: `Remove "${data.label}" from active fields? Existing data under this field is kept on documents — this only stops import from recognizing new columns for it.`,
    header: 'Deactivate Field', icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Deactivate',
    accept: async () => {
      try {
        await deactivateFieldDef(data.id)
        toast.add({ severity: 'success', summary: 'Field deactivated', life: 2000 })
      } catch (e) {
        console.error('Deactivate field failed', e)
        toast.add({ severity: 'error', summary: 'Could not deactivate', detail: e.message, life: 4000 })
      }
    },
  })
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
