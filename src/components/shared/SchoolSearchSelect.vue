<template>
  <AutoComplete
    v-model="query"
    :suggestions="filtered"
    optionLabel="name"
    dropdown
    :forceSelection="false"
    scrollHeight="288px"
    class="w-full"
    inputClass="w-full"
    :placeholder="placeholder"
    @complete="onComplete"
    @item-select="onSelect"
  >
    <template #option="{ option }">
      <div>
        <div class="text-sm font-medium text-slate-800">{{ option.name }}</div>
        <div class="text-xs text-slate-400">{{ option.city || '—' }}</div>
      </div>
    </template>
  </AutoComplete>
</template>

<script setup>
import { ref, watch } from 'vue'
import AutoComplete from 'primevue/autocomplete'

const props = defineProps({
  modelValue: { type: String, default: '' },
  schools: { type: Array, default: () => [] },
  placeholder: { type: String, default: 'Type or select a school...' },
})

const emit = defineEmits(['update:modelValue', 'select'])

const query = ref(props.modelValue || '')
const filtered = ref([])

watch(() => props.modelValue, (v) => {
  if (typeof v === 'string' && v !== query.value) query.value = v
})

watch(query, (v) => {
  if (typeof v === 'string') emit('update:modelValue', v)
})

function onComplete(e) {
  const q = (e.query || '').toLowerCase().trim()
  filtered.value = q
    ? props.schools.filter(s =>
        (s.name || '').toLowerCase().includes(q) || (s.city || '').toLowerCase().includes(q)
      )
    : props.schools
}

function onSelect(e) {
  const school = e.value
  query.value = school.name
  emit('update:modelValue', school.name)
  emit('select', school)
}
</script>
