<template>
  <div class="flex gap-5 items-start">
    <!-- ── Step rail ──────────────────────────────────────────────────── -->
    <div class="w-56 flex-shrink-0 bg-white rounded-xl border border-slate-200 p-3 sticky top-4">
      <div class="px-1 pb-2 mb-2 border-b border-slate-100">
        <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide">{{ title }}</div>
        <div class="flex items-center gap-2 mt-1.5">
          <div class="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div class="h-full rounded-full bg-blue-500 transition-all" :style="{ width: percent + '%' }"></div>
          </div>
          <span class="text-[11px] font-semibold text-slate-500">{{ percent }}%</span>
        </div>
        <div class="text-[11px] text-slate-400 mt-1">
          Step {{ currentIndex + 1 }} of {{ steps.length }}
        </div>
      </div>

      <button
        v-for="(s, i) in steps" :key="s.key"
        type="button"
        class="w-full text-left px-2 py-2 rounded-lg mb-0.5 transition-colors"
        :class="[
          s.key === currentStep ? 'bg-slate-900 text-white' : 'hover:bg-slate-50',
          isUnlocked(s.key) ? 'cursor-pointer' : 'cursor-not-allowed opacity-45',
        ]"
        :disabled="!isUnlocked(s.key)"
        @click="$emit('go', s.key)"
      >
        <div class="flex items-start gap-2">
          <span
            class="mt-0.5 w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold"
            :class="badgeClass(s)"
          >
            <i v-if="statusOf(s.key) === 'done'" class="pi pi-check" style="font-size:8px"></i>
            <i v-else-if="statusOf(s.key) === 'skipped'" class="pi pi-minus" style="font-size:8px"></i>
            <template v-else>{{ i + 1 }}</template>
          </span>
          <span class="min-w-0">
            <span class="block text-xs font-medium cell-truncate"
                  :class="s.key === currentStep ? 'text-white' : 'text-slate-700'">{{ s.label }}</span>
            <span v-if="summaryOf(s.key)" class="block text-[11px] cell-truncate"
                  :class="s.key === currentStep ? 'text-slate-300' : 'text-slate-400'"
                  :title="summaryOf(s.key)">{{ summaryOf(s.key) }}</span>
            <span v-else-if="s.optional" class="block text-[11px]"
                  :class="s.key === currentStep ? 'text-slate-400' : 'text-slate-300'">Optional</span>
          </span>
        </div>
      </button>

      <button
        type="button"
        class="w-full text-left px-2 py-2 mt-2 text-[11px] text-slate-400 hover:text-slate-600"
        @click="$emit('exit')"
      >
        <i class="pi pi-times text-[10px] mr-1"></i>Leave wizard (progress is saved)
      </button>
    </div>

    <!-- ── Step body ──────────────────────────────────────────────────── -->
    <div class="flex-1 min-w-0">
      <div class="bg-white rounded-xl border border-slate-200 p-5">
        <div class="mb-4 pb-3 border-b border-slate-100">
          <div class="flex items-center gap-2">
            <h3 class="text-base font-bold text-slate-900">{{ step?.label }}</h3>
            <span v-if="step?.optional"
                  class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500">
              Optional — skip for now
            </span>
          </div>
          <!-- Plain-language explanation of what this step does and why it
               matters. Every step has one; it is not decoration. -->
          <p v-if="step?.blurb" class="text-sm text-slate-500 mt-1">{{ step.blurb }}</p>
        </div>

        <slot />

        <!-- Completion caption. Absent by design on destructive steps —
             see src/utils/wizardCaptions.js. -->
        <Transition name="fade">
          <div v-if="caption" class="mt-4 text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">
            <i class="pi pi-sparkles text-xs mr-1"></i>{{ caption }}
          </div>
        </Transition>

        <div v-if="error" class="mt-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{{ error }}</div>

        <div class="flex items-center gap-2 mt-5 pt-4 border-t border-slate-100">
          <Button v-if="currentIndex > 0" label="Back" icon="pi pi-arrow-left" text size="small"
            :disabled="busy" @click="$emit('back')" />
          <div class="ml-auto flex gap-2">
            <Button v-if="step?.optional" label="Skip for now" text size="small"
              :disabled="busy" @click="$emit('skip')" />
            <slot name="actions">
              <Button :label="isLast ? 'Finish' : 'Continue'" :icon="isLast ? 'pi pi-check' : 'pi pi-arrow-right'"
                iconPos="right" size="small" :loading="busy" :disabled="!canContinue"
                @click="$emit('next')" />
            </slot>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import Button from 'primevue/button'

/**
 * Shared chrome for both wizards: the step rail with status ticks, progress,
 * back/skip/continue, and the slot the active step renders into.
 *
 * It owns no wizard state — the parent holds the run (useWizardRun) and this
 * only reports intent, so the two wizards can differ completely in behaviour
 * while looking and navigating identically.
 */
const props = defineProps({
  title: { type: String, default: 'Setup' },
  steps: { type: Array, required: true },
  currentStep: { type: String, required: true },
  currentIndex: { type: Number, default: 0 },
  percent: { type: Number, default: 0 },
  statusOf: { type: Function, required: true },
  summaryOf: { type: Function, required: true },
  isUnlocked: { type: Function, required: true },
  caption: { type: String, default: '' },
  error: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  canContinue: { type: Boolean, default: true },
})
defineEmits(['go', 'back', 'next', 'skip', 'exit'])

const step = computed(() => props.steps.find(s => s.key === props.currentStep))
const isLast = computed(() => props.currentIndex === props.steps.length - 1)

function badgeClass(s) {
  const status = props.statusOf(s.key)
  if (status === 'done') return 'bg-green-500 text-white'
  if (status === 'skipped') return 'bg-slate-300 text-white'
  if (s.key === props.currentStep) return 'bg-white text-slate-900'
  return 'bg-slate-100 text-slate-400'
}
</script>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
