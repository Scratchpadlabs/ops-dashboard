<template>
  <div class="bg-white rounded-xl border border-slate-200 p-4">
    <div class="flex items-center justify-between mb-2">
      <div class="text-sm font-bold text-slate-900">{{ title }}</div>
      <span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="badgeClass">{{ doneCount }}/{{ items.length }}</span>
    </div>
    <div class="h-1.5 rounded-full bg-slate-100 overflow-hidden mb-3">
      <div class="h-full rounded-full transition-all" :style="{ width: percent + '%', background: barColor }"></div>
    </div>
    <div>
      <div v-for="item in items" :key="item.id" class="py-2 border-b border-slate-100 last:border-0">
        <div class="flex items-center gap-2.5">
          <Checkbox :binary="true" v-model="item.done" :disabled="item.type === 'select'" @change="onDoneToggle(item)" />
          <span class="flex-1 text-sm" :class="item.done ? 'line-through text-slate-400' : 'text-slate-800'">{{ item.label }}</span>
          <Select
            v-if="item.type === 'select'"
            :modelValue="item.value || null"
            :options="item.options"
            placeholder="Select..."
            class="w-40"
            @update:modelValue="v => onSelectChange(item, v)"
          />
          <i v-if="item.done" class="pi pi-check-circle text-green-500 text-sm"></i>
          <button @click="toggleComment(item.id)" class="text-slate-300 hover:text-slate-500 flex-shrink-0">
            <i class="pi pi-comment text-xs"></i>
          </button>
        </div>
        <div v-if="item.done" class="mt-1.5 ml-7">
          <DatePicker
            :modelValue="dateModels[item.id]"
            class="w-full"
            dateFormat="d M yy"
            placeholder="Date completed"
            showIcon
            inputClass="text-xs"
            @update:modelValue="d => onDateChange(item, d)"
          />
        </div>
        <div v-if="openComments.has(item.id)" class="mt-1.5 ml-7">
          <InputText
            v-model="item.comment"
            class="w-full text-xs"
            placeholder="Add a comment..."
            @blur="$emit('change')"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, watch } from 'vue'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import DatePicker from 'primevue/datepicker'
import Select from 'primevue/select'

const props = defineProps({
  title: { type: String, required: true },
  items: { type: Array, default: () => [] },
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

function onDoneToggle(item) {
  if (item.done && !item.date) {
    item.date = new Date().toISOString()
    dateModels[item.id] = new Date(item.date)
  }
  emit('change')
}

function onDateChange(item, date) {
  item.date = date ? date.toISOString() : ''
  emit('change')
}

function onSelectChange(item, value) {
  item.value = value || ''
  item.done = !!item.value
  if (item.done && !item.date) {
    item.date = new Date().toISOString()
    dateModels[item.id] = new Date(item.date)
  }
  emit('change')
}

const openComments = ref(new Set())
function toggleComment(id) {
  const next = new Set(openComments.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openComments.value = next
}

const doneCount = computed(() => props.items.filter(i => i.done).length)
const percent = computed(() => props.items.length ? Math.round(doneCount.value / props.items.length * 100) : 0)

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
