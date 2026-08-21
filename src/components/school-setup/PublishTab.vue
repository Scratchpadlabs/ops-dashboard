<template>
  <div class="pt-4 space-y-4">
    <ConfigEmptyState v-if="!schoolId" message="Select a school to publish it." />

    <template v-else>
      <!-- Where this school currently lives, if anywhere. -->
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="text-sm font-semibold text-slate-800 mb-1">Hosting</div>
            <p class="text-sm text-slate-500 max-w-2xl">
              Creates the Firebase Hosting site for this school, points
              <span class="font-mono text-xs">{{ subdomain || '…' }}.{{ BASE_DOMAIN }}</span>
              at it, and builds the teacher and student apps with this school's id.
              Nothing in the teacher repo is modified.
            </p>
          </div>
          <Tag v-if="lastRun" :severity="statusSeverity" :value="statusLabel" />
        </div>
      </div>

      <!-- Settings -->
      <div class="bg-white rounded-xl border border-slate-200 p-4 space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Hosting site id</label>
            <InputText v-model="siteId" class="w-full font-mono text-sm" />
            <p class="text-xs text-slate-400 mt-1">
              6–30 chars, lowercase letters, digits and hyphens. Serves
              <span class="font-mono">https://{{ siteId || '…' }}.web.app</span> immediately.
            </p>
          </div>
          <div>
            <label class="form-label">Subdomain</label>
            <div class="flex items-center gap-2">
              <InputText v-model="subdomain" class="w-full font-mono text-sm" />
              <span class="text-sm text-slate-400 whitespace-nowrap">.{{ BASE_DOMAIN }}</span>
            </div>
            <p class="text-xs text-slate-400 mt-1">Certificate issue can take a few hours.</p>
          </div>
        </div>

        <label class="flex items-center gap-2 text-sm text-slate-700">
          <Checkbox v-model="withDomain" binary />
          Also attach the custom domain and write its DNS records
        </label>
        <!-- The .web.app URL needs no DNS at all, so a school can go live in
             minutes and get its branded domain later. Turning this off skips
             every Namecheap interaction, which is also the fallback if the API
             is misbehaving. -->
        <p v-if="!withDomain" class="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
          The school will be reachable at <span class="font-mono">{{ siteId }}.web.app</span> only.
          You can attach the domain later by re-running with this checked.
        </p>
      </div>

      <!-- Preview -->
      <div class="flex items-center gap-2">
        <Button label="Check" icon="pi pi-search" outlined size="small"
          :loading="previewing" :disabled="!canRun" @click="runPreview" />
        <Button label="Publish school" icon="pi pi-cloud-upload" size="small"
          :loading="publishing" :disabled="!canRun || !preview" @click="publish" />
        <span v-if="!preview" class="text-xs text-slate-400">Run a check first.</span>
      </div>

      <div v-if="error" class="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
        {{ error }}
      </div>

      <div v-if="preview" class="bg-white rounded-xl border border-slate-200 p-4 space-y-2 text-sm">
        <div class="font-semibold text-slate-800">Plan</div>
        <div class="text-slate-600">
          Site <span class="font-mono">{{ preview.site_id }}</span>
          <span :class="preview.site_exists ? 'text-amber-600' : 'text-emerald-600'">
            — {{ preview.site_exists ? 'already exists, will be reused' : 'will be created' }}
          </span>
        </div>
        <div v-if="withDomain && preview.dns" class="text-slate-600">
          <template v-if="preview.dns.error">
            <span class="text-red-600">DNS check failed: {{ preview.dns.error }}</span>
          </template>
          <template v-else>
            Zone <span class="font-mono">{{ BASE_DOMAIN }}</span> has
            {{ preview.dns.zone_record_count }} records;
            {{ preview.dns.preserve_count }} declared as preserved.
          </template>
        </div>
        <!-- Surfaced rather than logged: an empty preserve list is the one
             condition under which a DNS write can lose invisible MX records. -->
        <div v-for="w in preview.dns?.warnings || []" :key="w"
          class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <i class="pi pi-exclamation-triangle text-xs mr-1"></i>{{ w }}
        </div>
      </div>

      <!-- Live run -->
      <div v-if="lastRun" class="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
        <div class="flex items-center justify-between">
          <div class="text-sm font-semibold text-slate-800">Progress</div>
          <Button label="Refresh" icon="pi pi-refresh" text size="small"
            :loading="polling" @click="poll" />
        </div>

        <div v-for="s in STEP_ROWS" :key="s.key" class="flex items-center gap-3 text-sm">
          <i :class="stepIcon(s.key)"></i>
          <span class="text-slate-700">{{ s.label }}</span>
          <span class="text-xs text-slate-400 ml-auto">{{ stepNote(s.key) }}</span>
        </div>

        <div v-if="lastRun.build?.url" class="text-xs">
          <a :href="lastRun.build.url" target="_blank" rel="noopener"
            class="text-blue-600 hover:underline">Open build log</a>
        </div>

        <!-- A failed run used to be reachable only through the Tag in the header
             and the build log. The reason it failed is on the run document; show
             it, since re-running is the documented recovery path and ops needs
             to know what to fix first. -->
        <div v-if="lastRun.status === 'failed'"
          class="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {{ lastRun.error || 'Provisioning failed. Check the build log.' }}
          <div class="text-xs text-red-700 mt-1">
            Re-running Publish is safe — every step is idempotent and resumes where it stopped.
          </div>
        </div>

        <div v-if="lastRun.status === 'live'"
          class="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          Live at
          <a :href="lastRun.default_url" target="_blank" rel="noopener" class="font-mono underline">
            {{ lastRun.default_url }}
          </a>
          <template v-if="withDomain">
            — <span class="font-mono">https://{{ lastRun.domain }}</span> follows once the
            certificate is issued.
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Checkbox from 'primevue/checkbox'
import Tag from 'primevue/tag'
import ConfigEmptyState from './ConfigEmptyState.vue'
import { previewHosting, provisionHosting, hostingStatus, suggestSiteId } from '../../utils/hostingApi'

const props = defineProps({ schoolId: { type: String, default: '' } })

const BASE_DOMAIN = 'myhpc.in'

const STEP_ROWS = [
  { key: 'site', label: 'Hosting site created' },
  { key: 'custom_domain', label: 'Custom domain attached' },
  { key: 'dns', label: 'DNS records written' },
  { key: 'build_dispatched', label: 'Build started' },
]

const siteId = ref('')
const subdomain = ref('')
const withDomain = ref(true)

const previewing = ref(false)
const publishing = ref(false)
const polling = ref(false)
const preview = ref(null)
const lastRun = ref(null)
const error = ref('')

let timer = null

const canRun = computed(() => !!props.schoolId && !!siteId.value)

const statusLabel = computed(() => ({
  in_progress: 'Provisioning',
  awaiting_build: 'Building',
  live: 'Live',
  failed: 'Failed',
}[lastRun.value?.status] || lastRun.value?.status || ''))

const statusSeverity = computed(() => ({
  live: 'success',
  failed: 'danger',
  awaiting_build: 'info',
}[lastRun.value?.status] || 'warn'))

// Re-derive the defaults whenever the selected school changes, and drop any
// state from the previous school so a stale plan can never be published
// against the wrong one.
watch(() => props.schoolId, (id) => {
  siteId.value = suggestSiteId(id)
  subdomain.value = siteId.value
  preview.value = null
  lastRun.value = null
  error.value = ''
  stopPolling()
}, { immediate: true })

function stepIcon(key) {
  const step = lastRun.value?.steps?.[key]
  if (!step) return 'pi pi-circle text-slate-300 text-xs'
  return step.ok
    ? 'pi pi-check-circle text-emerald-500 text-xs'
    : 'pi pi-exclamation-circle text-amber-500 text-xs'
}

function stepNote(key) {
  const step = lastRun.value?.steps?.[key]
  if (!step) return ''
  if (key === 'dns' && step.added?.length) return `${step.added.length} record(s) added`
  if (key === 'custom_domain' && step.state) return step.state
  if (key === 'site') return step.created ? 'created' : 'reused'
  return step.ok ? 'done' : 'check log'
}

async function runPreview() {
  previewing.value = true
  error.value = ''
  preview.value = null
  try {
    preview.value = await previewHosting({
      schoolId: props.schoolId,
      siteId: siteId.value,
      subdomain: subdomain.value,
      withDomain: withDomain.value,
    })
  } catch (e) {
    error.value = e.message
  } finally {
    previewing.value = false
  }
}

async function publish() {
  publishing.value = true
  error.value = ''
  try {
    const res = await provisionHosting({
      schoolId: props.schoolId,
      siteId: siteId.value,
      subdomain: subdomain.value,
      withDomain: withDomain.value,
    })
    lastRun.value = res
    startPolling(res.runId)
  } catch (e) {
    error.value = e.message
  } finally {
    publishing.value = false
  }
}

async function poll() {
  if (!lastRun.value?.runId) return
  polling.value = true
  try {
    lastRun.value = { ...lastRun.value, ...(await hostingStatus(lastRun.value.runId)) }
    if (['live', 'failed'].includes(lastRun.value.status)) stopPolling()
  } catch (e) {
    error.value = e.message
    stopPolling()
  } finally {
    polling.value = false
  }
}

// The build is ~10 minutes, so a slow poll is plenty and keeps the function's
// invocation count sane. Refresh is always available for the impatient.
function startPolling() {
  stopPolling()
  timer = setInterval(poll, 20000)
}

function stopPolling() {
  if (timer) clearInterval(timer)
  timer = null
}

onBeforeUnmount(stopPolling)
</script>
