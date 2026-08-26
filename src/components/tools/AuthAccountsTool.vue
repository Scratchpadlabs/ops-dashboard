<template>
  <div class="pt-2 max-w-2xl">
    <div class="text-sm font-bold text-slate-900 mb-1">Create Auth Accounts</div>
    <p class="text-xs text-slate-400 mb-4">
      Creates a Firebase Auth login for every student/staff record flagged
      "needs auth creation" for a school, then marks them done. Preview first —
      nothing is created until you run it for real.
    </p>

    <div class="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
      <div>
        <label class="form-label">School</label>
        <SchoolSearchSelect
          v-model="schoolQuery"
          :schools="allSchools"
          placeholder="Type or select a school"
          @select="onSchoolSelect"
        />
      </div>

      <div class="flex items-center gap-4 text-sm text-slate-600">
        <label class="flex items-center gap-1.5">
          <Checkbox v-model="roles" value="students" />
          Students
        </label>
        <label class="flex items-center gap-1.5">
          <Checkbox v-model="roles" value="staffs" />
          Staff
        </label>
      </div>

      <div v-if="error" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ error }}</div>

      <div class="flex gap-2 pt-1">
        <Button label="Preview" icon="pi pi-eye" outlined :loading="busy && dryRunInFlight" :disabled="!schoolId || !roles.length" @click="run(true)" />
        <Button label="Create Accounts" icon="pi pi-user-plus" :loading="busy && !dryRunInFlight" :disabled="!schoolId || !roles.length" @click="run(false)" />
      </div>
    </div>

    <div v-if="result" class="bg-white rounded-xl border border-slate-200 p-4 mt-4">
      <div class="text-sm font-semibold text-slate-800 mb-3">
        {{ result.dryRun ? 'Preview' : 'Result' }} — {{ result.schoolId }}
      </div>

      <div v-for="role in Object.keys(result.results)" :key="role" class="mb-4 last:mb-0">
        <div class="text-xs font-semibold text-slate-400 uppercase mb-1.5">{{ role }}</div>
        <div class="flex flex-wrap gap-2 text-xs mb-2">
          <span class="px-2 py-1 rounded-md bg-slate-100 text-slate-600">{{ result.results[role].found }} found</span>
          <span v-if="result.results[role].created.length" class="px-2 py-1 rounded-md bg-emerald-50 text-emerald-700">
            {{ result.results[role].created.length }} {{ result.dryRun ? 'to create' : 'created' }}
          </span>
          <span v-if="result.results[role].existing.length" class="px-2 py-1 rounded-md bg-sky-50 text-sky-700">
            {{ result.results[role].existing.length }} already existed
          </span>
          <span v-if="result.results[role].skipped.length" class="px-2 py-1 rounded-md bg-amber-50 text-amber-700">
            {{ result.results[role].skipped.length }} skipped
          </span>
          <span v-if="result.results[role].failed.length" class="px-2 py-1 rounded-md bg-red-50 text-red-700">
            {{ result.results[role].failed.length }} failed
          </span>
        </div>

        <div v-if="result.results[role].failed.length" class="text-xs text-red-700 space-y-1">
          <div v-for="f in result.results[role].failed" :key="f.id">{{ f.name }} ({{ f.email }}) — {{ f.error }}</div>
        </div>
        <div v-if="result.results[role].skipped.length" class="text-xs text-amber-700 space-y-1">
          <div v-for="s in result.results[role].skipped" :key="s.id">{{ s.name }} — {{ s.reason }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'

import SchoolSearchSelect from '../shared/SchoolSearchSelect.vue'
import { useAllSchools } from '../../composables/useAllSchools.js'
import { createAuthAccountsRemote } from '../../utils/api.js'

const { allSchools, loadAllSchools } = useAllSchools()
loadAllSchools()

const schoolQuery = ref('')
const schoolId = ref('')
const roles = ref(['students', 'staffs'])
const busy = ref(false)
const dryRunInFlight = ref(false)
const error = ref('')
const result = ref(null)

function onSchoolSelect(school) {
  schoolId.value = school.id
}

async function run(dryRun) {
  if (!schoolId.value || !roles.value.length) return
  // A dry run and a real run must never be confused server-side, so this
  // requires an explicit second click rather than inferring intent from the
  // preview having run first — creating accounts is not reversible.
  if (!dryRun && !window.confirm(
    `Create Firebase Auth accounts for ${roles.value.join(' + ')} at ${schoolId.value}? This cannot be undone.`
  )) return

  busy.value = true
  dryRunInFlight.value = dryRun
  error.value = ''
  try {
    result.value = await createAuthAccountsRemote({ schoolId: schoolId.value, roles: roles.value, dryRun })
  } catch (e) {
    error.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}
</script>
