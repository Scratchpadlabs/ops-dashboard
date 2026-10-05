<template>
  <Dialog :visible="visible" @update:visible="v => !busy && $emit('update:visible', v)"
          header="Download Smart Sheets report" modal :style="{ width: '560px' }" :closable="!busy">
    <div class="space-y-4 pt-1">
      <div>
        <label class="form-label">Sheet</label>
        <div class="flex gap-2">
          <button v-for="k in REPORT_KINDS" :key="k.value" type="button" :disabled="busy"
                  class="flex-1 py-2 px-3 rounded-lg text-sm font-medium border transition-all"
                  :class="kind === k.value ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
                  @click="kind = k.value">{{ k.label }}</button>
        </div>
        <p v-if="kind === 'attendance'" class="text-[11px] text-slate-400 mt-1">
          Days present per month for the whole year, with each month's working days.
        </p>
      </div>

      <div v-if="needsTerm">
        <label class="form-label">Term</label>
        <Select v-model="termId" :options="terms" optionLabel="name" optionValue="id" placeholder="Select a term"
                class="w-full" :disabled="busy" />
      </div>

      <div>
        <label class="form-label">Classes</label>
        <MultiSelect v-model="classIds" :options="classOptions" optionLabel="name" optionValue="id"
                     placeholder="Pick classes" class="w-full" filter display="chip" :maxSelectedLabels="8" :disabled="busy" />
        <div class="flex gap-3 mt-1.5 text-xs">
          <button type="button" class="text-blue-600 hover:underline" :disabled="busy"
                  @click="classIds = classOptions.map(c => c.id)">Select all {{ classOptions.length }}</button>
          <button type="button" class="text-slate-500 hover:underline" :disabled="busy" @click="classIds = []">Clear</button>
        </div>
      </div>

      <div>
        <label class="form-label">Report</label>
        <div class="flex flex-col gap-1.5">
          <div v-for="opt in LAYOUTS" :key="opt.value" class="flex items-start gap-2">
            <RadioButton v-model="layout" :value="opt.value" :inputId="`ssLayout-${opt.value}`" :disabled="busy" />
            <label :for="`ssLayout-${opt.value}`" class="text-sm text-slate-700 cursor-pointer">
              {{ opt.label }}<span class="block text-xs text-slate-400">{{ opt.hint }}</span>
            </label>
          </div>
        </div>
      </div>

      <p class="text-[11px] text-slate-400">
        Same layout as the teacher app's “Download Consolidated Report”: ID, Admission No., GR/EMIS No.,
        Roll No. and name, then the marks, converted values and grades exactly as entered.
        A class whose sheet nobody has opened yet is left out and listed after the download.
      </p>
      <div v-if="busy" class="text-sm text-slate-600 flex items-center gap-2">
        <i class="pi pi-spin pi-spinner text-sm"></i>Reading {{ classIds.length }} class{{ classIds.length === 1 ? '' : 'es' }}…
      </div>
      <!-- Built after the click's download window closed: this click saves it. -->
      <div v-if="pendingFile" class="flex items-center gap-3 bg-emerald-50 rounded-lg px-3 py-2">
        <i class="pi pi-file-excel text-green-600" style="font-size:1.25rem"></i>
        <div class="min-w-0 flex-1 text-xs text-slate-700 break-all">{{ pendingFile.name }} is ready</div>
        <Button label="Save file" icon="pi pi-download" size="small" @click="savePending" />
      </div>
      <div v-if="skipped.length" class="text-xs bg-amber-50 text-amber-800 rounded-lg px-3 py-2">
        <div class="font-semibold mb-0.5">Left out ({{ skipped.length }}):</div>
        <div v-for="s in skipped" :key="s.classId">{{ s.className }} — {{ s.reason }}</div>
      </div>
      <div v-if="error" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ error }}</div>
    </div>
    <template #footer>
      <Button label="Close" text :disabled="busy" @click="$emit('update:visible', false)" />
      <Button label="Download Excel" icon="pi pi-file-excel" :loading="busy" :disabled="!canDownload" @click="download" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useToast } from 'primevue/usetoast'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import RadioButton from 'primevue/radiobutton'
import { smartSheetsExportRemote } from '../../utils/api.js'
import { REPORT_KINDS, downloadSmartSheetsReport } from '../../utils/smartSheetsWorkbook.js'
import { pendingFile, savePending, discardPending } from '../../utils/deliverFile.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  schoolId: { type: String, default: null },
  schoolName: { type: String, default: '' },
  terms: { type: Array, default: () => [] },
  classes: { type: Array, default: () => [] },
  // Pre-selects the sheet type / term the Sheets Status tab is showing.
  initialKind: { type: String, default: 'academics' },
  initialTermId: { type: String, default: null },
})
defineEmits(['update:visible'])
const toast = useToast()

const LAYOUTS = [
  { value: 'consolidated', label: 'Consolidated report', hint: 'One Excel file, a sheet per class — Select all for the whole school.' },
  { value: 'per-class', label: 'One report per class', hint: 'A separate Excel file for each class (zipped when more than one).' },
]

const kind = ref('academics')
const termId = ref(null)
const classIds = ref([])
const layout = ref('consolidated')
const busy = ref(false)
const error = ref('')
const skipped = ref([])

const classOptions = computed(() => props.classes
  .filter(c => c.isActive !== false)
  .map(c => ({ id: c.id, name: c.name || c.id }))
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })))
const needsTerm = computed(() => REPORT_KINDS.find(k => k.value === kind.value)?.needsTerm)
const canDownload = computed(() => !busy.value && !!props.schoolId && classIds.value.length > 0 && (!needsTerm.value || !!termId.value))

watch(() => props.visible, (open) => {
  if (!open) return
  kind.value = REPORT_KINDS.some(k => k.value === props.initialKind) ? props.initialKind : 'academics'
  termId.value = props.initialTermId || termId.value
  error.value = ''
  skipped.value = []
  discardPending()
})

async function download() {
  busy.value = true
  error.value = ''
  skipped.value = []
  try {
    const res = await smartSheetsExportRemote({
      schoolId: props.schoolId, kind: kind.value, classIds: classIds.value,
      termId: needsTerm.value ? termId.value : null,
    })
    skipped.value = res.skipped || []
    if (!res.classes?.length) {
      error.value = 'None of the selected classes has this sheet yet — nothing to download.'
      return
    }
    const { files, status } = await downloadSmartSheetsReport({
      schoolName: props.schoolName || props.schoolId, kind: kind.value, termName: res.termName,
      tables: res.classes, perClass: layout.value === 'per-class',
    })
    if (status === 'downloaded') {
      toast.add({ severity: 'success', life: 4000, summary: 'Report downloaded',
        detail: `${res.classes.length} class${res.classes.length === 1 ? '' : 'es'}${files > 1 ? ` in ${files} files` : ''}` })
    }
  } catch (e) {
    console.error('Smart Sheets report failed', e)
    error.value = e.message || 'Could not build the report.'
  } finally {
    busy.value = false
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
