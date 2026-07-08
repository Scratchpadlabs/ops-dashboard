<template>
  <div class="min-h-screen flex items-center justify-center" style="background: #0f172a">
    <div class="w-full max-w-sm">
      <div class="flex flex-col items-center mb-8">
        <div class="bg-white rounded-2xl px-8 py-4 flex items-center justify-center mb-6 shadow-sm">
          <img src="/logo.png" class="w-40 object-contain" />
        </div>
        <h1 class="text-white text-lg font-semibold">Ops Dashboard</h1>
        <p class="text-slate-400 text-sm mt-1">Sign in to continue</p>
      </div>

      <div class="bg-white rounded-2xl p-6 shadow-xl">
        <form class="space-y-4" @submit.prevent="handleLogin">
          <div>
            <label class="form-label">Username</label>
            <InputText
              v-model="username"
              type="text"
              class="w-full"
              placeholder="Username"
              autocomplete="username"
            />
          </div>
          <div>
            <label class="form-label">Password</label>
            <Password
              v-model="password"
              class="w-full"
              inputClass="w-full"
              :feedback="false"
              toggleMask
              placeholder="Password"
              autocomplete="current-password"
            />
          </div>

          <div v-if="errorMessage" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">
            {{ errorMessage }}
          </div>

          <Button
            type="submit"
            label="Sign In"
            class="w-full justify-center"
            :loading="signingIn"
          />
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { auth } from '../firebase/config'

import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import Button from 'primevue/button'

const router = useRouter()
const route = useRoute()

const USERNAME_MAP = {
  sid: 'sid@ops.clarified.in',
  angel: 'angel@ops.clarified.in',
}

const username = ref('')
const password = ref('')
const signingIn = ref(false)
const errorMessage = ref('')

async function handleLogin() {
  errorMessage.value = ''
  if (!username.value.trim() || !password.value) {
    errorMessage.value = 'Enter your username and password'
    return
  }

  const email = USERNAME_MAP[username.value.trim()]
  if (!email) {
    errorMessage.value = 'Invalid username'
    return
  }

  signingIn.value = true
  try {
    await signInWithEmailAndPassword(auth, email, password.value)
    router.push(route.query.redirect || '/')
  } catch (e) {
    errorMessage.value = 'Invalid username or password'
  } finally {
    signingIn.value = false
  }
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
