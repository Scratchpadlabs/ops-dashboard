<template>
  <div class="min-w-0 w-full">
    <div v-if="!needsResolution" class="truncate">{{ modelValue }}</div>
    <div v-else class="space-y-1 py-1">
      <div class="text-xs text-red-500 line-through truncate">{{ modelValue }}</div>
      <div class="flex items-center gap-1">
        <Select
          v-model="picked"
          :options="options"
          class="flex-1 text-xs"
          size="small"
          placeholder="Pick correct value"
          filter
        />
        <Button icon="pi pi-check" size="small" text rounded :disabled="!picked"
          v-tooltip="'Apply — also remembers this mapping for future imports'"
          @click="$emit('resolve', picked)" />
      </div>
      <div v-if="suggestion" class="text-[10px] text-amber-600">
        Suggested: <b>{{ suggestion.suggested }}</b> ({{ Math.round(suggestion.similarity * 100) }}% match)
      </div>
      <button v-if="matchCount > 0 && picked" type="button"
        class="text-[10px] text-violet-600 underline"
        @click="$emit('resolve-all', picked)">
        Apply to {{ matchCount }} other identical row{{ matchCount !== 1 ? 's' : '' }} too
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import Select from 'primevue/select'
import Button from 'primevue/button'

const props = defineProps({
  modelValue: { type: String, default: '' },
  flag: { type: Object, default: null },
  suggestion: { type: Object, default: null },
  options: { type: Array, default: () => [] },
  matchCount: { type: Number, default: 0 },
})
defineEmits(['resolve', 'resolve-all'])

// A row needs resolving if either validation flagged this field as unknown,
// or cleaning found a close-but-not-auto-applied fuzzy match for it.
const needsResolution = computed(() => !!props.flag || !!props.suggestion)
const picked = ref(props.suggestion?.suggested || null)
watch(() => props.suggestion, (s) => { if (s?.suggested) picked.value = s.suggested })
</script>
