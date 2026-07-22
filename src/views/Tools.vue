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
        <ParcelCoverTool v-if="tab.key === 'parcel-cover'" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import ParcelCoverTool from '../components/tools/ParcelCoverTool.vue'

const TABS = [
  { key: 'register', label: 'Register', icon: 'pi pi-user-plus', url: 'https://clarified-register.web.app/' },
  { key: 'parcel-cover', label: 'Parcel Cover', icon: 'pi pi-send' },
]

const activeTab = ref(TABS[0].key)
</script>
