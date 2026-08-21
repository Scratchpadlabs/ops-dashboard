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

        <!-- Two halves of "custom domain", split because only one of them
             touches Namecheap. Attaching the domain is a Firebase call and is
             what starts the certificate; writing the records is the part that
             needs API credentials and can damage a live zone, so it is opt-in.
             The .web.app URL needs no DNS at all either way, so a school can go
             live in minutes and get its branded domain whenever. -->
        <label class="flex items-center gap-2 text-sm text-slate-700">
          <Checkbox v-model="withDomain" binary />
          Attach <span class="font-mono text-xs">{{ subdomain || '…' }}.{{ BASE_DOMAIN }}</span>
          to this site in Firebase
        </label>

        <label v-if="withDomain" class="flex items-center gap-2 text-sm text-slate-700 pl-6">
          <Checkbox v-model="writeDns" binary />
          Also write the DNS records in Namecheap automatically
        </label>
        <p v-if="withDomain && !writeDns" class="text-xs text-slate-500 pl-6">
          Leave this off to add the records yourself in Namecheap → Domain List → Manage →
          Advanced DNS. The exact records appear below once Firebase issues them.
        </p>
        <p v-if="withDomain && writeDns"
          class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 ml-6">
          <i class="pi pi-exclamation-triangle text-xs mr-1"></i>
          Writing <span class="font-mono">{{ BASE_DOMAIN }}</span> through the Namecheap API
          replaces the whole zone. This needs the API credentials, the whitelisted egress IP, and a
          populated <span class="font-mono">hosting_config/dns_preserve</span> list — without the
          last one, MX records the API cannot see are lost silently. Run Check first.
        </p>

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
        <!-- Creating a site is not obviously the good outcome. Sites made by
             hand rarely match the slug derived from the school id
             (hillgreenhighschool vs hillgreen-highschool), and taking the
             default there silently builds a SECOND site next to the live one. -->
        <div v-if="!preview.site_exists" class="text-xs text-amber-800 bg-amber-50
          border border-amber-200 rounded-lg px-3 py-2">
          <i class="pi pi-exclamation-triangle text-xs mr-1"></i>
          No Hosting site with this id exists yet. If this school is already served by a site
          created by hand, type that site's exact id above instead — otherwise this creates a
          second site alongside it.
        </div>

        <div v-if="withDomain && preview.dns" class="text-slate-600">
          <template v-if="preview.dns.error">
            <span class="text-red-600">DNS check failed: {{ preview.dns.error }}</span>
          </template>
          <template v-else-if="preview.dns.mode === 'manual'">
            <span class="font-mono">{{ subdomain }}.{{ BASE_DOMAIN }}</span> will be attached in
            Firebase; its DNS records are yours to add in Namecheap afterwards.
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
            records are in place and the certificate is issued.
          </template>
        </div>

        <!-- The records to type into Namecheap. Recomputed server-side on every
             poll, because Firebase rarely has them ready at the moment the
             domain is attached. -->
        <div v-if="withDomain && !writeDns" class="pt-2 border-t border-slate-100 space-y-2">
          <div class="flex items-center justify-between">
            <div class="text-sm font-semibold text-slate-800">Add these in Namecheap</div>
            <Button v-if="manualDns.length" label="Copy" icon="pi pi-copy" text size="small"
              @click="copyDns" />
          </div>

          <p v-if="!manualDns.length" class="text-xs text-slate-500">
            Waiting for Firebase to issue the records for
            <span class="font-mono">{{ lastRun.domain }}</span>. They usually appear within a
            minute — this refreshes on its own, or press Refresh above.
          </p>

          <div v-else class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-slate-500">
                  <th class="py-1 pr-3 font-medium">Host</th>
                  <th class="py-1 pr-3 font-medium">Type</th>
                  <th class="py-1 pr-3 font-medium">Value</th>
                  <th class="py-1 font-medium">TTL</th>
                </tr>
              </thead>
              <tbody class="font-mono">
                <tr v-for="(r, i) in manualDns" :key="`${r.type}-${r.value}-${i}`"
                  class="border-t border-slate-100">
                  <td class="py-1 pr-3">{{ r.host }}</td>
                  <td class="py-1 pr-3">{{ r.type }}</td>
                  <td class="py-1 pr-3 break-all">{{ r.value }}</td>
                  <td class="py-1">{{ r.ttl || 'Automatic' }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p v-if="manualDns.length" class="text-xs text-slate-400">
            Namecheap → Domain List → Manage → Advanced DNS. Certificate issue can take a few
            hours after the records propagate; the
            <span class="font-mono">.web.app</span> URL works immediately.
          </p>
          <p v-if="copied" class="text-xs text-emerald-600">Copied.</p>
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
  { key: 'dns', label: 'DNS records' },
  { key: 'build_dispatched', label: 'Build started' },
]

const siteId = ref('')
const subdomain = ref('')
const withDomain = ref(true)
// Off by default: the Namecheap write is the only step here that can damage
// something already live, and the records are short enough to enter by hand.
const writeDns = ref(false)
const copied = ref(false)

const previewing = ref(false)
const publishing = ref(false)
const polling = ref(false)
const preview = ref(null)
const lastRun = ref(null)
const error = ref('')

let timer = null

const canRun = computed(() => !!props.schoolId && !!siteId.value)

const manualDns = computed(() => lastRun.value?.manual_dns || [])

async function copyDns() {
  const text = manualDns.value
    .map((r) => `${r.host}\t${r.type}\t${r.value}\t${r.ttl || 'Automatic'}`)
    .join('\n')
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    // Clipboard access is blocked in some contexts; the table is right there.
    copied.value = false
  }
}

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
  if (key === 'dns') {
    if (step.mode === 'manual') return 'to add by hand'
    if (step.added?.length) return `${step.added.length} record(s) added`
  }
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
      writeDns: writeDns.value,
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
      writeDns: writeDns.value,
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
//
// The first poll fires straight away rather than waiting out the interval:
// provision returns before Firebase has computed the DNS records, so the
// records-to-add table would otherwise sit empty for 20 seconds on exactly the
// screen ops is waiting on.
function startPolling() {
  stopPolling()
  poll()
  timer = setInterval(poll, 20000)
}

function stopPolling() {
  if (timer) clearInterval(timer)
  timer = null
}

onBeforeUnmount(stopPolling)
</script>
