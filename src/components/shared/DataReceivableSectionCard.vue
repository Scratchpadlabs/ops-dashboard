<template>
  <div class="bg-white rounded-xl border border-slate-200 p-4">
    <div class="flex items-center justify-between mb-2">
      <div class="text-sm font-bold text-slate-900">{{ title }}</div>
      <span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="badgeClass">{{ receivedCount }}/{{ totalCount }}</span>
    </div>
    <div class="h-1.5 rounded-full bg-slate-100 overflow-hidden mb-3">
      <div class="h-full rounded-full transition-all" :style="{ width: percent + '%', background: barColor }"></div>
    </div>
    <div>
      <!-- Shared item (auto-synced across all assessments) -->
      <div v-if="grading" class="py-2 border-b border-slate-100 bg-slate-50/60 -mx-2 px-2 rounded">
        <div class="flex items-center gap-2.5">
          <Checkbox :binary="true" v-model="grading.received" @change="onReceivedToggle(grading)" />
          <span class="flex-1 text-sm text-slate-800">Grading Scale <span class="text-[10px] text-slate-400">(once for all assessments)</span></span>
          <i v-if="grading.received" class="pi pi-check-circle text-green-500 text-sm"></i>
          <span v-else class="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0"></span>
        </div>
        <div v-if="grading.received" class="mt-1.5 ml-7">
          <DatePicker
            :modelValue="gradingDateModel"
            class="w-full"
            dateFormat="d M yy"
            placeholder="Date received"
            showIcon
            inputClass="text-xs"
            @update:modelValue="d => onDateChange(grading, d)"
          />
        </div>
        <div class="mt-1.5 ml-7">
          <InputText
            v-model="grading.notes"
            class="w-full text-xs"
            placeholder="Notes..."
            @blur="$emit('change')"
          />
        </div>
      </div>

      <div v-for="item in items" :key="item.id" class="py-2 border-b border-slate-100 last:border-0">
        <div class="flex items-center gap-2.5">
          <Checkbox :binary="true" v-model="item.received" @change="onReceivedToggle(item)" />
          <span class="flex-1 text-sm text-slate-800">{{ item.label }}</span>
          <i v-if="item.received" class="pi pi-check-circle text-green-500 text-sm"></i>
          <span v-else class="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0"></span>
        </div>
        <div v-if="item.received" class="mt-1.5 ml-7">
          <DatePicker
            :modelValue="dateModels[item.id]"
            class="w-full"
            dateFormat="d M yy"
            placeholder="Date received"
            showIcon
            inputClass="text-xs"
            @update:modelValue="d => onDateChange(item, d)"
          />
        </div>
        <div class="mt-1.5 ml-7">
          <InputText
            v-model="item.notes"
            class="w-full text-xs"
            placeholder="Notes..."
            @blur="$emit('change')"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, watch } from 'vue'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import DatePicker from 'primevue/datepicker'

const props = defineProps({
  title: { type: String, required: true },
  items: { type: Array, default: () => [] },
  grading: { type: Object, default: null },
})
const emit = defineEmits(['change'])

// item.date is stored as a plain string; DatePicker needs a Date object per item.
const dateModels = reactive({})
function syncDateModels() {
  props.items.forEach(item => {
    dateModels[item.id] = item.date ? new Date(item.date) : null
  })
}
syncDateModels()
watch(() => props.items, syncDateModels, { deep: true })

const gradingDateModel = computed(() => props.grading?.date ? new Date(props.grading.date) : null)

function onDateChange(item, date) {
  item.date = date ? date.toISOString() : ''
  emit('change')
}

function onReceivedToggle(item) {
  if (item.received && !item.date) {
    item.date = new Date().toISOString()
    if (item.id) dateModels[item.id] = new Date(item.date)
  }
  emit('change')
}

const receivedCount = computed(() =>
  props.items.filter(i => i.received).length + (props.grading?.received ? 1 : 0)
)
const totalCount = computed(() => props.items.length + (props.grading ? 1 : 0))
const percent = computed(() => totalCount.value ? Math.round(receivedCount.value / totalCount.value * 100) : 0)

const badgeClass = computed(() => {
  if (percent.value >= 80) return 'bg-green-100 text-green-700'
  if (percent.value >= 50) return 'bg-amber-100 text-amber-700'
  return 'bg-red-100 text-red-700'
})
const barColor = computed(() => {
  if (percent.value >= 80) return '#16a34a'
  if (percent.value >= 50) return '#d97706'
  return '#dc2626'
})
</script>
