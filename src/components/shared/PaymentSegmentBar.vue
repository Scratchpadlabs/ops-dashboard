<template>
  <div
    class="flex w-full rounded-full overflow-hidden bg-slate-100"
    :class="compact ? 'h-1.5' : 'h-2.5'"
    v-tooltip="tooltip"
  >
    <div class="bg-green-500 transition-all" :style="{ width: segments.received + '%' }"></div>
    <div class="bg-amber-400 transition-all" :style="{ width: segments.invoicedUnpaid + '%' }"></div>
    <div class="bg-slate-200 transition-all" :style="{ width: segments.notInvoiced + '%' }"></div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

// Horizontal payment-position bar: received / invoiced-unpaid / not yet invoiced.
const props = defineProps({
  segments: { type: Object, required: true }, // { received, invoicedUnpaid, notInvoiced } in %
  compact:  { type: Boolean, default: false },
})

const tooltip = computed(() =>
  `Received ${Math.round(props.segments.received)}% · ` +
  `Invoiced unpaid ${Math.round(props.segments.invoicedUnpaid)}% · ` +
  `Not invoiced ${Math.round(props.segments.notInvoiced)}%`
)
</script>
