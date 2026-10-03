<template>
  <div class="max-w-6xl">
    <div class="flex items-start justify-between gap-3 mb-4 flex-wrap">
      <div>
        <div class="text-sm font-bold text-slate-900">School Websites</div>
        <p class="text-xs text-slate-500 mt-0.5 max-w-2xl">
          Every Firebase Hosting site in the project, the domain it is served on, and the school it belongs to.
          Domains are read live from Firebase. If a site shows the wrong school, or none, pick the right one —
          that choice then wins over everything else.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <InputText v-model="search" placeholder="Search school, site or domain" size="small" class="w-64" />
        <Button icon="pi pi-refresh" size="small" text rounded :loading="loading" v-tooltip.top="'Reload'" @click="reload" />
      </div>
    </div>

    <div v-if="error" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">
      {{ error }}
      <span class="block text-xs text-red-500 mt-1">If this says the request failed with 404, the hosting_sites function has not been deployed yet.</span>
    </div>

    <div v-if="loading && !sites.length" class="text-sm text-slate-500 flex items-center gap-2 py-10 justify-center">
      <i class="pi pi-spin pi-spinner"></i> Reading sites and domains from Firebase…
    </div>

    <template v-else-if="sites.length">
      <div class="flex gap-3 text-xs text-slate-500 mb-2">
        <span><b class="text-slate-700">{{ sites.length }}</b> sites</span>
        <span><b class="text-slate-700">{{ sites.filter(s => s.schoolId).length }}</b> linked to a school</span>
        <span v-if="schoolsWithout.length"><b class="text-amber-700">{{ schoolsWithout.length }}</b> active schools with no website</span>
      </div>

      <div class="border border-slate-200 rounded-xl overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
            <tr>
              <th class="text-left font-medium px-3 py-2">School</th>
              <th class="text-left font-medium px-3 py-2">Website</th>
              <th class="text-left font-medium px-3 py-2">Firebase site</th>
              <th class="text-left font-medium px-3 py-2 w-28">Matched by</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="site in filtered" :key="site.siteId" class="border-t border-slate-100 align-top">
              <td class="px-3 py-2 w-80">
                <Select
                  :modelValue="site.schoolId || ''" :options="schoolOptions" optionLabel="label" optionValue="value"
                  filter size="small" class="w-full" :loading="savingSite === site.siteId" :disabled="!!savingSite"
                  @update:modelValue="v => reassign(site, v)"
                />
                <div v-if="site.schoolId && !schoolName(site.schoolId)" class="text-[11px] text-red-500 mt-1">
                  “{{ site.schoolId }}” is not a school in the database — pick the right one.
                </div>
              </td>
              <td class="px-3 py-2">
                <div v-for="d in site.domains" :key="d.domain" class="flex items-center gap-1.5">
                  <a :href="`https://${d.domain}`" target="_blank" rel="noopener" class="text-blue-600 hover:underline">{{ d.domain }}</a>
                  <span v-if="!d.live" class="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700" :title="d.state">setting up</span>
                </div>
                <span v-if="!site.domains.length" class="text-xs text-slate-400">No custom domain</span>
              </td>
              <td class="px-3 py-2">
                <a :href="site.defaultUrl" target="_blank" rel="noopener" class="text-slate-600 hover:underline font-mono text-xs">
                  {{ site.defaultUrl.replace('https://', '') }}
                </a>
              </td>
              <td class="px-3 py-2">
                <span class="text-[11px] px-2 py-0.5 rounded-full" :class="SOURCES[site.source]?.cls || 'bg-slate-100 text-slate-400'"
                      :title="SOURCES[site.source]?.hint || 'Nothing links this site to a school'">
                  {{ SOURCES[site.source]?.label || '—' }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="schoolsWithout.length" class="mt-5">
        <div class="text-xs font-semibold text-slate-600 mb-1.5">Active schools with no website</div>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="s in schoolsWithout" :key="s.id" class="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-600">{{ s.name || s.id }}</span>
        </div>
        <p class="text-[11px] text-slate-400 mt-1.5">
          Either they have not been published yet (School Setup → Publish), or their site is in the table above and just needs its school picked.
        </p>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { getDocs, query, orderBy, limit } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import { rootSchoolsCollection } from '../../firebase/schoolCollections.js'
import { useSchoolWebsites } from '../../composables/useSchoolWebsites.js'

const toast = useToast()
const { sites, loading, error, load, assign } = useSchoolWebsites()

const SOURCES = {
  assigned: { label: 'Picked here', cls: 'bg-blue-50 text-blue-700', hint: 'Chosen on this page' },
  provisioned: { label: 'Publish tab', cls: 'bg-green-50 text-green-700', hint: 'Created from School Setup → Publish' },
  legacy: { label: 'Old config', cls: 'bg-slate-100 text-slate-600', hint: "From the teacher app's schools.json — confirm it" },
}

const schools = ref([])
async function loadSchools() {
  const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name'), limit(500)))
  // Doc id after the spread: root school docs carry their own `id` field.
  schools.value = snap.docs.map(d => ({ ...d.data(), id: d.id }))
}
const schoolName = (id) => schools.value.find(s => s.id === id)?.name || ''
const schoolOptions = computed(() => [
  { value: '', label: '— Not a school (test / unused) —' },
  ...schools.value.map(s => ({ value: s.id, label: s.name ? `${s.name} (${s.id})` : s.id })),
])

const schoolsWithout = computed(() => {
  const linked = new Set(sites.value.map(s => s.schoolId).filter(Boolean))
  return schools.value.filter(s => s.isActive !== false && !linked.has(s.id))
})

const search = ref('')
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return sites.value
  return sites.value.filter(s => [s.siteId, s.schoolId, schoolName(s.schoolId), ...s.domains.map(d => d.domain)]
    .some(v => (v || '').toLowerCase().includes(q)))
})

const savingSite = ref('')
async function reassign(site, schoolId) {
  if ((site.schoolId || '') === schoolId) return
  savingSite.value = site.siteId
  try {
    await assign(site.siteId, schoolId)
    toast.add({ severity: 'success', life: 2500, summary: 'Saved',
      detail: schoolId ? `${site.siteId} → ${schoolName(schoolId) || schoolId}` : `${site.siteId} marked as not a school` })
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not save', detail: e.message, life: 5000 })
  } finally {
    savingSite.value = ''
  }
}

function reload() {
  load(true)
  loadSchools()
}

onMounted(() => {
  load()
  loadSchools().catch(e => console.error('Could not load schools', e))
})
</script>
