<template>
  <div class="bg-white rounded-xl border border-slate-200 p-4">
    <div class="flex items-center justify-between gap-2 mb-2">
      <div v-if="!editingName" class="flex items-center gap-1.5 min-w-0">
        <div class="text-sm font-bold text-slate-900 truncate">{{ term.name || `Term ${term.term_number}` }}</div>
        <button @click="startEditName" class="text-slate-300 hover:text-slate-500 flex-shrink-0" title="Rename">
          <i class="pi pi-pencil text-xs"></i>
        </button>
      </div>
      <InputText
        v-else
        ref="nameInput"
        v-model="term.name"
        class="text-sm font-bold flex-1"
        @blur="finishEditName"
        @keyup.enter="finishEditName"
      />
      <span class="px-2 py-0.5 rounded-full text-xs font-semibold flex-shrink-0" :class="badgeClass">{{ doneCount }}/{{ totalCount }}</span>
    </div>

    <div class="h-1.5 rounded-full bg-slate-100 overflow-hidden mb-3">
      <div class="h-full rounded-full transition-all" :style="{ width: percent + '%', background: barColor }"></div>
    </div>

    <!-- Exam dates -->
    <div class="grid grid-cols-2 gap-2 mb-3">
      <div>
        <div class="text-[10px] font-semibold text-slate-400 uppercase mb-1">Exam Start</div>
        <DatePicker
          :modelValue="examStartModel"
          class="w-full"
          dateFormat="d M yy"
          placeholder="Start date"
          showIcon
          inputClass="text-xs"
          @update:modelValue="d => onExamDateChange('exam_start', d)"
        />
      </div>
      <div>
        <div class="text-[10px] font-semibold text-slate-400 uppercase mb-1">Exam End</div>
        <DatePicker
          :modelValue="examEndModel"
          class="w-full"
          dateFormat="d M yy"
          placeholder="End date"
          showIcon
          inputClass="text-xs"
          @update:modelValue="d => onExamDateChange('exam_end', d)"
        />
      </div>
    </div>

    <div>
      <!-- Shared school-level numbers (auto-synced across all terms) -->
      <div class="py-2 border-b border-slate-100">
        <div class="flex items-center gap-2.5">
          <i class="text-sm flex-shrink-0" :class="udise ? 'pi pi-check-circle text-green-500' : 'pi pi-circle text-slate-300'"></i>
          <span class="text-sm text-slate-800 w-32 flex-shrink-0">UDISE Number</span>
          <InputText
            :modelValue="udise"
            class="flex-1 text-xs"
            placeholder="Enter UDISE no."
            @update:modelValue="v => $emit('update:udise', v)"
            @blur="$emit('change')"
          />
        </div>
      </div>
      <div class="py-2 border-b border-slate-100">
        <div class="flex items-center gap-2.5">
          <i class="text-sm flex-shrink-0" :class="affiliation ? 'pi pi-check-circle text-green-500' : 'pi pi-circle text-slate-300'"></i>
          <span class="text-sm text-slate-800 w-32 flex-shrink-0">Affiliation Number</span>
          <InputText
            :modelValue="affiliation"
            class="flex-1 text-xs"
            placeholder="Enter affiliation no."
            @update:modelValue="v => $emit('update:affiliation', v)"
            @blur="$emit('change')"
          />
        </div>
      </div>

      <!-- Checklist items -->
      <div v-for="item in term.items" :key="item.id" class="py-2 border-b border-slate-100 last:border-0">
        <div class="flex items-center gap-2.5">
          <Checkbox :binary="true" v-model="item.done" @change="onDoneToggle(item)" />
          <span class="flex-1 text-sm" :class="item.done ? 'line-through text-slate-400' : 'text-slate-800'">{{ item.label }}</span>
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
import { ref, computed, reactive, watch, nextTick } from 'vue'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import DatePicker from 'primevue/datepicker'

const props = defineProps({
  term: { type: Object, required: true },
  udise: { type: String, default: '' },
  affiliation: { type: String, default: '' },
})
const emit = defineEmits(['change', 'update:udise', 'update:affiliation'])

// ── Name editing ────────────────────────────────────────────────────────────
const editingName = ref(false)
const nameInput = ref(null)
function startEditName() {
  editingName.value = true
  nextTick(() => nameInput.value?.$el?.focus())
}
function finishEditName() {
  editingName.value = false
  if (!props.term.name?.trim()) props.term.name = `Term ${props.term.term_number}`
  emit('change')
}

// ── Dates (stored as ISO strings; DatePicker needs Date objects) ────────────
const dateModels = reactive({})
function syncDateModels() {
  props.term.items.forEach(item => {
    dateModels[item.id] = item.date ? new Date(item.date) : null
  })
}
syncDateModels()
watch(() => props.term.items, syncDateModels, { deep: true })

const examStartModel = computed(() => props.term.exam_start ? new Date(props.term.exam_start) : null)
const examEndModel   = computed(() => props.term.exam_end   ? new Date(props.term.exam_end)   : null)
function onExamDateChange(field, date) {
  props.term[field] = date ? date.toISOString() : ''
  emit('change')
}

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

// ── Comments ────────────────────────────────────────────────────────────────
const openComments = ref(new Set())
function toggleComment(id) {
  const next = new Set(openComments.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openComments.value = next
}

// ── Progress (5 checklist items + UDISE + affiliation = 7) ──────────────────
const doneCount = computed(() =>
  props.term.items.filter(i => i.done).length +
  (props.udise ? 1 : 0) +
  (props.affiliation ? 1 : 0)
)
const totalCount = computed(() => props.term.items.length + 2)
const percent = computed(() => totalCount.value ? Math.round(doneCount.value / totalCount.value * 100) : 0)

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
