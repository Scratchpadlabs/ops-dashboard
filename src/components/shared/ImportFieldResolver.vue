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
      <!-- What the education knowledge base makes of the raw value, even when
           this school hasn't configured it. Tells apart "typo for a subject
           they do have" from "a real subject missing from their setup" — the
           second is a School Setup gap, not an import mistake. -->
      <div v-if="kbHint" class="text-[10px] text-slate-500">
        Knowledge base: <b>{{ kbHint.canonical }}</b>
        <span class="text-slate-400">· {{ kbHint.typeLabel }}</span>
        <button
          v-if="!options.includes(kbHint.canonical)"
          type="button"
          class="ml-1 text-violet-600 underline"
          v-tooltip="'Not configured for this grade — add it in School Setup, or use Propose Structure'"
        >not in this school's setup</button>
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
  // {canonical, typeLabel} from the shared education KB, or null — supplied
  // by ImportReview.vue so this component stays presentational.
  kbHint: { type: Object, default: null },
})
defineEmits(['resolve', 'resolve-all'])

// A row needs resolving if either validation flagged this field as unknown,
// or cleaning found a close-but-not-auto-applied fuzzy match for it.
const needsResolution = computed(() => !!props.flag || !!props.suggestion)
const picked = ref(props.suggestion?.suggested || null)
watch(() => props.suggestion, (s) => { if (s?.suggested) picked.value = s.suggested })
</script>
