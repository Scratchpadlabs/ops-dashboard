<template>
  <div>
    <div v-if="paymentPlans.length === 0" class="text-xs text-slate-400">
      No payment plans configured — add them in Settings.
    </div>
    <div v-else class="grid grid-cols-2 gap-2">
      <button
        v-for="plan in paymentPlans"
        :key="plan.id"
        type="button"
        @click="$emit('update:modelValue', plan.id)"
        class="p-2.5 rounded-lg border text-left transition-all"
        :class="modelValue === plan.id ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'"
      >
        <div class="font-semibold text-xs text-slate-900">{{ plan.name }}</div>
        <div class="text-[11px] text-slate-500">{{ planSplit(plan) }}</div>
      </button>
    </div>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { usePaymentPlans } from '../../composables/usePaymentPlans.js'

// Plan buttons driven by the editable payment_plans collection — replaces the
// old hardcoded Plan A / Plan B pair wherever a school's plan is chosen.
defineProps({
  modelValue: { type: String, default: null },
})
defineEmits(['update:modelValue'])

const { paymentPlans, loadPaymentPlans } = usePaymentPlans()

function planSplit(plan) {
  return (plan.installments || []).map(i => `${i.percent}%`).join(' · ')
}

onMounted(loadPaymentPlans)
</script>
