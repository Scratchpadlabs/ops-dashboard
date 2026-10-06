<template>
  <div class="min-h-screen" style="background: var(--surface-ground)">

    <!-- ── GREETING ────────────────────────────────────────────────────── -->
    <div class="mb-5">
      <h2 class="text-xl font-bold text-slate-900">{{ greeting }}, {{ currentUserName }} 👋</h2>
      <p class="text-sm text-slate-400 mt-0.5">{{ todayLabel }}</p>
    </div>

    <!-- ── STAT CARDS ──────────────────────────────────────────────────── -->
    <div class="grid grid-cols-4 gap-4 mb-6">
      <component
        :is="stat.to ? RouterLink : 'div'"
        v-for="stat in stats"
        :key="stat.label"
        :to="stat.to"
        class="rounded-2xl p-5 flex flex-col gap-2 shadow-sm border transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md no-underline"
        :style="{ background: stat.bg, borderColor: stat.border }"
      >
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-widest" :style="{ color: stat.labelColor }">{{ stat.label }}</span>
          <span class="text-xl">{{ stat.emoji }}</span>
        </div>
        <div class="text-3xl font-black tracking-tight" :style="{ color: stat.valueColor }">
          <span v-if="stat.loading">—</span>
          <AnimatedNumber v-else :value="stat.rawValue" />
        </div>
        <div class="text-xs font-medium" :style="{ color: stat.subColor }">{{ stat.sub }}</div>
      </component>
    </div>

    <!-- ── MY TASKS + RECENT WINS ──────────────────────────────────────── -->
    <div class="grid grid-cols-3 gap-5">

      <!-- My Tasks -->
      <div class="col-span-2 bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden flex flex-col">
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 class="font-bold text-slate-900 text-sm">My Tasks 📌</h3>
            <p class="text-xs text-slate-400 mt-0.5">Assigned to you, overdue and soonest due first</p>
          </div>
          <RouterLink to="/tasks" class="text-xs font-semibold text-blue-600 hover:text-blue-700">View all →</RouterLink>
        </div>

        <div v-if="overdueMyTasksCount > 0" class="px-5 py-2 bg-red-50 border-b border-red-100 text-xs font-semibold text-red-600 flex items-center gap-1.5">
          <i class="pi pi-exclamation-circle"></i>{{ overdueMyTasksCount }} overdue task{{ overdueMyTasksCount === 1 ? '' : 's' }} need attention
        </div>

        <div v-if="tasksLoading" class="flex items-center justify-center py-10">
          <ProgressSpinner style="width:24px;height:24px" />
        </div>
        <div v-else-if="myTasksPreview.length === 0" class="flex flex-col items-center justify-center py-14 text-center px-6">
          <div class="text-3xl mb-2">🏖️</div>
          <p class="text-slate-400 text-xs font-medium">All clear, nothing on your plate</p>
        </div>
        <div v-else class="divide-y divide-slate-50 overflow-y-auto" style="max-height: 460px">
          <RouterLink
            v-for="t in myTasksPreview" :key="t.id" to="/tasks"
            class="px-5 py-3 flex items-center gap-3 hover:bg-slate-50 transition-colors no-underline"
          >
            <span class="w-2 h-2 rounded-full flex-shrink-0" :class="priorityDotClass(t.priority)"></span>
            <span class="flex-1 min-w-0 text-sm text-slate-800 font-medium truncate">{{ t.title }}</span>
            <span v-if="t.status === 'blocked'" class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-50 text-red-600 flex-shrink-0">Blocked</span>
            <span v-else-if="t.status === 'in_progress'" class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-600 flex-shrink-0">In Progress</span>
            <span v-if="!t.assignee" class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-500 flex-shrink-0">Unassigned</span>
            <span
              v-if="t.due_date"
              class="text-xs font-medium flex-shrink-0 w-14 text-right"
              :class="isTaskOverdue(t) ? 'text-red-500 font-bold' : 'text-slate-400'"
            >{{ formatTaskDue(t.due_date) }}</span>
          </RouterLink>
        </div>
      </div>

      <!-- Recent Wins -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden flex flex-col">
        <div class="px-5 py-4 border-b border-slate-100">
          <h3 class="font-bold text-slate-900 text-sm">Recent Wins</h3>
          <p class="text-xs text-slate-400 mt-0.5">Latest activity</p>
        </div>
        <div v-if="loading" class="flex items-center justify-center py-10">
          <ProgressSpinner style="width:24px;height:24px" />
        </div>
        <div v-else-if="recentWins.length === 0" class="flex flex-col items-center justify-center py-14 text-center px-6">
          <div class="text-4xl mb-3">🏆</div>
          <p class="text-slate-400 text-xs">Your wins will show up here</p>
        </div>
        <div v-else class="divide-y divide-slate-50 overflow-y-auto" style="max-height: 460px">
          <div
            v-for="win in recentWins"
            :key="win.id"
            class="px-5 py-3 flex items-start gap-3 hover:bg-slate-50 transition-colors"
          >
            <div
              class="w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0 mt-0.5"
              :style="{ background: win.bg }"
            >
              {{ win.emoji }}
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm text-slate-800 font-medium leading-snug">{{ win.title }}</p>
              <p v-if="win.sub" class="text-xs font-semibold mt-0.5" :style="{ color: win.subColor }">{{ win.sub }}</p>
              <p class="text-xs text-slate-400 mt-0.5">{{ win.time }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ── INSPIRATION BAND ────────────────────────────────────────────── -->
    <div
      class="mt-5 rounded-2xl overflow-hidden relative"
      style="height: 180px; background: linear-gradient(135deg, #0b1223 0%, #1e293b 100%)"
    >
      <canvas ref="particlesCanvas" class="absolute inset-0 w-full h-full"></canvas>

      <div class="relative z-10 h-full flex flex-col items-center justify-center px-8" style="padding-bottom: 30px">
        <transition name="quote-fade" mode="out-in">
          <p :key="quoteIndex" class="text-white text-lg font-semibold text-center max-w-2xl leading-snug">
            {{ quotes[quoteIndex] }}
          </p>
        </transition>
      </div>

      <div class="absolute bottom-0 left-0 right-0 h-9 flex items-center overflow-hidden" style="background: rgba(0,0,0,0.28)">
        <div class="inline-flex items-center gap-10 whitespace-nowrap ticker-track pl-4">
          <span v-for="(t, i) in [...tickerStats, ...tickerStats]" :key="i" class="text-xs font-medium tracking-wide" style="color: #cbd5e1">
            {{ t }}
          </span>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, defineComponent, h } from 'vue'
import { RouterLink } from 'vue-router'
import { useAutoRefresh } from '../composables/useAutoRefresh.js'
import { auth } from '../firebase/config'
import { opsCollection } from '../firebase/collections.js'
import { getDocs, orderBy, query, limit } from 'firebase/firestore'
import { useTasks, priorityDotClass, isTaskOverdue, sortTasksForWidget, displayNameFromEmail } from '../composables/useTasks.js'

import ProgressSpinner from 'primevue/progressspinner'

// ── Animated number component ──────────────────────────────────────────────
const AnimatedNumber = defineComponent({
  props: { value: Number },
  setup(props) {
    const displayed = ref(0)
    let raf = null
    const animate = () => {
      const target = props.value || 0
      const diff   = target - displayed.value
      if (Math.abs(diff) < 1) { displayed.value = target; return }
      displayed.value += diff * 0.12
      raf = requestAnimationFrame(animate)
    }
    onMounted(() => { raf = requestAnimationFrame(animate) })
    return () => h('span', {}, Math.round(displayed.value).toLocaleString('en-IN'))
  }
})

const loading = ref(true)

// Data
const schools    = ref([])
const agreements = ref([])

// ── Greeting ────────────────────────────────────────────────────────────────
const greeting = computed(() => {
  const hr = new Date().getHours()
  if (hr < 12) return 'Good morning'
  if (hr < 17) return 'Good afternoon'
  return 'Good evening'
})
const todayLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })

// ── My Tasks widget ─────────────────────────────────────────────────────────
const { tasks: myTasksData, tasksLoading, loadTasks: loadMyTasks } = useTasks()
const currentUserName = computed(() => displayNameFromEmail(auth.currentUser?.email))
const myOpenTasks = computed(() => myTasksData.value.filter(t => t.status !== 'done' && (!t.assignee || t.assignee === currentUserName.value)))
const myTasksPreview = computed(() => sortTasksForWidget(myOpenTasks.value).slice(0, 12))
const overdueMyTasksCount = computed(() => myOpenTasks.value.filter(isTaskOverdue).length)
const teamOpenTasks = computed(() => myTasksData.value.filter(t => t.status !== 'done'))
const blockedTeamTasksCount = computed(() => teamOpenTasks.value.filter(t => t.status === 'blocked').length)

function formatTaskDue(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

// ── Stats ──────────────────────────────────────────────────────────────────
const signedAgreements = computed(() => agreements.value.filter(a => a.status === 'Signed'))
const totalStudents = computed(() => schools.value.reduce((s, sch) => s + (sch.student_count || 0), 0))

const stats = computed(() => [
  {
    label: 'Schools', emoji: '🏫', to: '/schools',
    rawValue: schools.value.length, loading: loading.value,
    sub: 'active partners',
    bg: '#eff6ff', border: '#dbeafe',
    labelColor: '#3b82f6', valueColor: '#1e3a8a', subColor: '#93c5fd',
  },
  {
    label: 'Total Students', emoji: '🎓',
    rawValue: totalStudents.value, loading: loading.value,
    sub: `across ${schools.value.length} schools`,
    bg: '#f0fdfa', border: '#99f6e4',
    labelColor: '#0d9488', valueColor: '#134e4a', subColor: '#5eead4',
  },
  {
    label: 'My Open Tasks', emoji: '📌', to: '/tasks',
    rawValue: myOpenTasks.value.length, loading: tasksLoading.value,
    sub: overdueMyTasksCount.value ? `${overdueMyTasksCount.value} overdue` : 'nothing overdue',
    bg: '#fef2f2', border: '#fecaca',
    labelColor: '#dc2626', valueColor: '#7f1d1d', subColor: '#fca5a5',
  },
  {
    label: 'Team Open Tasks', emoji: '👥', to: '/tasks',
    rawValue: teamOpenTasks.value.length, loading: tasksLoading.value,
    sub: blockedTeamTasksCount.value ? `${blockedTeamTasksCount.value} blocked` : 'none blocked',
    bg: '#faf5ff', border: '#e9d5ff',
    labelColor: '#9333ea', valueColor: '#581c87', subColor: '#d8b4fe',
  },
])

// ── Recent Wins ─────────────────────────────────────────────────────────────
const recentWins = computed(() => {
  const items = []

  schools.value.forEach(s => {
    const ts = s.created_at?.toDate?.()
    items.push({
      id:       'sch-' + s.id,
      emoji:    '🏫', bg: '#eff6ff',
      title:    `${s.name} onboarded`,
      sub:      s.city || '',
      subColor: '#3b82f6',
      time:     ts ? timeAgo(ts) : '',
      sortTs:   ts || new Date(0),
    })
  })

  signedAgreements.value.forEach(a => {
    const ts = a.signed_at?.toDate?.() || a.created_at?.toDate?.()
    items.push({
      id:       'agr-' + a.id,
      emoji:    '✍️', bg: '#fdf4ff',
      title:    `Agreement signed — ${a.school_name}`,
      sub:      a.agreement_number || '',
      subColor: '#9333ea',
      time:     ts ? timeAgo(ts) : '',
      sortTs:   ts || new Date(0),
    })
  })

  return items
    .filter(i => i.sortTs)
    .sort((a, b) => b.sortTs - a.sortTs)
    .slice(0, 12)
})

// ── Load ────────────────────────────────────────────────────────────────────
async function loadAll({ silent = false } = {}) {
  if (!silent) loading.value = true
  try {
    const [sSnap, aSnap] = await Promise.all([
      getDocs(query(opsCollection('schools'),    orderBy('created_at', 'desc'), limit(500))),
      getDocs(query(opsCollection('agreements'), orderBy('created_at', 'desc'), limit(500))),
    ])
    schools.value    = sSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    agreements.value = aSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

// ── Inspiration band ─────────────────────────────────────────────────────────
const quotes = [
  "Every school we onboard is a child's future made brighter. 🌟",
  'Small team. Big mission. Changing education one HPC at a time. 💪',
  'Every signed agreement is a promise kept. ✍️',
  "The best edtech isn't about tech — it's about the teacher who uses it. 🏫",
  "Growth isn't just in the numbers. It's in every student who gets seen. 💙",
]
const quoteIndex = ref(0)
let quoteTimer = null

const tickerStats = computed(() => [
  `🏫 ${schools.value.length} School Partner${schools.value.length === 1 ? '' : 's'}`,
  `🎓 ${totalStudents.value.toLocaleString('en-IN')} Students`,
  `✍️ ${signedAgreements.value.length} Agreement${signedAgreements.value.length === 1 ? '' : 's'}`,
  `✅ ${myTasksData.value.filter(t => t.status === 'done').length} Tasks Done`,
])

const particlesCanvas = ref(null)
let particleFrame = null
let particleCleanup = null

function startParticles(canvas) {
  const ctx = canvas.getContext('2d')
  const resize = () => {
    canvas.width = canvas.clientWidth
    canvas.height = canvas.clientHeight
  }
  resize()
  window.addEventListener('resize', resize)

  const particles = Array.from({ length: 34 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    r: Math.random() * 1.6 + 0.6,
    speed: Math.random() * 0.35 + 0.12,
    drift: (Math.random() - 0.5) * 0.12,
    opacity: Math.random() * 0.5 + 0.2,
  }))

  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    particles.forEach(p => {
      p.y -= p.speed
      p.x += p.drift
      if (p.y < -4) { p.y = canvas.height + 4; p.x = Math.random() * canvas.width }
      if (p.x < -4) p.x = canvas.width + 4
      if (p.x > canvas.width + 4) p.x = -4

      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(147, 197, 253, ${p.opacity})`
      ctx.shadowBlur = 6
      ctx.shadowColor = 'rgba(147, 197, 253, 0.8)'
      ctx.fill()
    })
    particleFrame = requestAnimationFrame(draw)
  }
  draw()

  return () => window.removeEventListener('resize', resize)
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function timeAgo(date) {
  const diff = Math.floor((new Date() - date) / 1000)
  if (diff < 60)     return 'just now'
  if (diff < 3600)   return Math.floor(diff / 60) + 'm ago'
  if (diff < 86400)  return Math.floor(diff / 3600) + 'h ago'
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago'
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

// Refresh in place every few minutes / on returning to the tab.
useAutoRefresh(opts => Promise.all([loadAll(opts), loadMyTasks(opts)]))

onMounted(() => {
  Promise.all([loadAll(), loadMyTasks()])
  quoteTimer = setInterval(() => {
    quoteIndex.value = (quoteIndex.value + 1) % quotes.length
  }, 8000)
  if (particlesCanvas.value) particleCleanup = startParticles(particlesCanvas.value)
})

onBeforeUnmount(() => {
  if (quoteTimer) clearInterval(quoteTimer)
  if (particleFrame) cancelAnimationFrame(particleFrame)
  if (particleCleanup) particleCleanup()
})
</script>

<style scoped>
.quote-fade-enter-active,
.quote-fade-leave-active {
  transition: opacity 0.6s ease;
}
.quote-fade-enter-from,
.quote-fade-leave-to {
  opacity: 0;
}

.ticker-track {
  animation: ticker-scroll 24s linear infinite;
}
@keyframes ticker-scroll {
  from { transform: translateX(0); }
  to   { transform: translateX(-50%); }
}
</style>
