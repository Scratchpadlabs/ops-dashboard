<template>
  <div class="min-h-screen flex" style="background: var(--surface-ground)">
    
    <!-- Sidebar -->
    <aside class="w-56 min-h-screen flex flex-col border-r" style="background: #0f172a; border-color: #1e293b">
      <div class="px-5 py-5 border-b" style="border-color: #1e293b">
        <div class="text-white font-semibold text-sm tracking-wide">Scratchpad Labs</div>
        <div class="text-xs mt-0.5" style="color: #64748b">Ops Dashboard</div>
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
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Toast from 'primevue/toast'
import CelebrationOverlay from './components/shared/CelebrationOverlay.vue'

const route = useRoute()
const currentYear = new Date().getFullYear()

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
