<!--
  "Apply Bundle" — runs the same preview+merge flow as SectionTemplateActions
  but for every section_type in a bundle at once, on one summary screen with
  one confirm (per task spec). Each section still gets its own merge/replace
  choice when the target section is non-empty — "one screen, one confirm"
  doesn't mean collapsing that choice away.
-->
<template>
  <Button label="Apply Bundle" icon="pi pi-box" size="small" outlined :disabled="!schoolId" @click="openPicker" />

  <!-- ── Bundle picker ────────────────────────────────────────────────── -->
  <Dialog v-model:visible="pickerVisible" header="Apply Bundle" modal style="width: 480px">
    <div v-if="loadingBundles" class="py-8 text-center"><ProgressSpinner style="width:28px;height:28px" /></div>
    <div v-else-if="!bundles.length" class="text-center text-sm text-slate-400 py-8">
      No bundles yet — create one from Settings &rarr; Templates.
    </div>
    <div v-else class="space-y-1.5 max-h-80 overflow-auto">
      <button
        v-for="b in bundles" :key="b.id" type="button"
        class="w-full text-left px-3 py-2.5 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50 transition-colors"
        @click="selectBundle(b)"
      >
        <div class="text-sm font-medium text-slate-900">{{ b.name }}</div>
        <div class="text-xs text-slate-400">{{ (b.template_ids || []).length }} template(s){{ b.description ? ' — ' + b.description : '' }}</div>
      </button>
    </div>
    <template #footer>
      <Button label="Cancel" text @click="pickerVisible = false" />
    </template>
  </Dialog>

  <!-- ── Combined summary + apply ─────────────────────────────────────── -->
  <Dialog v-model:visible="summaryVisible" :header="`Apply Bundle — ${selectedBundle?.name || ''}`" modal style="width: 640px">
    <div v-if="computing" class="py-8 text-center"><ProgressSpinner style="width:28px;height:28px" /></div>
    <div v-else class="space-y-4 max-h-[60vh] overflow-auto pr-1">
      <div v-for="row in rows" :key="row.template.id" class="border border-slate-200 rounded-lg p-3">
        <div class="flex items-center justify-between mb-2">
          <div>
            <span class="text-sm font-semibold text-slate-900">{{ row.section.label }}</span>
            <span class="text-xs text-slate-400 ml-1.5">— {{ row.template.name }}</span>
          </div>
          <div class="flex gap-3 text-xs">
            <span class="text-emerald-600 font-medium">{{ row.diff.added.length }} add</span>
            <span class="text-slate-500">{{ row.diff.matching.length }} match</span>
            <span class="text-amber-600 font-medium">{{ row.diff.conflicting.length }} conflict</span>
          </div>
        </div>
        <p v-if="row.section.note" class="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1 mb-2">{{ row.section.note }}</p>
        <div v-if="row.liveCount > 0" class="flex gap-4">
          <label class="flex items-center gap-1.5 text-xs cursor-pointer">
            <RadioButton v-model="row.strategy" value="merge" />
            Merge (keep school's values on conflict)
          </label>
          <label class="flex items-center gap-1.5 text-xs cursor-pointer">
            <RadioButton v-model="row.strategy" value="replace" />
            Replace (template wins)
          </label>
        </div>
        <div v-else class="text-xs text-slate-400">Section is empty — will apply directly.</div>
      </div>
      <div v-if="!rows.length" class="text-center text-sm text-slate-400 py-6">This bundle has no valid templates.</div>
      <div v-if="applyError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ applyError }}</div>
    </div>
    <template #footer>
      <Button label="Cancel" text @click="summaryVisible = false" />
      <Button label="Apply Bundle" :loading="applying" :disabled="!canApply" @click="confirmApply" />
    </template>
  </Dialog>

  <ConfirmDialog group="apply-bundle" />
</template>

<script setup>
import { ref, computed } from 'vue'
import { getDocs } from 'firebase/firestore'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import RadioButton from 'primevue/radiobutton'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import { schoolCollection } from '../../firebase/schoolCollections.js'
import { sectionByType, diffSection, applySection } from '../../utils/setupTemplates.js'
import { listBundles, getBundleWithTemplates } from '../../composables/useSetupTemplates.js'

const props = defineProps({ schoolId: { type: String, default: null } })
const emit = defineEmits(['applied'])
const confirm = useConfirm()
const toast = useToast()

// ── Picker ───────────────────────────────────────────────────────────────
const pickerVisible = ref(false)
const loadingBundles = ref(false)
const bundles = ref([])

async function openPicker() {
  pickerVisible.value = true
  loadingBundles.value = true
  try {
    bundles.value = await listBundles()
  } catch (e) {
    console.error(e)
    bundles.value = []
  } finally {
    loadingBundles.value = false
  }
}

// ── Summary ──────────────────────────────────────────────────────────────
const summaryVisible = ref(false)
const computing = ref(false)
const selectedBundle = ref(null)
const rows = ref([]) // [{ template, section, diff, liveCount, strategy }]
const applying = ref(false)
const applyError = ref('')

async function selectBundle(bundle) {
  selectedBundle.value = bundle
  pickerVisible.value = false
  summaryVisible.value = true
  computing.value = true
  applyError.value = ''
  rows.value = []
  try {
    const full = await getBundleWithTemplates(bundle.id)
    const built = []
    for (const template of full?.templates || []) {
      const section = sectionByType(template.section_type)
      if (!section) continue // template references a section_type no longer registered
      const snap = await getDocs(schoolCollection(props.schoolId, section.collection))
      const liveItems = snap.docs.map(d => ({ _id: d.id, ...d.data() }))
      const diff = diffSection(template.payload || [], liveItems, section.matchKey)
      built.push({ template, section, diff, liveCount: liveItems.length, strategy: 'merge' })
    }
    rows.value = built
  } catch (e) {
    console.error(e)
    applyError.value = 'Could not compute changes for this bundle.'
  } finally {
    computing.value = false
  }
}

const canApply = computed(() => rows.value.some(r =>
  r.diff.added.length > 0 || (r.liveCount > 0 && r.strategy === 'replace' && r.diff.conflicting.length > 0),
))

function confirmApply() {
  const replacingRows = rows.value.filter(r => r.liveCount > 0 && r.strategy === 'replace' && r.diff.conflicting.length > 0)
  if (replacingRows.length) {
    const summary = replacingRows.map(r => `${r.section.label} (${r.diff.conflicting.length})`).join(', ')
    confirm.require({
      group: 'apply-bundle',
      message: `This will overwrite existing items in: ${summary}. Continue?`,
      header: 'Confirm Replace', icon: 'pi pi-exclamation-triangle',
      rejectLabel: 'Cancel', acceptLabel: 'Overwrite', acceptClass: 'p-button-danger',
      accept: runApply,
    })
  } else {
    runApply()
  }
}

async function runApply() {
  applying.value = true
  applyError.value = ''
  try {
    for (const row of rows.value) {
      const effectiveStrategy = row.liveCount > 0 ? row.strategy : 'merge'
      await applySection({
        schoolId: props.schoolId, sectionType: row.template.section_type,
        templateId: row.template.id, diff: row.diff, strategy: effectiveStrategy,
      })
    }
    summaryVisible.value = false
    toast.add({ severity: 'success', summary: 'Bundle applied', detail: selectedBundle.value?.name, life: 3000 })
    emit('applied')
  } catch (e) {
    console.error(e)
    applyError.value = 'Something went wrong while applying. Some sections may have been written.'
  } finally {
    applying.value = false
  }
}
</script>
