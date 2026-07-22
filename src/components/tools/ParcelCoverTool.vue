<template>
  <div class="pt-2">
    <div class="text-sm font-bold text-slate-900 mb-3">Parcel Cover</div>
    <div class="grid gap-5 lg:grid-cols-2">
    <!-- ── Form ───────────────────────────────────────────────────────── -->
    <div class="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
      <div>
        <label class="form-label">School</label>
        <SchoolSearchSelect
          v-model="schoolQuery"
          :schools="allSchools"
          placeholder="Pick a school to auto-fill, or leave blank"
          @select="onSchoolSelect"
        />
        <p class="text-xs text-slate-400 mt-1">
          Everything below stays editable after auto-fill.
        </p>
      </div>

      <div>
        <label class="form-label">Receiver Name</label>
        <InputText v-model="form.receiverName" class="w-full" placeholder="e.g. Reshu Aggrawal Ma'am" />
      </div>

      <div>
        <label class="form-label">Address</label>
        <Textarea v-model="form.address" class="w-full" rows="3" autoResize
                  placeholder="Building, street, area, city" />
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="form-label">Pin Code</label>
          <InputText v-model="form.pincode" class="w-full" placeholder="411004" />
        </div>
        <div>
          <label class="form-label">Phone</label>
          <InputText v-model="form.phone" class="w-full" placeholder="+91 7066034214" />
        </div>
      </div>

      <div>
        <label class="form-label">Alternate Phone</label>
        <InputText v-model="form.altPhone" class="w-full" placeholder="Optional" />
      </div>

      <div v-if="error" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ error }}</div>

      <div class="flex gap-2 pt-1">
        <Button label="Download PDF" icon="pi pi-download" :loading="busy" @click="download" />
        <Button label="Print" icon="pi pi-print" outlined :loading="busy" @click="print" />
        <Button label="Clear" text severity="secondary" @click="clearForm" />
      </div>
    </div>

    <!-- ── Live preview ───────────────────────────────────────────────── -->
    <div>
      <div class="text-xs font-semibold text-slate-400 uppercase mb-2">Preview</div>
      <div class="bg-white rounded-xl border border-slate-200 p-2 overflow-hidden">
        <svg :viewBox="`0 0 ${ART_W_PX} ${ART_H_PX}`" class="w-full h-auto block">
          <image :href="TEMPLATE_URL" x="0" y="0" :width="ART_W_PX" :height="ART_H_PX" />
          <text
            v-for="(line, i) in previewLines"
            :key="i"
            :x="LEFT_X_PX"
            :y="FIRST_BASE_Y_PX + i * LINE_GAP_PX"
            :font-size="FONT_PX"
            :font-weight="line.bold ? 700 : 400"
            font-family="Helvetica, Arial, sans-serif"
            fill="#2d2d2d"
          >{{ line.text }}</text>
        </svg>
      </div>
      <p class="text-xs text-slate-400 mt-2">
        Print at 100% / actual size — the label is 200 &times; 113 mm.
      </p>
    </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted } from 'vue'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Button from 'primevue/button'

import SchoolSearchSelect from '../shared/SchoolSearchSelect.vue'
import { useAllSchools } from '../../composables/useAllSchools.js'
import {
  buildParcelCoverPDF, parcelCoverFilename, layoutLines, TEMPLATE_URL,
  ART_W_PX, ART_H_PX, LEFT_X_PX, FIRST_BASE_Y_PX, LINE_GAP_PX, FONT_PX,
} from '../../utils/parcelCoverPDF.js'

const { allSchools, loadAllSchools } = useAllSchools()

const schoolQuery = ref('')
const schoolName  = ref('')
const busy        = ref(false)
const error       = ref('')

const form = reactive({
  receiverName: '',
  address:      '',
  pincode:      '',
  phone:        '',
  altPhone:     '',
})

const previewLines = computed(() => layoutLines(form))

function onSchoolSelect(school) {
  if (!school) return
  schoolName.value = school.name || ''

  // Address on the school record rarely carries city/state — append what's
  // missing rather than duplicating it.
  const parts = [school.address, school.city, school.state]
    .map(p => (p || '').trim())
    .filter(Boolean)
  const seen = []
  parts.forEach(p => {
    if (!seen.some(s => s.toLowerCase().includes(p.toLowerCase()))) seen.push(p)
  })

  const pocs = Array.isArray(school.pocs) ? school.pocs.filter(p => p?.name || p?.phone) : []

  form.receiverName = school.contact_person || pocs[0]?.name || ''
  form.address      = seen.join(', ')
  form.pincode      = school.pincode || school.pin_code || ''
  form.phone        = school.contact_phone || pocs[0]?.phone || ''
  form.altPhone     = (pocs.find(p => p.phone && p.phone !== form.phone)?.phone) || ''
  error.value       = ''
}

function validate() {
  if (!form.receiverName.trim()) return 'Receiver name is required'
  if (!form.address.trim())      return 'Address is required'
  return ''
}

async function makeDoc() {
  const problem = validate()
  if (problem) { error.value = problem; return null }
  error.value = ''
  busy.value = true
  try {
    return await buildParcelCoverPDF(form)
  } catch (e) {
    error.value = e.message || 'Could not generate the cover'
    return null
  } finally {
    busy.value = false
  }
}

async function download() {
  const doc = await makeDoc()
  if (doc) doc.save(parcelCoverFilename(form.receiverName, schoolName.value))
}

async function print() {
  const doc = await makeDoc()
  if (!doc) return
  doc.autoPrint()
  window.open(doc.output('bloburl'), '_blank')
}

function clearForm() {
  Object.assign(form, { receiverName: '', address: '', pincode: '', phone: '', altPhone: '' })
  schoolQuery.value = ''
  schoolName.value  = ''
  error.value       = ''
}

onMounted(loadAllSchools)
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
