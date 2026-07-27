<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div class="text-sm font-bold text-slate-900">Remark Categories</div>
      <div class="flex gap-2">
        <Button label="Copy from another school" icon="pi pi-copy" size="small" outlined @click="openCopyDialog" />
        <Button label="Add Category" icon="pi pi-plus" size="small" @click="openAddCategory" />
      </div>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>
    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="categories" size="small" stripedRows>
        <Column field="order" header="#" style="width:50px" />
        <Column field="label" header="Category">
          <template #body="{ data }">
            <div class="font-medium text-sm text-slate-900">{{ data.label }}</div>
            <div class="text-xs text-slate-400">{{ (data.remarks || []).length }} remark(s)</div>
          </template>
        </Column>
        <Column header="" style="width:170px">
          <template #body="{ data, index }">
            <div class="flex gap-1 justify-end">
              <Button icon="pi pi-chevron-up" text rounded size="small" :disabled="index === 0" @click="moveCategory(index, -1)" />
              <Button icon="pi pi-chevron-down" text rounded size="small" :disabled="index === categories.length - 1" @click="moveCategory(index, 1)" />
              <Button label="Remarks" text size="small" @click="openRemarksEditor(data)" />
              <Button icon="pi pi-pencil" text rounded size="small" @click="openEditCategory(data)" />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="confirmDeleteCategory(data)" />
            </div>
          </template>
        </Column>
      </DataTable>
      <div v-if="!categories.length" class="text-center text-sm text-slate-400 py-8">No remark categories yet</div>
    </div>

    <!-- ── Category Dialog ──────────────────────────────────────────────── -->
    <Dialog v-model:visible="categoryDialogVisible" :header="editingCategory ? 'Edit Category' : 'Add Category'" modal :style="{ width: '420px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Label *</label>
          <InputText v-model="categoryForm.label" class="w-full" placeholder="e.g. Discipline" />
        </div>
        <div v-if="categoryFormError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ categoryFormError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="categoryDialogVisible = false" />
        <Button :label="editingCategory ? 'Save Changes' : 'Add Category'" :loading="savingCategory" @click="saveCategory" />
      </template>
    </Dialog>

    <!-- ── Remarks Editor Dialog ────────────────────────────────────────── -->
    <Dialog v-model:visible="remarksDialogVisible" :header="`Remarks — ${activeCategory?.label || ''}`" modal :style="{ width: '560px' }">
      <div class="space-y-3 pt-2">
        <div class="flex items-center justify-between">
          <span class="text-xs text-slate-400">Keys (r1, r2, ...) are permanent once assigned — used as answer keys in teachers' remark sheets.</span>
          <button type="button" class="text-xs text-violet-600 font-semibold whitespace-nowrap ml-2" @click="addRemark">+ Add Remark</button>
        </div>
        <div v-for="(remark, i) in workingRemarks" :key="remark.key" class="grid grid-cols-12 gap-2 items-center">
          <span class="col-span-1 text-xs font-mono text-slate-400">{{ remark.key }}</span>
          <InputText v-model="remark.text" placeholder="Remark text" class="col-span-6 text-sm" />
          <ToggleButton
            :modelValue="remark.type === 'positive'"
            @update:modelValue="v => remark.type = v ? 'positive' : 'negative'"
            onLabel="Positive" offLabel="Negative" size="small" class="col-span-3"
          />
          <div class="col-span-2 flex gap-1 justify-end">
            <Button icon="pi pi-chevron-up" text rounded size="small" :disabled="i === 0" @click="moveRemark(i, -1)" />
            <Button icon="pi pi-chevron-down" text rounded size="small" :disabled="i === workingRemarks.length - 1" @click="moveRemark(i, 1)" />
            <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="removeRemark(i)" />
          </div>
        </div>
        <p v-if="!workingRemarks.length" class="text-xs text-slate-400">No remarks yet — add one above.</p>
        <div v-if="remarksFormError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ remarksFormError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="remarksDialogVisible = false" />
        <Button label="Save Remarks" :loading="savingRemarks" @click="saveRemarks" />
      </template>
    </Dialog>

    <!-- ── Copy From Another School Dialog ──────────────────────────────── -->
    <Dialog v-model:visible="copyDialogVisible" header="Copy Remark Bank" modal :style="{ width: '420px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Source School *</label>
          <Select
            v-model="copySourceId"
            :options="otherSchools"
            optionLabel="name"
            optionValue="id"
            placeholder="Select a school"
            class="w-full"
            filter
          />
        </div>
        <p class="text-xs text-slate-400">
          Copies all categories and remarks from the source school into this one.
          New remark keys are assigned fresh — existing keys here are never changed.
        </p>
        <div v-if="copyError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ copyError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="copyDialogVisible = false" />
        <Button label="Copy" :loading="copying" @click="copyRemarkBank" />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, watch, onMounted } from 'vue'
import {
  getDocs, addDoc, updateDoc, deleteDoc, query, orderBy, serverTimestamp, writeBatch, doc,
} from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import ToggleButton from 'primevue/togglebutton'
import Select from 'primevue/select'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

import { schoolCollection, schoolDoc, rootSchoolsCollection } from '../../firebase/schoolCollections.js'
import { db } from '../../firebase/config'
import { auth } from '../../firebase/config'

const props = defineProps({ schoolId: { type: String, default: null } })
const confirm = useConfirm()
const toast = useToast()

const categories = ref([])
const loading = ref(false)

async function loadCategories() {
  if (!props.schoolId) { categories.value = []; return }
  loading.value = true
  try {
    const snap = await getDocs(query(schoolCollection(props.schoolId, 'remark_categories'), orderBy('order')))
    categories.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load remark categories', e)
    categories.value = []
  } finally {
    loading.value = false
  }
}

// ── Category CRUD ──────────────────────────────────────────────────────────
const categoryDialogVisible = ref(false)
const editingCategory = ref(null)
const savingCategory = ref(false)
const categoryFormError = ref('')
const categoryForm = reactive({ label: '' })

function openAddCategory() {
  editingCategory.value = null
  categoryForm.label = ''
  categoryFormError.value = ''
  categoryDialogVisible.value = true
}

function openEditCategory(cat) {
  editingCategory.value = cat
  categoryForm.label = cat.label || ''
  categoryFormError.value = ''
  categoryDialogVisible.value = true
}

async function saveCategory() {
  if (!categoryForm.label.trim()) { categoryFormError.value = 'Label is required'; return }
  categoryFormError.value = ''
  savingCategory.value = true
  try {
    if (editingCategory.value) {
      await updateDoc(schoolDoc(props.schoolId, 'remark_categories', editingCategory.value.id), {
        label: categoryForm.label.trim(),
        updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
      })
    } else {
      const nextOrder = categories.value.length ? Math.max(...categories.value.map(c => c.order || 0)) + 1 : 1
      await addDoc(schoolCollection(props.schoolId, 'remark_categories'), {
        label: categoryForm.label.trim(), order: nextOrder, remarks: [],
        created_at: serverTimestamp(), created_by: auth.currentUser?.email || 'unknown',
      })
    }
    categoryDialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 })
    await loadCategories()
  } catch (e) {
    categoryFormError.value = 'Something went wrong. Try again.'
  } finally {
    savingCategory.value = false
  }
}

async function moveCategory(i, dir) {
  const j = i + dir
  if (j < 0 || j >= categories.value.length) return
  const a = categories.value[i], b = categories.value[j]
  try {
    const batch = writeBatch(db)
    batch.update(schoolDoc(props.schoolId, 'remark_categories', a.id), { order: b.order })
    batch.update(schoolDoc(props.schoolId, 'remark_categories', b.id), { order: a.order })
    await batch.commit()
    await loadCategories()
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not reorder', life: 3000 })
  }
}

function confirmDeleteCategory(cat) {
  confirm.require({
    message: `Remove category "${cat.label}" and its ${(cat.remarks || []).length} remark(s)? This cannot be undone.`,
    header: 'Remove Category',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Remove', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(schoolDoc(props.schoolId, 'remark_categories', cat.id))
        toast.add({ severity: 'info', summary: 'Removed', life: 2000 })
        await loadCategories()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not remove', life: 3000 })
      }
    },
  })
}

// ── Remarks editor (per category) ──────────────────────────────────────────
const remarksDialogVisible = ref(false)
const activeCategory = ref(null)
const workingRemarks = ref([])
const savingRemarks = ref(false)
const remarksFormError = ref('')

function nextRemarkKey() {
  let max = 0
  categories.value.forEach(c => (c.remarks || []).forEach(r => {
    const m = /^r(\d+)$/.exec(r.key || '')
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }))
  workingRemarks.value.forEach(r => {
    const m = /^r(\d+)$/.exec(r.key || '')
    if (m) max = Math.max(max, parseInt(m[1], 10))
  })
  return `r${max + 1}`
}

function openRemarksEditor(cat) {
  activeCategory.value = cat
  workingRemarks.value = (cat.remarks || []).map(r => ({ ...r }))
  remarksFormError.value = ''
  remarksDialogVisible.value = true
}

function addRemark() {
  const nextOrder = workingRemarks.value.length ? Math.max(...workingRemarks.value.map(r => r.order || 0)) + 1 : 1
  workingRemarks.value.push({ key: nextRemarkKey(), text: '', type: 'positive', order: nextOrder })
}
function removeRemark(i) {
  workingRemarks.value.splice(i, 1)
}
function moveRemark(i, dir) {
  const j = i + dir
  if (j < 0 || j >= workingRemarks.value.length) return
  const [item] = workingRemarks.value.splice(i, 1)
  workingRemarks.value.splice(j, 0, item)
}

async function saveRemarks() {
  if (workingRemarks.value.some(r => !r.text.trim())) {
    remarksFormError.value = 'Every remark needs text'
    return
  }
  remarksFormError.value = ''
  savingRemarks.value = true
  try {
    const remarks = workingRemarks.value.map((r, i) => ({ key: r.key, text: r.text.trim(), type: r.type, order: i + 1 }))
    await updateDoc(schoolDoc(props.schoolId, 'remark_categories', activeCategory.value.id), {
      remarks, updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    })
    remarksDialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 })
    await loadCategories()
  } catch (e) {
    remarksFormError.value = 'Something went wrong. Try again.'
  } finally {
    savingRemarks.value = false
  }
}

// ── Copy remark bank from another school ───────────────────────────────────
const copyDialogVisible = ref(false)
const copySourceId = ref(null)
const copying = ref(false)
const copyError = ref('')
const otherSchools = ref([])

async function openCopyDialog() {
  copyError.value = ''
  copySourceId.value = null
  copyDialogVisible.value = true
  try {
    const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name')))
    otherSchools.value = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(s => s.id !== props.schoolId && s.isActive !== false)
  } catch (e) {
    console.error('Could not load schools', e)
  }
}

async function copyRemarkBank() {
  if (!copySourceId.value) { copyError.value = 'Select a source school'; return }
  copying.value = true
  copyError.value = ''
  try {
    const snap = await getDocs(query(schoolCollection(copySourceId.value, 'remark_categories'), orderBy('order')))
    let nextKeyNum = 0
    categories.value.forEach(c => (c.remarks || []).forEach(r => {
      const m = /^r(\d+)$/.exec(r.key || '')
      if (m) nextKeyNum = Math.max(nextKeyNum, parseInt(m[1], 10))
    }))
    const batch = writeBatch(db)
    let catOrder = categories.value.length ? Math.max(...categories.value.map(c => c.order || 0)) : 0
    snap.docs.forEach(d => {
      const data = d.data()
      catOrder += 1
      const remarks = (data.remarks || []).map((r, i) => {
        nextKeyNum += 1
        return { key: `r${nextKeyNum}`, text: r.text, type: r.type, order: i + 1 }
      })
      const newCatRef = doc(schoolCollection(props.schoolId, 'remark_categories'))
      batch.set(newCatRef, {
        label: data.label, order: catOrder, remarks,
        created_at: serverTimestamp(), created_by: auth.currentUser?.email || 'unknown',
      })
    })
    await batch.commit()
    copyDialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Copied', detail: `${snap.size} categor${snap.size === 1 ? 'y' : 'ies'} copied`, life: 2500 })
    await loadCategories()
  } catch (e) {
    console.error(e)
    copyError.value = 'Something went wrong. Try again.'
  } finally {
    copying.value = false
  }
}

watch(() => props.schoolId, loadCategories)
onMounted(loadCategories)
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
