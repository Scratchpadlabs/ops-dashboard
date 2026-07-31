<!--
  Generic "Save as Template" / "Apply Template" actions for one School Setup
  section. Drop this into any section header with a section-type prop — see
  src/utils/setupTemplates.js's SETUP_SECTIONS registry for the full list.
  Zero per-field special casing lives here: everything section-specific
  (which collection, how to match items across schools) comes from the
  registry entry for `sectionType`.
-->
<template>
  <div class="flex gap-2">
    <Button label="Save as Template" icon="pi pi-save" size="small" text :disabled="!schoolId" @click="openSave" />
    <Button label="Apply Template" icon="pi pi-clone" size="small" text :disabled="!schoolId" @click="openPicker" />
  </div>

  <!-- ── Save dialog ──────────────────────────────────────────────────── -->
  <Dialog v-model:visible="saveVisible" :header="`Save ${sectionLabel} As Template`" modal style="width: 440px">
    <div class="space-y-3 pt-1">
      <div>
        <label class="form-label">Name *</label>
        <InputText v-model="saveForm.name" class="w-full" placeholder="e.g. CBSE Grading Scale" />
      </div>
      <div>
        <label class="form-label">Description</label>
        <Textarea v-model="saveForm.description" class="w-full" rows="2" />
      </div>
      <p class="text-xs text-slate-400">
        Captures {{ sectionLabel }} exactly as currently configured for this school
        ({{ itemCountPreview }} item{{ itemCountPreview === 1 ? '' : 's' }}).
      </p>
      <div v-if="saveError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ saveError }}</div>
    </div>
    <template #footer>
      <Button label="Cancel" text @click="saveVisible = false" />
      <Button label="Save Template" :loading="saving" @click="doSave" />
    </template>
  </Dialog>

  <!-- ── Picker dialog ────────────────────────────────────────────────── -->
  <Dialog v-model:visible="pickerVisible" :header="`Apply ${sectionLabel} Template`" modal style="width: 480px">
    <div v-if="loadingTemplates" class="py-8 text-center"><ProgressSpinner style="width:28px;height:28px" /></div>
    <div v-else-if="!templates.length" class="text-center text-sm text-slate-400 py-8">No {{ sectionLabel }} templates saved yet</div>
    <div v-else class="space-y-1.5 max-h-80 overflow-auto">
      <button
        v-for="t in templates" :key="t.id" type="button"
        class="w-full text-left px-3 py-2.5 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50 transition-colors"
        @click="selectTemplate(t)"
      >
        <div class="text-sm font-medium text-slate-900">{{ t.name }}</div>
        <div class="text-xs text-slate-400">{{ t.item_count ?? (t.payload || []).length }} item(s){{ t.description ? ' — ' + t.description : '' }}</div>
      </button>
    </div>
    <template #footer>
      <Button label="Cancel" text @click="pickerVisible = false" />
    </template>
  </Dialog>

  <!-- ── Diff preview / apply dialog ──────────────────────────────────── -->
  <Dialog v-model:visible="previewVisible" :header="`Apply — ${selectedTemplate?.name || ''}`" modal style="width: 580px">
    <div v-if="computingDiff" class="py-8 text-center"><ProgressSpinner style="width:28px;height:28px" /></div>
    <div v-else-if="diff" class="space-y-4">
      <p v-if="section?.note" class="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">{{ section.note }}</p>

      <div class="grid grid-cols-3 gap-2 text-center">
        <div class="bg-emerald-50 rounded-lg py-2">
          <div class="text-lg font-bold text-emerald-700">{{ diff.added.length }}</div>
          <div class="text-xs text-emerald-600">To add</div>
        </div>
        <div class="bg-slate-50 rounded-lg py-2">
          <div class="text-lg font-bold text-slate-600">{{ diff.matching.length }}</div>
          <div class="text-xs text-slate-500">Match (kept)</div>
        </div>
        <div class="bg-amber-50 rounded-lg py-2">
          <div class="text-lg font-bold text-amber-700">{{ diff.conflicting.length }}</div>
          <div class="text-xs text-amber-600">Conflict</div>
        </div>
      </div>

      <div v-if="diff.added.length" class="text-xs">
        <div class="font-semibold text-slate-500 mb-1.5">Adding</div>
        <div class="flex flex-wrap gap-1">
          <span v-for="e in diff.added" :key="e.key" class="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">{{ labelOf(e.templateItem) }}</span>
        </div>
      </div>
      <div v-if="diff.conflicting.length" class="text-xs">
        <div class="font-semibold text-slate-500 mb-1.5">Conflicting — differs from this school's current value</div>
        <div class="flex flex-wrap gap-1">
          <span v-for="e in diff.conflicting" :key="e.key" class="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">{{ labelOf(e.templateItem) }}</span>
        </div>
      </div>

      <div v-if="showStrategyChoice">
        <label class="form-label mb-2 block">This section already has {{ liveItems.length }} item(s) — how should conflicts be handled?</label>
        <div class="flex flex-col gap-2.5">
          <label class="flex items-start gap-2 text-sm cursor-pointer">
            <RadioButton v-model="strategy" value="merge" class="mt-0.5" />
            <span><span class="font-medium">Merge</span> — add missing items, keep this school's current values where they differ{{ diff.conflicting.length ? ` (${diff.conflicting.length} kept as-is)` : '' }}</span>
          </label>
          <label class="flex items-start gap-2 text-sm cursor-pointer">
            <RadioButton v-model="strategy" value="replace" class="mt-0.5" />
            <span>
              <span class="font-medium">Replace</span> — template wins on conflicts
              <template v-if="diff.conflicting.length">, overwriting: {{ diff.conflicting.map(e => labelOf(e.templateItem)).join(', ') }}</template>
            </span>
          </label>
        </div>
      </div>

      <div v-if="applyError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ applyError }}</div>
    </div>
    <template #footer>
      <Button label="Cancel" text @click="previewVisible = false" />
      <Button :label="applyButtonLabel" :loading="applying" :disabled="!canApply" @click="confirmAndApply" />
    </template>
  </Dialog>

  <!--
    Grouped to this instance's section type: PrimeVue's ConfirmDialog is a
    global listener matched by `group`, and every section's actions panel
    stays mounted simultaneously (PrimeVue Tabs uses v-show, not lazy
    unmount) — an ungrouped confirm.require() here would pop up all 8
    sections' dialogs at once instead of just this one's.
  -->
  <ConfirmDialog :group="confirmGroup" />
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { getDocs } from 'firebase/firestore'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import RadioButton from 'primevue/radiobutton'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import { schoolCollection } from '../../firebase/schoolCollections.js'
import { sectionByType, diffSection, applySection, captureSectionPayload } from '../../utils/setupTemplates.js'
import { listTemplatesBySectionType, saveTemplateFromSchool } from '../../composables/useSetupTemplates.js'

const props = defineProps({
  sectionType: { type: String, required: true },
  schoolId: { type: String, default: null },
})
const emit = defineEmits(['applied'])
const confirm = useConfirm()
const toast = useToast()

const section = computed(() => sectionByType(props.sectionType))
const sectionLabel = computed(() => section.value?.label || props.sectionType)
const confirmGroup = computed(() => `section-template-${props.sectionType}`)

function labelOf(item) {
  return item.name || item.label || item._id
}

// ── Save as template ─────────────────────────────────────────────────────
const saveVisible = ref(false)
const saveForm = reactive({ name: '', description: '' })
const saveError = ref('')
const saving = ref(false)
const itemCountPreview = ref(0)

async function openSave() {
  saveForm.name = ''
  saveForm.description = ''
  saveError.value = ''
  saveVisible.value = true
  itemCountPreview.value = (await captureSectionPayload(props.schoolId, props.sectionType)).length
}

async function doSave() {
  if (!saveForm.name.trim()) { saveError.value = 'Name is required'; return }
  saveError.value = ''
  saving.value = true
  try {
    await saveTemplateFromSchool({
      schoolId: props.schoolId, sectionType: props.sectionType,
      name: saveForm.name, description: saveForm.description,
    })
    saveVisible.value = false
    toast.add({ severity: 'success', summary: 'Template saved', life: 2500 })
  } catch (e) {
    console.error(e)
    saveError.value = 'Something went wrong. Try again.'
  } finally {
    saving.value = false
  }
}

// ── Picker ───────────────────────────────────────────────────────────────
const pickerVisible = ref(false)
const loadingTemplates = ref(false)
const templates = ref([])

async function openPicker() {
  pickerVisible.value = true
  loadingTemplates.value = true
  try {
    templates.value = await listTemplatesBySectionType(props.sectionType)
  } catch (e) {
    console.error(e)
    templates.value = []
  } finally {
    loadingTemplates.value = false
  }
}

// ── Diff preview + apply — this step is never skipped, per spec ──────────
const previewVisible = ref(false)
const computingDiff = ref(false)
const selectedTemplate = ref(null)
const diff = ref(null)
const liveItems = ref([])
const strategy = ref('merge')
const applying = ref(false)
const applyError = ref('')

async function selectTemplate(t) {
  selectedTemplate.value = t
  pickerVisible.value = false
  previewVisible.value = true
  computingDiff.value = true
  applyError.value = ''
  diff.value = null
  try {
    const snap = await getDocs(schoolCollection(props.schoolId, section.value.collection))
    liveItems.value = snap.docs.map(d => ({ _id: d.id, ...d.data() }))
    diff.value = diffSection(t.payload || [], liveItems.value, section.value.matchKey)
    strategy.value = 'merge'
  } catch (e) {
    console.error(e)
    applyError.value = 'Could not load this school\'s current data to compare against.'
  } finally {
    computingDiff.value = false
  }
}

const showStrategyChoice = computed(() => liveItems.value.length > 0)
const canApply = computed(() => {
  if (!diff.value) return false
  if (!showStrategyChoice.value) return diff.value.added.length > 0
  return diff.value.added.length > 0 || (strategy.value === 'replace' && diff.value.conflicting.length > 0)
})
const applyButtonLabel = computed(() => {
  if (!showStrategyChoice.value) return 'Apply'
  return strategy.value === 'replace' ? 'Apply (Replace)' : 'Apply (Merge)'
})

function confirmAndApply() {
  const effectiveStrategy = showStrategyChoice.value ? strategy.value : 'merge'
  if (effectiveStrategy === 'replace' && diff.value.conflicting.length) {
    confirm.require({
      group: confirmGroup.value,
      message: `This will overwrite ${diff.value.conflicting.length} existing item(s): ${diff.value.conflicting.map(e => labelOf(e.templateItem)).join(', ')}. Continue?`,
      header: 'Confirm Replace', icon: 'pi pi-exclamation-triangle',
      rejectLabel: 'Cancel', acceptLabel: 'Overwrite', acceptClass: 'p-button-danger',
      accept: () => runApply(effectiveStrategy),
    })
  } else {
    runApply(effectiveStrategy)
  }
}

async function runApply(effectiveStrategy) {
  applying.value = true
  applyError.value = ''
  try {
    await applySection({
      schoolId: props.schoolId, sectionType: props.sectionType,
      templateId: selectedTemplate.value.id, diff: diff.value, strategy: effectiveStrategy,
    })
    previewVisible.value = false
    toast.add({ severity: 'success', summary: 'Template applied', life: 2500 })
    emit('applied')
  } catch (e) {
    console.error(e)
    applyError.value = 'Something went wrong while applying. Some items may have been written.'
  } finally {
    applying.value = false
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
