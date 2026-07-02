<template>
  <div class="min-h-screen flex" style="background: var(--surface-ground)">
    
    <!-- Sidebar -->
    <aside class="w-56 min-h-screen flex flex-col border-r" style="background: #0f172a; border-color: #1e293b">
      <div class="px-5 py-5 border-b flex items-center" style="border-color: #1e293b">
        <img src="/logo.png" class="w-32 object-contain" />
      </div>

      <nav class="flex-1 px-3 py-4 space-y-1">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150"
          :class="isActive(item.to)
            ? 'text-white bg-blue-600'
            : 'text-slate-400 hover:text-white hover:bg-slate-800'"
        >
          <i :class="item.icon" class="text-base w-4 text-center"></i>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <!-- Academic year switcher -->
      <div class="px-3 py-3 border-t relative" style="border-color: #1e293b">
        <button
          @click="yearDropdownOpen = !yearDropdownOpen"
          class="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold text-slate-300 hover:bg-slate-800 transition-colors"
        >
          <span>{{ selectedYear === 'all' ? 'All Years' : `AY ${selectedYear}` }}</span>
          <i
            class="pi pi-chevron-down text-[10px] transition-transform duration-150"
            :style="{ transform: yearDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)' }"
          ></i>
        </button>

        <div
          v-if="yearDropdownOpen"
          class="absolute bottom-full left-3 right-3 mb-1 rounded-lg overflow-hidden border shadow-lg"
          style="background: #1e293b; border-color: #334155"
        >
          <button
            v-for="y in academicYears"
            :key="y"
            @click="selectYear(y)"
            class="w-full text-left px-3 py-2 text-xs transition-colors"
            :class="selectedYear === y ? 'text-white bg-slate-700' : 'text-slate-400 hover:bg-slate-700 hover:text-white'"
          >
            AY {{ y }}
          </button>
          <button
            @click="selectYear('all')"
            class="w-full text-left px-3 py-2 text-xs border-t transition-colors"
            style="border-color: #334155"
            :class="selectedYear === 'all' ? 'text-white bg-slate-700' : 'text-slate-400 hover:bg-slate-700 hover:text-white'"
          >
            All Years
          </button>
        </div>
      </div>

      <div class="px-5 py-4 border-t" style="border-color: #1e293b">
        <div class="text-xs" style="color: #334155">ClarifiEd · {{ currentYear }}</div>
      </div>
    </aside>

    <!-- Main -->
    <div class="flex-1 flex flex-col min-h-screen">
      <header class="h-14 border-b flex items-center px-6 bg-white" style="border-color: var(--surface-border)">
        <h1 class="text-sm font-semibold" style="color: var(--text-primary)">{{ pageTitle }}</h1>
      </header>

      <main class="flex-1 p-6">
        <RouterView />
      </main>
    </div>

    <Toast />
    <CelebrationOverlay />
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import Toast from 'primevue/toast'
import CelebrationOverlay from './components/shared/CelebrationOverlay.vue'

const route = useRoute()
const currentYear = new Date().getFullYear()

// ── Academic year switcher ───────────────────────────────────────────────
const academicYears = computed(() => {
  const today = new Date()
  const startYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1
  const years = []
  for (let i = 0; i < 4; i++) {
    const y = startYear - i
    years.push(`${y}-${String(y + 1).slice(-2)}`)
  }
  return years
})

const selectedYear = ref(academicYears.value[0])
const yearDropdownOpen = ref(false)

function selectYear(y) {
  selectedYear.value = y
  yearDropdownOpen.value = false
}

const navItems = [
  { to: '/',            label: 'Dashboard',   icon: 'pi pi-home' },
  { to: '/schools',     label: 'Schools',     icon: 'pi pi-building' },
  { to: '/quotations',  label: 'Quotations',  icon: 'pi pi-file' },
  { to: '/agreements',  label: 'Agreements',  icon: 'pi pi-file-edit' },
  { to: '/invoices',    label: 'Invoices',    icon: 'pi pi-receipt' },
  { to: '/settings',    label: 'Settings',    icon: 'pi pi-cog' },
]

const pageTitles = {
  'dashboard':  'Dashboard',
  'schools':    'Schools',
  'quotations': 'Quotations',
  'agreements': 'Agreements',
  'invoices':   'Invoices',
  'settings':   'Settings',
}

const pageTitle = computed(() => pageTitles[route.name] || 'Dashboard')

const isActive = (path) => {
  if (path === '/') return route.path === '/'
  return route.path.startsWith(path)
}
</script>
