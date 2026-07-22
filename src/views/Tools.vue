<template>
  <div>
    <div class="flex items-center gap-1 bg-slate-100 rounded-lg p-1 mb-5 w-fit">
      <button
        v-for="tab in TABS" :key="tab.key"
        @click="activeTab = tab.key"
        class="px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center"
        :class="activeTab === tab.key ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'"
      ><i :class="tab.icon" class="mr-1.5 text-xs"></i>{{ tab.label }}</button>
    </div>

    <!-- Each tab's iframe stays mounted (v-show, not v-if) so switching tabs
         doesn't reload the embedded tool and lose in-progress form state. -->
    <div
      v-for="tab in TABS" :key="tab.key"
      v-show="activeTab === tab.key"
      class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden"
      style="height: calc(100vh - 180px)"
    >
      <iframe v-if="tab.url" :src="tab.url" :title="tab.label" class="w-full h-full border-0"></iframe>
      <div v-else class="w-full h-full overflow-auto p-4">
        <!-- If an in-app tool fails to render, show why instead of a blank panel. -->
        <div v-if="toolError" class="max-w-2xl">
          <div class="text-sm font-semibold text-red-600 mb-2">This tool failed to load</div>
          <pre class="text-xs bg-red-50 border border-red-200 rounded-lg p-3 whitespace-pre-wrap text-red-800">{{ toolError }}</pre>
          <p class="text-xs text-slate-400 mt-2">Send this message to whoever is fixing it.</p>
        </div>
        <ParcelCoverTool v-else-if="tab.key === 'parcel-cover'" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onErrorCaptured } from 'vue'
import ParcelCoverTool from '../components/tools/ParcelCoverTool.vue'

const TABS = [
  { key: 'register', label: 'Register', icon: 'pi pi-user-plus', url: 'https://clarified-register.web.app/' },
  { key: 'parcel-cover', label: 'Parcel Cover', icon: 'pi pi-send' },
]

const activeTab = ref(TABS[0].key)
const toolError = ref('')

onErrorCaptured((err, _instance, info) => {
  toolError.value = `${err?.message || err}\n\nWhere: ${info}\n\n${(err?.stack || '').split('\n').slice(0, 4).join('\n')}`
  console.error('Tool render failed:', err)
  return false   // stop it propagating and blanking the page
})
</script>
