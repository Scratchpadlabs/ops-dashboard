<template>
  <Dialog
    :visible="visible"
    @update:visible="$emit('update:visible', $event)"
    header="Record Payment"
    modal
    :style="{ width: '380px' }"
  >
    <div v-if="invoice" class="space-y-4 pt-2">
      <div class="bg-slate-50 rounded-lg px-3 py-2.5 text-sm">
        <div class="flex justify-between">
          <span class="text-slate-500">Invoice {{ invoice.invoice_number }}</span>
          <span class="font-bold text-slate-900">{{ formatRupee(total) }}</span>
        </div>
        <div v-if="alreadyPaid > 0" class="flex justify-between mt-1 text-xs">
          <span class="text-slate-400">Already received</span>
          <span class="font-semibold text-green-700">{{ formatRupee(alreadyPaid) }}</span>
        </div>
      </div>

      <div>
        <label class="form-label">Payment Date</label>
        <DatePicker v-model="paidDate" class="w-full" dateFormat="d M yy" showIcon />
      </div>

      <div>
        <label class="form-label">Amount Received (₹)</label>
        <InputNumber v-model="paidAmount" class="w-full" :min="1" :minFractionDigits="0" :maxFractionDigits="2" />
        <p class="text-xs mt-1" :class="isPartial ? 'text-blue-600' : 'text-slate-400'">
          <template v-if="isPartial">
            Partial payment — {{ formatRupee(outstanding - (paidAmount || 0)) }} will stay outstanding.
          </template>
          <template v-else-if="(paidAmount || 0) > outstanding">
            More than the outstanding {{ formatRupee(outstanding) }} — please double-check.
          </template>
          <template v-else>Edit for a partial payment.</template>
        </p>
      </div>

      <div v-if="error" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ error }}</div>
    </div>

    <template #footer>
      <Button label="Cancel" text @click="$emit('update:visible', false)" />
      <Button :label="isPartial ? 'Record Partial Payment' : 'Mark Paid'" :loading="saving" @click="save" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { updateDoc, serverTimestamp, Timestamp } from 'firebase/firestore'
import { opsDoc } from '../../firebase/collections.js'
import { auth } from '../../firebase/config'
import { invoiceAmount, invoicePaidAmount, invoiceOutstanding } from '../../utils/paymentMath.js'

import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputNumber from 'primevue/inputnumber'
import DatePicker from 'primevue/datepicker'

// Records a (possibly partial) payment against an invoice: date defaults to
// today, amount defaults to the outstanding balance, both editable.
const props = defineProps({
  visible: { type: Boolean, default: false },
  invoice: { type: Object, default: null },
})
const emit = defineEmits(['update:visible', 'saved'])

const paidDate   = ref(new Date())
const paidAmount = ref(null)
const saving     = ref(false)
const error      = ref('')

const total       = computed(() => props.invoice ? invoiceAmount(props.invoice) : 0)
const alreadyPaid = computed(() => props.invoice ? invoicePaidAmount(props.invoice) : 0)
const outstanding = computed(() => props.invoice ? invoiceOutstanding(props.invoice) : 0)
const isPartial   = computed(() => (paidAmount.value || 0) < outstanding.value - 0.01)

watch(() => props.visible, (v) => {
  if (v && props.invoice) {
    paidDate.value   = new Date()
    paidAmount.value = outstanding.value || total.value
    error.value      = ''
  }
})

async function save() {
  if (!props.invoice) return
  if (!paidAmount.value || paidAmount.value <= 0) { error.value = 'Enter the amount received'; return }
  if (!paidDate.value) { error.value = 'Pick a payment date'; return }

  saving.value = true
  try {
    const newPaid = alreadyPaid.value + paidAmount.value
    const fullyPaid = newPaid >= total.value - 0.01

    const payload = {
      payment_status: fullyPaid ? 'paid' : 'partially_paid',
      paid_amount:    newPaid,
      paid_date:      Timestamp.fromDate(paidDate.value),
      updated_at:     serverTimestamp(),
      updated_by:     auth.currentUser?.email || 'unknown',
    }
    // Legacy fields other screens still read — only flip on full payment.
    if (fullyPaid) {
      payload.status  = 'paid'
      payload.paid_on = serverTimestamp()
    }
    await updateDoc(opsDoc('invoices', props.invoice.id), payload)

    emit('saved', { invoice: props.invoice, amount: paidAmount.value, fullyPaid })
    emit('update:visible', false)
  } catch (e) {
    console.error(e)
    error.value = 'Could not record the payment. Try again.'
  } finally {
    saving.value = false
  }
}

function formatRupee(amount) {
  if (!amount) return '₹0'
  return '₹' + Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}
</script>

<style scoped>
.form-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: #64748b;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
</style>
