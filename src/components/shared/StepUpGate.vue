<template>
  <!-- Same password gate as School Setup / Import / Remarks, as a wrapper. -->
  <div v-if="!isElevated" class="flex items-center justify-center py-20">
    <div class="bg-white rounded-xl border border-slate-200 p-6 w-full max-w-sm">
      <div class="flex items-center gap-2 mb-1">
        <i class="pi pi-shield text-slate-400"></i>
        <div class="text-sm font-bold text-slate-900">Confirm your password to continue</div>
      </div>
      <p class="text-xs text-slate-400 mb-4">{{ reason }}</p>
      <Password v-model="password" class="w-full" input-class="w-full" placeholder="Password" :feedback="false" toggleMask @keyup.enter="submitReauth" />
      <div v-if="reauthError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ reauthError }}</div>
      <Button label="Continue" class="w-full mt-4" :loading="reauthing" @click="submitReauth" />
    </div>
  </div>
  <div v-else @click.capture="markActivity" @keydown.capture="markActivity" @mousemove="throttledActivity">
    <slot />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import Password from 'primevue/password'
import Button from 'primevue/button'
import { useStepUpAuth } from '../../composables/useStepUpAuth.js'

defineProps({
  reason: { type: String, default: 'This page changes live school data — re-enter your password to proceed.' },
})

const { isElevated, markActivity, reauthenticate } = useStepUpAuth()
const password = ref('')
const reauthing = ref(false)
const reauthError = ref('')

async function submitReauth() {
  if (!password.value) { reauthError.value = 'Enter your password'; return }
  reauthError.value = ''
  reauthing.value = true
  try {
    await reauthenticate(password.value)
    password.value = ''
  } catch (e) {
    reauthError.value = e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential'
      ? 'Incorrect password'
      : (e.message || 'Could not verify your password')
  } finally {
    reauthing.value = false
  }
}

let lastMove = 0
function throttledActivity() {
  const now = Date.now()
  if (now - lastMove < 5000) return
  lastMove = now
  markActivity()
}
</script>
