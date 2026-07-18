<template>
  <RouterView v-if="route.name === 'login'" />

  <div v-else class="min-h-screen flex" style="background: var(--surface-ground)">

    <!-- Sidebar -->
    <aside class="w-56 min-h-screen flex flex-col border-r" style="background: #0f172a; border-color: #1e293b">
      <div class="px-5 py-5 border-b flex items-center" style="border-color: #1e293b">
        <div class="bg-white rounded-xl p-2 mx-3 my-3 flex items-center justify-center">
          <img src="/logo.png" class="w-28 object-contain" />
        </div>
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
          <span>{{ activeYear === 'All Years' ? 'All Years' : `AY ${activeYear}` }}</span>
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
            @click="selectYear('All Years')"
            class="w-full text-left px-3 py-2 text-xs transition-colors"
            :class="activeYear === 'All Years' ? 'text-white bg-slate-700' : 'text-slate-400 hover:bg-slate-700 hover:text-white'"
          >
            All Years
          </button>
          <button
            v-for="y in availableYears"
            :key="y"
            @click="selectYear(y)"
            class="w-full text-left px-3 py-2 text-xs border-t transition-colors"
            style="border-color: #334155"
            :class="activeYear === y ? 'text-white bg-slate-700' : 'text-slate-400 hover:bg-slate-700 hover:text-white'"
          >
            AY {{ y }}
          </button>
        </div>
      </div>

      <div class="px-3 py-3 border-t" style="border-color: #1e293b">
        <button
          @click="handleLogout"
          class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition-all duration-150"
        >
          <i class="pi pi-sign-out text-base w-4 text-center"></i>
          <span>Log Out</span>
        </button>
      </div>

      <div class="px-5 py-4 border-t" style="border-color: #1e293b">
        <div class="text-xs" style="color: #334155">ClarifiEd · {{ currentYear }}</div>
      </div>
    </aside>

    <!-- Main -->
    <div class="flex-1 flex flex-col min-h-screen">
      <header class="h-14 border-b flex items-center justify-between px-6 bg-white" style="border-color: var(--surface-border)">
        <h1 class="text-sm font-semibold" style="color: var(--text-primary)">{{ pageTitle }}</h1>
        <div class="flex items-center gap-3">
          <button
            @click="isSearchOpen = true"
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-slate-400 border border-slate-200 hover:border-slate-300 hover:text-slate-500 transition-colors w-64"
          >
            <i class="pi pi-search text-xs"></i>
            <span class="flex-1 text-left">Search anything...</span>
            <span class="text-[10px] font-semibold border border-slate-200 rounded px-1.5 py-0.5">⌘K</span>
          </button>

          <button
            v-if="notificationsSupported"
            v-tooltip.bottom="notificationButtonTooltip"
            @click="onNotificationBellClick"
            class="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors"
            :class="notificationsActive
              ? 'text-blue-600 border-blue-200 bg-blue-50 hover:bg-blue-100'
              : 'text-slate-400 border-slate-200 hover:border-slate-300 hover:text-slate-500'"
          >
            <i :class="notificationsActive ? 'pi pi-bell' : 'pi pi-bell-slash'" class="text-sm"></i>
          </button>
        </div>
      </header>

      <main class="flex-1 p-6">
        <RouterView />
      </main>
    </div>

    <Toast />
    <CelebrationOverlay />
    <GlobalSearchModal />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { signOut } from 'firebase/auth'
import { auth } from './firebase/config'
import { opsCollection } from './firebase/collections.js'
import { getDocs } from 'firebase/firestore'
import { activeYear, availableYears, computeCurrentAcademicYear } from './composables/useAcademicYear.js'
import { isSearchOpen } from './composables/useGlobalSearch.js'
import {
  notificationsSupported, notificationPermission, notificationsEnabled,
  requestTaskNotificationPermission, disableTaskNotifications,
  startTaskNotificationPolling, stopTaskNotificationPolling,
} from './composables/useTaskNotifications.js'
import { useToast } from 'primevue/usetoast'
import Toast from 'primevue/toast'
import CelebrationOverlay from './components/shared/CelebrationOverlay.vue'
import GlobalSearchModal from './components/shared/GlobalSearchModal.vue'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const currentYear = new Date().getFullYear()

// ── Task due/overdue notifications ──────────────────────────────────────────
const notificationsActive = computed(() => notificationsEnabled.value && notificationPermission.value === 'granted')
const notificationButtonTooltip = computed(() => {
  if (notificationPermission.value === 'denied') return 'Blocked — allow notifications for this site in your browser settings'
  return notificationsActive.value ? 'Task notifications on — click to mute' : 'Get notified when tasks are pending or due'
})

async function onNotificationBellClick() {
  if (notificationPermission.value === 'denied') {
    toast.add({ severity: 'warn', summary: 'Notifications blocked', detail: 'Allow notifications for this site in your browser settings, then reload.', life: 4000 })
    return
  }
  if (notificationsActive.value) {
    disableTaskNotifications()
    stopTaskNotificationPolling()
    return
  }
  const result = await requestTaskNotificationPermission()
  if (result === 'granted') {
    startTaskNotificationPolling()
    toast.add({ severity: 'success', summary: 'Notifications enabled', detail: "We'll notify you when tasks are pending or due", life: 3000 })
  } else if (result === 'denied') {
    toast.add({ severity: 'warn', summary: 'Notifications blocked', life: 3000 })
  }
}

onMounted(() => {
  if (notificationsEnabled.value && notificationPermission.value === 'granted') startTaskNotificationPolling()
})
onBeforeUnmount(stopTaskNotificationPolling)

// ── Global search (Ctrl/Cmd+K) ─────────────────────────────────────────────
function onGlobalSearchKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    isSearchOpen.value = true
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalSearchKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalSearchKeydown))

async function handleLogout() {
  await signOut(auth)
  router.push('/login')
}

// ── Academic year switcher ───────────────────────────────────────────────
const yearDropdownOpen = ref(false)

function selectYear(y) {
  activeYear.value = y
  yearDropdownOpen.value = false
}

async function loadAvailableYears() {
  try {
    const [qSnap, aSnap, iSnap] = await Promise.all([
      getDocs(opsCollection('quotations')),
      getDocs(opsCollection('agreements')),
      getDocs(opsCollection('invoices')),
    ])
    const years = new Set([computeCurrentAcademicYear()])
    ;[...qSnap.docs, ...aSnap.docs, ...iSnap.docs].forEach(d => {
      const y = d.data().academic_year
      if (y) years.add(y)
    })
    availableYears.value = Array.from(years).sort().reverse()
  } catch (e) {
    console.error('Could not load academic years', e)
    availableYears.value = [computeCurrentAcademicYear()]
  }
}

// Fetches once — either immediately (if we land on a real page already
// authenticated) or the first time we navigate away from /login after signing in.
let yearsLoaded = false
function maybeLoadAvailableYears() {
  if (yearsLoaded || route.name === 'login') return
  yearsLoaded = true
  loadAvailableYears()
}

onMounted(maybeLoadAvailableYears)
watch(() => route.name, maybeLoadAvailableYears)

const navItems = [
  { to: '/',            label: 'Dashboard',   icon: 'pi pi-home' },
  { to: '/tasks',       label: 'Tasks',       icon: 'pi pi-check-square' },
  { to: '/schools',     label: 'Schools',     icon: 'pi pi-building' },
  { to: '/quotations',  label: 'Quotations',  icon: 'pi pi-file' },
  { to: '/agreements',  label: 'Agreements',  icon: 'pi pi-file-edit' },
  { to: '/invoices',    label: 'Invoices',    icon: 'pi pi-receipt' },
  { to: '/expenses',    label: 'Expenses',    icon: 'pi pi-wallet' },
  { to: '/settings',    label: 'Settings',    icon: 'pi pi-cog' },
]

const pageTitles = {
  'dashboard':  'Dashboard',
  'tasks':      'Tasks',
  'schools':    'Schools',
  'quotations': 'Quotations',
  'agreements': 'Agreements',
  'invoices':   'Invoices',
  'expenses':   'Expenses',
  'settings':   'Settings',
}

const pageTitle = computed(() => pageTitles[route.name] || 'Dashboard')

const isActive = (path) => {
  if (path === '/') return route.path === '/'
  return route.path.startsWith(path)
}
</script>
