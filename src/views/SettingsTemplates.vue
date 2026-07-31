<template>
  <div>
    <div class="flex items-center justify-between mb-5">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">Templates</h2>
        <p class="text-sm text-slate-500 mt-0.5">Manage School Setup templates and bundles — save/apply them from within School Setup itself.</p>
      </div>
      <RouterLink :to="{ name: 'settings' }" class="text-sm text-slate-400 hover:text-slate-600">&larr; Settings</RouterLink>
    </div>

    <Tabs value="templates">
      <TabList>
        <Tab value="templates">Templates</Tab>
        <Tab value="bundles">Bundles</Tab>
      </TabList>
      <TabPanels>

        <!-- ── Templates ────────────────────────────────────────────────── -->
        <TabPanel value="templates">
          <div class="pt-4">
            <div class="flex items-center justify-between mb-3">
              <Select
                v-model="sectionFilter"
                :options="sectionFilterOptions"
                optionLabel="label"
                optionValue="value"
                class="w-56"
              />
            </div>

            <div v-if="loadingTemplates" class="flex items-center justify-center py-10">
              <ProgressSpinner style="width:28px;height:28px" />
            </div>
            <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <DataTable :value="filteredTemplates" size="small" stripedRows>
                <Column field="name" header="Name">
                  <template #body="{ data }">
                    <div class="font-medium text-sm text-slate-900">{{ data.name }}</div>
                    <div class="text-xs text-slate-400">{{ data.description }}</div>
                  </template>
                </Column>
                <Column header="Section" style="width:180px">
                  <template #body="{ data }">
                    <span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">{{ sectionLabel(data.section_type) }}</span>
                  </template>
                </Column>
                <Column header="Items" style="width:80px">
                  <template #body="{ data }">{{ data.item_count ?? (data.payload || []).length }}</template>
                </Column>
                <Column header="From School" style="width:160px">
                  <template #body="{ data }">
                    <span class="text-xs text-slate-500">{{ data.created_from_school || '—' }}</span>
                  </template>
                </Column>
                <Column header="" style="width:170px">
                  <template #body="{ data }">
                    <div class="flex gap-1 justify-end">
                      <Button icon="pi pi-pencil" text rounded size="small" v-tooltip.top="'Rename / edit description'" @click="openEdit(data)" />
                      <Button icon="pi pi-refresh" text rounded size="small" v-tooltip.top="'Update from a school'" @click="openUpdateFromSchool(data)" />
                      <Button icon="pi pi-trash" text rounded size="small" severity="danger" v-tooltip.top="'Delete'" @click="confirmDelete(data)" />
                    </div>
                  </template>
                </Column>
              </DataTable>
              <div v-if="!filteredTemplates.length" class="text-center text-sm text-slate-400 py-10">No templates{{ sectionFilter ? ' for this section' : '' }} yet</div>
            </div>
          </div>
        </TabPanel>

        <!-- ── Bundles ──────────────────────────────────────────────────── -->
        <TabPanel value="bundles">
          <div class="pt-4">
            <div class="flex items-center justify-between mb-3">
              <div class="text-sm font-bold text-slate-900">Bundles</div>
              <Button label="Create Bundle" icon="pi pi-plus" size="small" @click="openCreateBundle" />
            </div>

            <div v-if="loadingBundles" class="flex items-center justify-center py-10">
              <ProgressSpinner style="width:28px;height:28px" />
            </div>
            <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <DataTable :value="bundles" size="small" stripedRows>
                <Column field="name" header="Name">
                  <template #body="{ data }">
                    <div class="font-medium text-sm text-slate-900">{{ data.name }}</div>
                    <div class="text-xs text-slate-400">{{ data.description }}</div>
                  </template>
                </Column>
                <Column header="Templates">
                  <template #body="{ data }">
                    <div class="flex flex-wrap gap-1">
                      <span v-for="id in data.template_ids || []" :key="id" class="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600">
                        {{ templateNameById(id) }}
                      </span>
                    </div>
                  </template>
                </Column>
                <Column header="" style="width:80px">
                  <template #body="{ data }">
                    <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="confirmDeleteBundle(data)" />
                  </template>
                </Column>
              </DataTable>
              <div v-if="!bundles.length" class="text-center text-sm text-slate-400 py-10">No bundles yet</div>
            </div>
          </div>
        </TabPanel>

      </TabPanels>
    </Tabs>

    <!-- ── Edit template (rename / description) ────────────────────────── -->
    <Dialog v-model:visible="editVisible" header="Edit Template" modal style="width: 420px">
      <div v-if="editingTemplate" class="space-y-3 pt-1">
        <div>
          <label class="form-label">Name *</label>
          <InputText v-model="editForm.name" class="w-full" />
        </div>
        <div>
          <label class="form-label">Description</label>
          <Textarea v-model="editForm.description" class="w-full" rows="2" />
        </div>
        <div v-if="editError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ editError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="editVisible = false" />
        <Button label="Save" :loading="saving" @click="saveEdit" />
      </template>
    </Dialog>

    <!-- ── Update from school ───────────────────────────────────────────── -->
    <Dialog v-model:visible="updateFromSchoolVisible" header="Update Template From School" modal style="width: 440px">
      <div v-if="editingTemplate" class="space-y-3 pt-1">
        <p class="text-xs text-slate-400">
          Re-captures "{{ editingTemplate.name }}" ({{ sectionLabel(editingTemplate.section_type) }}) from the chosen
          school's current configuration, replacing the saved payload.
        </p>
        <Select v-model="updateFromSchoolId" :options="allSchools" optionLabel="name" optionValue="id" placeholder="Select a school" class="w-full" filter />
        <div v-if="updateError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ updateError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="updateFromSchoolVisible = false" />
        <Button label="Update" :loading="updating" :disabled="!updateFromSchoolId" @click="doUpdateFromSchool" />
      </template>
    </Dialog>

    <!-- ── Create bundle ────────────────────────────────────────────────── -->
    <Dialog v-model:visible="createBundleVisible" header="Create Bundle" modal style="width: 480px">
      <div class="space-y-3 pt-1">
        <div>
          <label class="form-label">Name *</label>
          <InputText v-model="bundleForm.name" class="w-full" placeholder="e.g. CBSE Primary" />
        </div>
        <div>
          <label class="form-label">Description</label>
          <Textarea v-model="bundleForm.description" class="w-full" rows="2" />
        </div>
        <div>
          <label class="form-label mb-2 block">Templates *</label>
          <MultiSelect
            v-model="bundleForm.templateIds"
            :options="allTemplates"
            optionLabel="name"
            optionValue="id"
            filter
            class="w-full"
            placeholder="Select templates"
            display="chip"
          >
            <template #option="{ option }">
              <span>{{ option.name }}</span>
              <span class="text-xs text-slate-400 ml-1.5">({{ sectionLabel(option.section_type) }})</span>
            </template>
          </MultiSelect>
        </div>
        <div v-if="bundleError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ bundleError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="createBundleVisible = false" />
        <Button label="Create Bundle" :loading="creatingBundle" @click="doCreateBundle" />
      </template>
    </Dialog>

    <ConfirmDialog group="settings-templates" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import { getDocs, query, orderBy, limit } from 'firebase/firestore'

import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import TabPanels from 'primevue/tabpanels'
import TabPanel from 'primevue/tabpanel'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

import { rootSchoolsCollection } from '../firebase/schoolCollections.js'
import { SETUP_SECTIONS } from '../utils/setupTemplates.js'
import {
  listAllTemplates, renameTemplate, updateTemplateDescription, updateTemplateFromSchool,
  bundlesReferencingTemplate, softDeleteTemplate, sectionLabel,
  listBundles, createBundle, deleteBundle,
} from '../composables/useSetupTemplates.js'

const confirm = useConfirm()
const toast = useToast()

const sectionFilterOptions = [{ label: 'All Sections', value: null }, ...SETUP_SECTIONS.map(s => ({ label: s.label, value: s.type }))]
const sectionFilter = ref(null)

// ── Templates list ───────────────────────────────────────────────────────
const loadingTemplates = ref(false)
const allTemplates = ref([])
const filteredTemplates = computed(() => sectionFilter.value
  ? allTemplates.value.filter(t => t.section_type === sectionFilter.value)
  : allTemplates.value)

async function loadTemplates() {
  loadingTemplates.value = true
  try {
    allTemplates.value = await listAllTemplates()
  } catch (e) {
    console.error(e)
  } finally {
    loadingTemplates.value = false
  }
}

// ── Edit (rename / description) ─────────────────────────────────────────
const editVisible = ref(false)
const editingTemplate = ref(null)
const editForm = reactive({ name: '', description: '' })
const editError = ref('')
const saving = ref(false)

function openEdit(template) {
  editingTemplate.value = template
  editForm.name = template.name
  editForm.description = template.description || ''
  editError.value = ''
  editVisible.value = true
}

async function saveEdit() {
  if (!editForm.name.trim()) { editError.value = 'Name is required'; return }
  saving.value = true
  try {
    await renameTemplate(editingTemplate.value.id, editForm.name)
    await updateTemplateDescription(editingTemplate.value.id, editForm.description)
    editVisible.value = false
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 })
    await loadTemplates()
  } catch (e) {
    console.error(e)
    editError.value = 'Something went wrong. Try again.'
  } finally {
    saving.value = false
  }
}

// ── Update from school ───────────────────────────────────────────────────
const updateFromSchoolVisible = ref(false)
const updateFromSchoolId = ref(null)
const updateError = ref('')
const updating = ref(false)
const allSchools = ref([])

async function loadSchools() {
  const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name'), limit(500)))
  allSchools.value = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.isActive !== false)
}

function openUpdateFromSchool(template) {
  editingTemplate.value = template
  updateFromSchoolId.value = template.created_from_school || null
  updateError.value = ''
  updateFromSchoolVisible.value = true
}

async function doUpdateFromSchool() {
  updating.value = true
  updateError.value = ''
  try {
    await updateTemplateFromSchool(editingTemplate.value, updateFromSchoolId.value)
    updateFromSchoolVisible.value = false
    toast.add({ severity: 'success', summary: 'Template updated', life: 2500 })
    await loadTemplates()
  } catch (e) {
    console.error(e)
    updateError.value = 'Something went wrong. Try again.'
  } finally {
    updating.value = false
  }
}

// ── Delete (soft) — warns if a bundle references this template ──────────
async function confirmDelete(template) {
  const referencingBundles = await bundlesReferencingTemplate(template.id)
  const message = referencingBundles.length
    ? `"${template.name}" is used by ${referencingBundles.length} bundle(s): ${referencingBundles.map(b => b.name).join(', ')}. Deleting it will leave those bundles with a broken reference. Delete anyway?`
    : `Delete template "${template.name}"? This can't be undone.`
  confirm.require({
    group: 'settings-templates',
    message, header: 'Delete Template', icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Delete', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await softDeleteTemplate(template.id)
        toast.add({ severity: 'info', summary: 'Deleted', life: 2000 })
        await loadTemplates()
      } catch (e) {
        console.error(e)
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not delete', life: 3000 })
      }
    },
  })
}

// ── Bundles ──────────────────────────────────────────────────────────────
const loadingBundles = ref(false)
const bundles = ref([])

async function loadBundles() {
  loadingBundles.value = true
  try {
    bundles.value = await listBundles()
  } catch (e) {
    console.error(e)
  } finally {
    loadingBundles.value = false
  }
}

function templateNameById(id) {
  return allTemplates.value.find(t => t.id === id)?.name || id
}

const createBundleVisible = ref(false)
const bundleForm = reactive({ name: '', description: '', templateIds: [] })
const bundleError = ref('')
const creatingBundle = ref(false)

function openCreateBundle() {
  bundleForm.name = ''
  bundleForm.description = ''
  bundleForm.templateIds = []
  bundleError.value = ''
  createBundleVisible.value = true
}

async function doCreateBundle() {
  if (!bundleForm.name.trim()) { bundleError.value = 'Name is required'; return }
  if (!bundleForm.templateIds.length) { bundleError.value = 'Select at least one template'; return }
  creatingBundle.value = true
  bundleError.value = ''
  try {
    await createBundle({ name: bundleForm.name, description: bundleForm.description, templateIds: bundleForm.templateIds })
    createBundleVisible.value = false
    toast.add({ severity: 'success', summary: 'Bundle created', life: 2500 })
    await loadBundles()
  } catch (e) {
    console.error(e)
    bundleError.value = 'Something went wrong. Try again.'
  } finally {
    creatingBundle.value = false
  }
}

function confirmDeleteBundle(bundle) {
  confirm.require({
    group: 'settings-templates',
    message: `Delete bundle "${bundle.name}"? Its templates are not affected.`,
    header: 'Delete Bundle', icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Delete', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteBundle(bundle.id)
        toast.add({ severity: 'info', summary: 'Deleted', life: 2000 })
        await loadBundles()
      } catch (e) {
        console.error(e)
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not delete', life: 3000 })
      }
    },
  })
}

onMounted(() => {
  loadTemplates()
  loadBundles()
  loadSchools()
})
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
