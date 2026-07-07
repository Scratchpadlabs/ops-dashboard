<template>
  <Dialog
    :visible="visible"
    @update:visible="(v) => { if (!v) onCancel?.() }"
    modal
    :style="{ width: '500px' }"
    class="sanity-check-dialog"
  >
    <template #header>
      <div class="flex items-center gap-2">
        <span class="text-xl">⚠️</span>
        <span class="font-bold" style="color:#b45309">Before you generate this {{ documentType }}...</span>
      </div>
    </template>

    <div class="space-y-2.5 pt-1">
      <div
        v-for="(w, i) in warnings"
        :key="i"
        class="warning-pill"
        :class="w.level"
      >
        <span class="warning-icon">{{ iconFor(w.level) }}</span>
        <span class="warning-msg">{{ w.msg }}</span>
      </div>

      <div class="summary-line">
        Found {{ errorCount }} issue{{ errorCount !== 1 ? 's' : '' }} and {{ warnCount }} warning{{ warnCount !== 1 ? 's' : '' }}
      </div>
    </div>

    <template #footer>
      <div class="w-full">
        <div class="flex justify-end gap-2 w-full">
          <Button label="Go Back & Fix" outlined @click="onCancel?.()" />
          <Button label="Generate Anyway →" class="generate-anyway-btn" @click="onConfirm?.()" />
        </div>
        <div class="text-xs text-slate-400 text-right mt-1.5">Generating with unresolved issues</div>
      </div>
    </template>
  </Dialog>
</template>

<script setup>
import { computed } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'

const props = defineProps({
  visible: { type: Boolean, default: false },
  warnings: { type: Array, default: () => [] },
  documentType: { type: String, default: 'document' },
  onConfirm: { type: Function, default: null },
  onCancel: { type: Function, default: null },
})

const errorCount = computed(() => props.warnings.filter(w => w.level === 'error').length)
const warnCount  = computed(() => props.warnings.filter(w => w.level === 'warn').length)

function iconFor(level) {
  if (level === 'error') return '🔴'
  if (level === 'info')  return '🔵'
  return '🟡'
}
</script>

<style scoped>
.warning-pill {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
}
.warning-pill .warning-icon {
  flex-shrink: 0;
  font-size: 12px;
  margin-top: 1px;
}
.warning-pill.error {
  background: #fef2f2;
  color: #991b1b;
  border: 1px solid #fecaca;
  animation: pulse-error 1.6s ease-in-out infinite;
}
.warning-pill.warn {
  background: #fffbeb;
  color: #92400e;
  border: 1px solid #fde68a;
}
.warning-pill.info {
  background: #eff6ff;
  color: #1e40af;
  border: 1px solid #bfdbfe;
}
@keyframes pulse-error {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.28); }
  50%      { box-shadow: 0 0 0 5px rgba(239, 68, 68, 0); }
}

.summary-line {
  font-size: 12.5px;
  color: #64748b;
  font-weight: 700;
  padding-top: 6px;
  border-top: 1px solid #f1f5f9;
  margin-top: 4px;
}

:deep(.generate-anyway-btn) {
  background: #16a34a;
  border-color: #16a34a;
}
:deep(.generate-anyway-btn:hover) {
  background: #15803d;
  border-color: #15803d;
}
</style>
