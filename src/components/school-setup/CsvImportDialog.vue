<template>
  <Dialog v-model:visible="visible" :header="title" modal :style="{ width: '900px' }">
    <div class="space-y-3 pt-2">
      <input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" @change="onFileChange" class="text-sm" />
      <div v-if="parsing" class="text-sm text-slate-400">Parsing...</div>
      <div v-else-if="rows.length">
        <div class="flex items-center gap-4 text-xs mb-2">
          <span class="text-emerald-600 font-semibold">{{ createCount }} create</span>
          <span class="text-blue-600 font-semibold">{{ updateCount }} update</span>
          <span class="text-red-600 font-semibold">{{ errorCount }} error</span>
          <button v-if="errorCount" type="button" class="text-violet-600 font-semibold ml-auto" @click="downloadErrors">Download errors as CSV</button>
        </div>
        <div class="max-h-96 overflow-auto border border-slate-200 rounded-lg">
          <table class="w-full text-xs">
            <thead class="sticky top-0 bg-white">
              <tr class="border-b border-slate-200">
                <th class="text-left px-2 py-1.5">Status</th>
                <th v-for="key in columnKeys" :key="key" class="text-left px-2 py-1.5">{{ key }}</th>
                <th class="text-left px-2 py-1.5">Notes</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in rows" :key="i" class="border-b border-slate-100" :class="r._status === 'ERROR' ? 'bg-red-50' : ''">
                <td class="px-2 py-1.5">
                  <span
                    class="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                    :class="{
                      'bg-emerald-100 text-emerald-700': r._status === 'CREATE',
                      'bg-blue-100 text-blue-700': r._status === 'UPDATE',
                      'bg-red-100 text-red-700': r._status === 'ERROR',
                    }"
                  >{{ r._status }}</span>
                </td>
                <td v-for="key in columnKeys" :key="key" class="px-2 py-1.5 whitespace-nowrap">{{ r.raw[key] }}</td>
                <td class="px-2 py-1.5">
                  <span v-if="r._reason" class="text-red-500">{{ r._reason }}</span>
                  <span v-else-if="r._warning" class="text-amber-600">{{ r._warning }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div v-if="confirmError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ confirmError }}</div>
    </div>
    <template #footer>
      <Button label="Cancel" text @click="visible = false" />
      <Button label="Confirm" :loading="confirming" :disabled="!validCount" @click="onConfirmClick" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import { parseCsv, toCsv, downloadCsv, readFileAsText } from '../../utils/csv.js'

const props = defineProps({
  title: { type: String, required: true },
  columnKeys: { type: Array, required: true },
  // async (rawRowObject, rowIndex) => { _status: 'CREATE'|'UPDATE'|'ERROR', _reason?, _warning?, raw, ...anything the tab needs }
  // rowIndex is 0 for the first row of each newly-picked file — use it to reset
  // any state the classifier carries across rows.
  classifyRow: { type: Function, required: true },
  // async (validRows) => void | false — validRows are CREATE/UPDATE only. Return false to keep the dialog open (e.g. user cancelled a safety confirm).
  onConfirm: { type: Function, required: true },
})
const visible = defineModel('visible', { default: false })

const parsing = ref(false)
const rows = ref([])
const confirming = ref(false)
const confirmError = ref('')

const createCount = computed(() => rows.value.filter(r => r._status === 'CREATE').length)
const updateCount = computed(() => rows.value.filter(r => r._status === 'UPDATE').length)
const errorCount = computed(() => rows.value.filter(r => r._status === 'ERROR').length)
const validCount = computed(() => createCount.value + updateCount.value)

async function onFileChange(e) {
  const file = e.target.files[0]
  if (!file) return
  parsing.value = true
  confirmError.value = ''
  rows.value = []
  try {
    const text = await readFileAsText(file)
    const { rows: rawRows } = parseCsv(text)
    const classified = []
    // The row index is passed so a classifier that carries state across rows
    // (remarks checks each key against the ones earlier rows claimed) can tell
    // a fresh file from a continuation. Existing classifiers take one argument
    // and ignore it.
    for (const [i, raw] of rawRows.entries()) {
      classified.push(await props.classifyRow(raw, i))
    }
    rows.value = classified
  } catch (err) {
    console.error(err)
    confirmError.value = 'Could not parse the file.'
  } finally {
    parsing.value = false
    e.target.value = ''
  }
}

function downloadErrors() {
  const errorRows = rows.value.filter(r => r._status === 'ERROR').map(r => ({ ...r.raw, reason: r._reason }))
  downloadCsv('import-errors.csv', toCsv(errorRows, [...props.columnKeys, 'reason']))
}

async function onConfirmClick() {
  confirmError.value = ''
  confirming.value = true
  try {
    const validRows = rows.value.filter(r => r._status === 'CREATE' || r._status === 'UPDATE')
    const proceed = await props.onConfirm(validRows)
    if (proceed !== false) {
      visible.value = false
      rows.value = []
    }
  } catch (e) {
    console.error(e)
    confirmError.value = 'Something went wrong while importing.'
  } finally {
    confirming.value = false
  }
}
</script>
