<template>
  <div class="min-h-screen" style="background: var(--surface-ground)">

    <!-- ── STAT CARDS ──────────────────────────────────────────────────── -->
    <div class="grid grid-cols-5 gap-4 mb-6">
      <div
        v-for="stat in stats"
        :key="stat.label"
        class="rounded-2xl p-5 flex flex-col gap-2 shadow-sm border transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
        :style="{ background: stat.bg, borderColor: stat.border }"
      >
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-widest" :style="{ color: stat.labelColor }">{{ stat.label }}</span>
          <span class="text-xl">{{ stat.emoji }}</span>
        </div>
        <div class="text-3xl font-black tracking-tight" :style="{ color: stat.valueColor }">
          <span v-if="loading">—</span>
          <AnimatedNumber v-else :value="stat.rawValue" :prefix="stat.prefix" />
        </div>
        <div class="text-xs font-medium" :style="{ color: stat.subColor }">{{ stat.sub }}</div>
      </div>
    </div>

    <!-- ── QUICK LINKS + RECENT WINS ──────────────────────────────────── -->
    <div class="grid grid-cols-5 gap-5">

      <!-- Quick Links — 3 cols -->
      <div class="col-span-3 bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 class="font-bold text-slate-900 text-sm">Quick Links</h3>
            <p class="text-xs text-slate-400 mt-0.5">Your most-used files</p>
          </div>
          <Button icon="pi pi-plus" size="small" text @click="openAddLink" />
        </div>

        <!-- Empty state -->
        <div v-if="links.length === 0 && !linksLoading" class="flex flex-col items-center justify-center py-14 text-center px-6">
          <div class="text-4xl mb-3">🔗</div>
          <p class="text-slate-500 font-medium text-sm">No links yet</p>
          <p class="text-slate-400 text-xs mt-1">Add your Google Sheets, Docs, and other tools</p>
          <Button label="Add your first link" size="small" class="mt-4" @click="openAddLink" />
        </div>

        <!-- Links grid -->
        <div v-else class="p-4 grid grid-cols-2 gap-3">
          <a
            v-for="link in links"
            :key="link.id"
            :href="link.url"
            target="_blank"
            rel="noopener"
            class="group flex items-center gap-3 p-3 rounded-xl border border-slate-100 hover:border-blue-200 hover:bg-blue-50 transition-all duration-150 cursor-pointer no-underline"
          >
            <div class="w-9 h-9 rounded-xl flex items-center justify-center text-lg flex-shrink-0" style="background: #f1f5f9">
              {{ link.emoji || '🔗' }}
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-semibold text-slate-800 truncate group-hover:text-blue-700">{{ link.name }}</div>
              <div class="text-xs text-slate-400 truncate">{{ link.url }}</div>
            </div>
            <button
              @click.prevent="deleteLink(link)"
              class="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-400 transition-all p-1 rounded"
            >
              <i class="pi pi-times text-xs"></i>
            </button>
          </a>
        </div>
      </div>

      <!-- Recent Wins — 2 cols -->
      <div class="col-span-2 bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
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
        <div v-else class="divide-y divide-slate-50 overflow-y-auto" style="max-height: 380px">
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

    <!-- ── MY TASKS ─────────────────────────────────────────────────────── -->
    <div class="mt-5 bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h3 class="font-bold text-slate-900 text-sm">My Tasks 📌</h3>
          <p class="text-xs text-slate-400 mt-0.5">Assigned to you</p>
        </div>
        <RouterLink to="/tasks" class="text-xs font-semibold text-blue-600 hover:text-blue-700">View all →</RouterLink>
      </div>

      <div v-if="overdueMyTasksCount > 0" class="px-5 py-2 bg-red-50 border-b border-red-100 text-xs font-semibold text-red-600 flex items-center gap-1.5">
        <i class="pi pi-exclamation-circle"></i>{{ overdueMyTasksCount }} overdue task{{ overdueMyTasksCount === 1 ? '' : 's' }} need attention
      </div>

      <div v-if="tasksLoading" class="flex items-center justify-center py-10">
        <ProgressSpinner style="width:24px;height:24px" />
      </div>
      <div v-else-if="myTasksPreview.length === 0" class="flex flex-col items-center justify-center py-10 text-center px-6">
        <div class="text-3xl mb-2">🏖️</div>
        <p class="text-slate-400 text-xs font-medium">All clear, nothing on your plate 🏖️</p>
      </div>
      <div v-else class="divide-y divide-slate-50">
        <RouterLink
          v-for="t in myTasksPreview" :key="t.id" to="/tasks"
          class="px-5 py-2.5 flex items-center gap-3 hover:bg-slate-50 transition-colors no-underline"
        >
          <span class="w-2 h-2 rounded-full flex-shrink-0" :class="priorityDotClass(t.priority)"></span>
          <span class="flex-1 min-w-0 text-sm text-slate-800 font-medium truncate">{{ t.title }}</span>
          <span v-if="!t.assignee" class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-500 flex-shrink-0">Unassigned</span>
          <span
            v-if="t.due_date"
            class="text-xs font-medium flex-shrink-0"
            :class="isTaskOverdue(t) ? 'text-red-500 font-bold' : 'text-slate-400'"
          >{{ formatTaskDue(t.due_date) }}</span>
        </RouterLink>
      </div>
    </div>

    <!-- ── DELIVERY PIPELINE ────────────────────────────────────────────── -->
    <div v-if="pipelineRows.length" class="mt-5 bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div class="px-5 py-4 border-b border-slate-100">
        <h3 class="font-bold text-slate-900 text-sm">Delivery Pipeline 🚀</h3>
        <p class="text-xs text-slate-400 mt-0.5">Operations and data receivable progress across active schools</p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs text-slate-400 uppercase tracking-wide border-b border-slate-100">
              <th class="px-5 py-2.5 font-semibold">School</th>
              <th class="px-3 py-2.5 font-semibold">Onboarding</th>
              <th class="px-3 py-2.5 font-semibold">Terms</th>
              <th class="px-3 py-2.5 font-semibold">Final</th>
              <th class="px-3 py-2.5 font-semibold text-right">Operations %</th>
              <th class="px-5 py-2.5 font-semibold text-right">Data Receivable %</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in pipelineRows"
              :key="row.schoolId"
              class="border-b border-slate-50 last:border-0 hover:bg-slate-50 cursor-pointer transition-colors"
              @click="router.push(`/schools/${row.schoolId}`)"
            >
              <td class="px-5 py-3 font-medium text-slate-800">{{ row.schoolName }}</td>
              <td class="px-3 py-3 text-slate-500">{{ row.onboarding.done }}/{{ row.onboarding.total }}</td>
              <td class="px-3 py-3 text-slate-500">{{ row.terms.done }}/{{ row.terms.total }}</td>
              <td class="px-3 py-3 text-slate-500">{{ row.final.done }}/{{ row.final.total }}</td>
              <td class="px-3 py-3 text-right">
                <span
                  class="px-2 py-0.5 rounded-full text-xs font-bold"
                  :style="{ background: pipelineColor(row.overall).bg, color: pipelineColor(row.overall).text }"
                >{{ row.overall }}%</span>
              </td>
              <td class="px-5 py-3 text-right">
                <span
                  v-if="row.dataReceivablePct !== null"
                  class="px-2 py-0.5 rounded-full text-xs font-bold"
                  :style="{ background: pipelineColor(row.dataReceivablePct).bg, color: pipelineColor(row.dataReceivablePct).text }"
                >{{ row.dataReceivablePct }}%</span>
                <span v-else class="text-xs text-slate-300">—</span>
              </td>
            </tr>
          </tbody>
        </table>
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

    <!-- ── ADD LINK DIALOG ─────────────────────────────────────────────── -->
    <Dialog v-model:visible="linkDialogVisible" header="Add Quick Link" modal :style="{ width: '420px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Name *</label>
          <InputText v-model="linkForm.name" class="w-full" placeholder="e.g. Quotation Sheet" />
        </div>
        <div>
          <label class="form-label">URL *</label>
          <InputText v-model="linkForm.url" class="w-full" placeholder="https://docs.google.com/..." />
        </div>
        <div>
          <label class="form-label">Emoji (optional)</label>
          <div class="flex items-center gap-2 mb-2">
            <div class="w-10 h-10 rounded-lg flex items-center justify-center text-xl border border-slate-200 flex-shrink-0" style="background:#f8fafc">
              {{ linkForm.emoji || '🔗' }}
            </div>
            <InputText v-model="linkForm.emoji" class="flex-1" placeholder="or type a custom emoji" maxlength="4" />
          </div>
          <div class="grid grid-cols-10 gap-1">
            <button
              v-for="e in emojiOptions"
              :key="e"
              type="button"
              @click="linkForm.emoji = e"
              class="w-7 h-7 flex items-center justify-center rounded-md text-base hover:bg-slate-100 transition-colors"
              :class="linkForm.emoji === e ? 'bg-blue-100 ring-1 ring-blue-300' : ''"
            >{{ e }}</button>
          </div>
        </div>
        <div v-if="linkError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ linkError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="linkDialogVisible = false" />
        <Button label="Add Link" :loading="linkSaving" @click="saveLink" />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, defineComponent, h } from 'vue'
import { useRouter } from 'vue-router'
import { auth } from '../firebase/config'
import { opsCollection, opsDoc } from '../firebase/collections.js'
import { getDocs, addDoc, deleteDoc, orderBy, query, serverTimestamp, limit } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import { useTasks, priorityDotClass, isTaskOverdue, sortTasksForWidget, displayNameFromEmail } from '../composables/useTasks.js'

import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

// ── Animated number component ──────────────────────────────────────────────
const AnimatedNumber = defineComponent({
  props: { value: Number, prefix: { type: String, default: '' } },
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
    return () => h('span', {},
      props.prefix + Math.round(displayed.value).toLocaleString('en-IN')
    )
  }
})

const router   = useRouter()
const confirm  = useConfirm()
const toast    = useToast()

const loading      = ref(true)
const linksLoading = ref(true)
const links        = ref([])

// Data
const schools   = ref([])
const invoices  = ref([])
const agreements = ref([])
const operationsData = ref([])
const dataReceivableData = ref([])

// ── Stats ──────────────────────────────────────────────────────────────────
const paidInvoices   = computed(() => invoices.value.filter(i => i.status === 'paid'))
const unpaidInvoices = computed(() => invoices.value.filter(i => i.status !== 'paid'))
const signedAgreements = computed(() => agreements.value.filter(a => a.status === 'Signed'))

const totalCollected  = computed(() => paidInvoices.value.reduce((s, i) => s + (i.price_per_student || 0) * (i.quantity || 0), 0))
const totalOutstanding = computed(() => unpaidInvoices.value.reduce((s, i) => s + (i.price_per_student || 0) * (i.quantity || 0), 0))
const totalStudents = computed(() => schools.value.reduce((s, sch) => s + (sch.student_count || 0), 0))

const stats = computed(() => [
  {
    label: 'Schools', emoji: '🏫',
    rawValue: schools.value.length, prefix: '',
    sub: 'active partners',
    bg: '#eff6ff', border: '#dbeafe',
    labelColor: '#3b82f6', valueColor: '#1e3a8a', subColor: '#93c5fd',
  },
  {
    label: 'Collected', emoji: '💰',
    rawValue: totalCollected.value, prefix: '₹',
    sub: `${paidInvoices.value.length} paid invoices`,
    bg: '#f0fdf4', border: '#bbf7d0',
    labelColor: '#16a34a', valueColor: '#14532d', subColor: '#86efac',
  },
  {
    label: 'Outstanding', emoji: '⏳',
    rawValue: totalOutstanding.value, prefix: '₹',
    sub: `${unpaidInvoices.value.length} pending`,
    bg: '#fffbeb', border: '#fde68a',
    labelColor: '#d97706', valueColor: '#78350f', subColor: '#fcd34d',
  },
  {
    label: 'Agreements Signed', emoji: '✍️',
    rawValue: signedAgreements.value.length, prefix: '',
    sub: `of ${agreements.value.length} total`,
    bg: '#fdf4ff', border: '#e9d5ff',
    labelColor: '#9333ea', valueColor: '#3b0764', subColor: '#d8b4fe',
  },
  {
    label: 'Total Students', emoji: '🎓',
    rawValue: totalStudents.value, prefix: '',
    sub: `across ${schools.value.length} schools`,
    bg: '#f0fdfa', border: '#99f6e4',
    labelColor: '#0d9488', valueColor: '#134e4a', subColor: '#5eead4',
  },
])

// ── Recent Wins ─────────────────────────────────────────────────────────────
const recentWins = computed(() => {
  const items = []

  paidInvoices.value.forEach(inv => {
    const ts = inv.paid_on?.toDate ? inv.paid_on.toDate() : inv.created_at?.toDate?.()
    items.push({
      id:       'inv-' + inv.id,
      emoji:    '💰', bg: '#f0fdf4',
      title:    `Payment received — ${inv.school_name}`,
      sub:      `₹${Number((inv.price_per_student || 0) * (inv.quantity || 0)).toLocaleString('en-IN')}`,
      subColor: '#16a34a',
      time:     ts ? timeAgo(ts) : '',
      sortTs:   ts || new Date(0),
    })
  })

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

// ── My Tasks widget ─────────────────────────────────────────────────────────
const { tasks: myTasksData, tasksLoading, loadTasks: loadMyTasks } = useTasks()
const currentUserName = computed(() => displayNameFromEmail(auth.currentUser?.email))
const myOpenTasks = computed(() => myTasksData.value.filter(t => t.status !== 'done' && (!t.assignee || t.assignee === currentUserName.value)))
const myTasksPreview = computed(() => sortTasksForWidget(myOpenTasks.value).slice(0, 6))
const overdueMyTasksCount = computed(() => myOpenTasks.value.filter(isTaskOverdue).length)

function formatTaskDue(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

// ── Load ────────────────────────────────────────────────────────────────────
async function loadAll() {
  loading.value = true
  try {
    const [sSnap, iSnap, aSnap] = await Promise.all([
      getDocs(query(opsCollection('schools'),    orderBy('created_at', 'desc'), limit(500))),
      getDocs(query(opsCollection('invoices'),   orderBy('created_at', 'desc'), limit(500))),
      getDocs(query(opsCollection('agreements'), orderBy('created_at', 'desc'), limit(500))),
    ])
    schools.value    = sSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    invoices.value   = iSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(i => !i.deleted)
    agreements.value = aSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

async function loadOperationsData() {
  try {
    const snap = await getDocs(opsCollection('school_operations'))
    operationsData.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load operations data', e)
  }
}

async function loadDataReceivableData() {
  try {
    const snap = await getDocs(opsCollection('school_data_receivable'))
    dataReceivableData.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load data receivable data', e)
  }
}

function opsProgress(items) {
  const total = items.length
  const done = items.filter(i => i.done).length
  return { done, total }
}

function receivablePercent(schoolId) {
  const dr = dataReceivableData.value.find(d => d.school_id === schoolId)
  if (!dr || !dr.phases) return null
  const all = [
    ...(dr.phases.onboarding || []),
    ...(dr.phases.term1 || []),
    ...(dr.phases.term2 || []),
    ...(dr.phases.final || []),
  ]
  if (!all.length) return 0
  return Math.round(all.filter(i => i.received).length / all.length * 100)
}

const pipelineRows = computed(() => {
  return operationsData.value
    .map(op => {
      const school = schools.value.find(s => s.id === op.school_id)
      if (!school) return null
      const onboarding = opsProgress(op.onboarding || [])
      const terms = opsProgress((op.terms || []).flatMap(t => t.items || []))
      const final = opsProgress(op.final_term || [])
      const totalDone = onboarding.done + terms.done + final.done
      const totalAll  = onboarding.total + terms.total + final.total
      const overall = totalAll ? Math.round(totalDone / totalAll * 100) : 0
      const dataReceivablePct = receivablePercent(school.id)
      return { schoolId: school.id, schoolName: school.name, onboarding, terms, final, overall, dataReceivablePct }
    })
    .filter(Boolean)
    .sort((a, b) => a.overall - b.overall)
})

function pipelineColor(pct) {
  if (pct >= 80) return { bg: '#f0fdf4', text: '#16a34a' }
  if (pct >= 50) return { bg: '#fffbeb', text: '#d97706' }
  return { bg: '#fef2f2', text: '#dc2626' }
}

async function loadLinks() {
  linksLoading.value = true
  try {
    const snap = await getDocs(query(opsCollection('links'), orderBy('created_at', 'asc'), limit(500)))
    links.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error(e)
  } finally {
    linksLoading.value = false
  }
}

// ── Quick Links CRUD ────────────────────────────────────────────────────────
const linkDialogVisible = ref(false)
const linkSaving        = ref(false)
const linkError         = ref('')
const linkForm          = ref({ name: '', url: '', emoji: '' })

const emojiOptions = [
  '📊', '📈', '📋', '📁', '📂', '🗂️', '📝', '✅', '🎯', '💡',
  '🔗', '📌', '📎', '🗃️', '💼', '🏫', '👥', '📅', '🗓️', '⚡',
  '🚀', '💰', '📣', '🔔', '📧', '📱', '🖥️', '⚙️', '🎨', '🌟',
]

function openAddLink() {
  if (links.value.length >= 6) {
    toast.add({ severity: 'warn', summary: 'Max 6 links', detail: 'Remove one to add another', life: 3000 })
    return
  }
  linkForm.value = { name: '', url: '', emoji: '' }
  linkError.value = ''
  linkDialogVisible.value = true
}

async function saveLink() {
  if (!linkForm.value.name.trim()) { linkError.value = 'Name is required'; return }
  if (!linkForm.value.url.trim())  { linkError.value = 'URL is required';  return }
  linkSaving.value = true
  try {
    await addDoc(opsCollection('links'), {
      name:       linkForm.value.name.trim(),
      url:        linkForm.value.url.trim(),
      emoji:      linkForm.value.emoji.trim() || '🔗',
      created_at: serverTimestamp(),
      created_by: auth.currentUser?.email || 'unknown',
    })
    linkDialogVisible.value = false
    await loadLinks()
    toast.add({ severity: 'success', summary: 'Link added', life: 2000 })
  } catch (e) {
    linkError.value = 'Could not save. Try again.'
  } finally {
    linkSaving.value = false
  }
}

async function deleteLink(link) {
  confirm.require({
    message: `Remove "${link.name}"?`,
    header: 'Remove Link',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Remove', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(opsDoc('links', link.id))
        await loadLinks()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', life: 3000 })
      }
    }
  })
}

// ── Inspiration band ─────────────────────────────────────────────────────────
const quotes = [
  "Every school we onboard is a child's future made brighter. 🌟",
  'Revenue is the fuel, impact is the engine. 🚀',
  'Small team. Big mission. Changing education one HPC at a time. 💪',
  'Every signed agreement is a promise kept. ✍️',
  "The best edtech isn't about tech — it's about the teacher who uses it. 🏫",
  "Growth isn't just in the numbers. It's in every student who gets seen. 💙",
]
const quoteIndex = ref(0)
let quoteTimer = null

const tickerStats = computed(() => [
  `🏫 ${schools.value.length} School Partner${schools.value.length === 1 ? '' : 's'}`,
  `💰 ₹${totalCollected.value.toLocaleString('en-IN')} Collected`,
  `✍️ ${signedAgreements.value.length} Agreement${signedAgreements.value.length === 1 ? '' : 's'}`,
  `📄 ${invoices.value.length} Invoice${invoices.value.length === 1 ? '' : 's'} Raised`,
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

onMounted(() => {
  Promise.all([loadAll(), loadLinks(), loadOperationsData(), loadDataReceivableData(), loadMyTasks()])
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
.form-label {
  display: block; font-size: 12px; font-weight: 500;
  color: #64748b; margin-bottom: 4px;
  text-transform: uppercase; letter-spacing: 0.04em;
}

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
