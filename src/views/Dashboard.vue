<template>
  <div>

    <!-- Welcome -->
    <div class="mb-6">
      <h2 class="text-lg font-semibold text-slate-900">Good {{ timeOfDay }}, Sid 👋</h2>
      <p class="text-sm text-slate-500 mt-0.5">Here's where things stand today.</p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <ProgressSpinner style="width:32px;height:32px" />
    </div>

    <div v-else>

      <!-- KPI Cards -->
      <div class="grid grid-cols-4 gap-4 mb-6">
        <div class="bg-white rounded-xl border border-slate-200 p-4">
          <div class="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Schools</div>
          <div class="text-3xl font-bold text-slate-900">{{ stats.schoolCount }}</div>
          <div class="text-xs text-slate-400 mt-1">active partners</div>
        </div>

        <div class="bg-white rounded-xl border border-slate-200 p-4">
          <div class="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Total Receivable</div>
          <div class="text-3xl font-bold text-slate-900">{{ formatRupee(stats.totalReceivable) }}</div>
          <div class="text-xs text-slate-400 mt-1">{{ stats.unpaidCount }} unpaid invoice{{ stats.unpaidCount !== 1 ? 's' : '' }}</div>
        </div>

        <div class="bg-white rounded-xl border border-red-100 p-4" :class="stats.overdueAmount > 0 ? 'bg-red-50' : 'bg-white'">
          <div class="text-xs font-medium uppercase tracking-wide mb-1" :class="stats.overdueAmount > 0 ? 'text-red-400' : 'text-slate-400'">Overdue</div>
          <div class="text-3xl font-bold" :class="stats.overdueAmount > 0 ? 'text-red-600' : 'text-slate-900'">{{ formatRupee(stats.overdueAmount) }}</div>
          <div class="text-xs mt-1" :class="stats.overdueAmount > 0 ? 'text-red-400' : 'text-slate-400'">{{ stats.overdueCount }} overdue</div>
        </div>

        <div class="bg-white rounded-xl border border-slate-200 p-4">
          <div class="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Collected</div>
          <div class="text-3xl font-bold text-green-600">{{ formatRupee(stats.totalCollected) }}</div>
          <div class="text-xs text-slate-400 mt-1">{{ stats.paidCount }} paid invoice{{ stats.paidCount !== 1 ? 's' : '' }}</div>
        </div>
      </div>

      <!-- Two columns -->
      <div class="grid grid-cols-2 gap-5">

        <!-- Overdue invoices -->
        <div class="bg-white rounded-xl border border-slate-200">
          <div class="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <span class="text-sm font-semibold text-slate-900">Overdue Invoices</span>
            <RouterLink to="/invoices" class="text-xs text-blue-600 hover:underline">View all</RouterLink>
          </div>
          <div v-if="overdueInvoices.length === 0" class="px-4 py-8 text-center">
            <i class="pi pi-check-circle text-2xl text-green-400 mb-2 block"></i>
            <p class="text-sm text-slate-400">All clear — no overdue invoices</p>
          </div>
          <div v-else class="divide-y divide-slate-50">
            <div
              v-for="inv in overdueInvoices"
              :key="inv.id"
              class="px-4 py-3 flex items-center justify-between"
            >
              <div>
                <div class="text-sm font-medium text-slate-900">{{ inv.school_name }}</div>
                <div class="text-xs text-slate-400 mt-0.5">{{ inv.invoice_number }} · Due {{ formatDate(inv.due_date) }}</div>
              </div>
              <div class="text-right">
                <div class="text-sm font-bold text-red-600">{{ formatRupee(inv.price_per_student * inv.quantity) }}</div>
                <div class="text-xs text-red-400">{{ daysOverdue(inv.due_date) }}d overdue</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Recent activity -->
        <div class="bg-white rounded-xl border border-slate-200">
          <div class="px-4 py-3 border-b border-slate-100">
            <span class="text-sm font-semibold text-slate-900">Recent Activity</span>
          </div>
          <div v-if="recentActivity.length === 0" class="px-4 py-8 text-center">
            <p class="text-sm text-slate-400">No recent activity</p>
          </div>
          <div v-else class="divide-y divide-slate-50">
            <div
              v-for="item in recentActivity"
              :key="item.id"
              class="px-4 py-3 flex items-center gap-3"
            >
              <div class="w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0" :class="item.iconBg">
                <i :class="item.icon + ' ' + item.iconColor" class="text-xs"></i>
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm text-slate-800 truncate">{{ item.label }}</div>
                <div class="text-xs text-slate-400 mt-0.5">{{ item.time }}</div>
              </div>
              <div v-if="item.amount" class="text-sm font-semibold text-green-600 flex-shrink-0">
                {{ formatRupee(item.amount) }}
              </div>
            </div>
          </div>
        </div>

        <!-- Unpaid by school -->
        <div class="bg-white rounded-xl border border-slate-200 col-span-2">
          <div class="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <span class="text-sm font-semibold text-slate-900">Receivables by School</span>
            <span class="text-xs text-slate-400">Unpaid invoices only</span>
          </div>
          <div v-if="receivablesBySchool.length === 0" class="px-4 py-8 text-center">
            <p class="text-sm text-slate-400">No outstanding receivables</p>
          </div>
          <div v-else class="p-4">
            <div
              v-for="school in receivablesBySchool"
              :key="school.name"
              class="flex items-center gap-3 mb-3 last:mb-0"
            >
              <div class="text-sm text-slate-700 w-48 flex-shrink-0 truncate">{{ school.name }}</div>
              <div class="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                <div
                  class="h-2 rounded-full transition-all"
                  :class="school.hasOverdue ? 'bg-red-500' : 'bg-blue-500'"
                  :style="{ width: school.pct + '%' }"
                ></div>
              </div>
              <div class="text-sm font-semibold text-slate-900 w-28 text-right flex-shrink-0">
                {{ formatRupee(school.amount) }}
              </div>
              <div v-if="school.hasOverdue" class="text-xs text-red-500 flex-shrink-0">⚠ overdue</div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { db } from '../firebase/config'
import { opsCollection, opsDoc } from '../firebase/collections.js'
import { getDocs, orderBy, query } from 'firebase/firestore'
import ProgressSpinner from 'primevue/progressspinner'

const loading  = ref(true)
const schools  = ref([])
const invoices = ref([])
const quotations  = ref([])
const agreements  = ref([])

// ── Time of day ───────────────────────────────────────────────────────────────
const timeOfDay = computed(() => {
  const h = new Date().getHours()
  if (h < 12) return 'morning'
  if (h < 17) return 'afternoon'
  return 'evening'
})

// ── Stats ─────────────────────────────────────────────────────────────────────
const unpaidInvoices = computed(() => invoices.value.filter(i => i.status !== 'paid'))
const paidInvoices   = computed(() => invoices.value.filter(i => i.status === 'paid'))
const overdueInvoices = computed(() =>
  unpaidInvoices.value.filter(i => {
    if (!i.due_date) return false
    const due = i.due_date.toDate ? i.due_date.toDate() : new Date(i.due_date)
    return due < new Date()
  }).sort((a, b) => {
    const da = a.due_date.toDate ? a.due_date.toDate() : new Date(a.due_date)
    const db2 = b.due_date.toDate ? b.due_date.toDate() : new Date(b.due_date)
    return da - db2
  })
)

const stats = computed(() => ({
  schoolCount:     schools.value.length,
  totalReceivable: unpaidInvoices.value.reduce((s, i) => s + i.price_per_student * i.quantity, 0),
  totalCollected:  paidInvoices.value.reduce((s, i) => s + i.price_per_student * i.quantity, 0),
  overdueAmount:   overdueInvoices.value.reduce((s, i) => s + i.price_per_student * i.quantity, 0),
  unpaidCount:     unpaidInvoices.value.length,
  paidCount:       paidInvoices.value.length,
  overdueCount:    overdueInvoices.value.length,
}))

// ── Receivables by school ─────────────────────────────────────────────────────
const receivablesBySchool = computed(() => {
  const map = {}
  unpaidInvoices.value.forEach(inv => {
    if (!map[inv.school_name]) map[inv.school_name] = { name: inv.school_name, amount: 0, hasOverdue: false }
    map[inv.school_name].amount += inv.price_per_student * inv.quantity
    const due = inv.due_date?.toDate ? inv.due_date.toDate() : new Date(inv.due_date)
    if (inv.due_date && due < new Date()) map[inv.school_name].hasOverdue = true
  })
  const list = Object.values(map).sort((a, b) => b.amount - a.amount)
  const max = list[0]?.amount || 1
  return list.map(s => ({ ...s, pct: Math.round(s.amount / max * 100) }))
})

// ── Recent activity ───────────────────────────────────────────────────────────
const recentActivity = computed(() => {
  const items = []

  invoices.value.slice(0, 5).forEach(inv => {
    const ts = inv.created_at?.toDate ? inv.created_at.toDate() : null
    items.push({
      id: 'inv-' + inv.id,
      label: `Invoice ${inv.invoice_number} · ${inv.school_name}`,
      time: ts ? timeAgo(ts) : '',
      amount: inv.status === 'paid' ? inv.price_per_student * inv.quantity : null,
      icon: inv.status === 'paid' ? 'pi pi-check' : 'pi pi-receipt',
      iconBg: inv.status === 'paid' ? 'bg-green-100' : 'bg-amber-100',
      iconColor: inv.status === 'paid' ? 'text-green-600' : 'text-amber-600',
      sortTs: ts,
    })
  })

  schools.value.slice(0, 3).forEach(s => {
    const ts = s.created_at?.toDate ? s.created_at.toDate() : null
    items.push({
      id: 'sch-' + s.id,
      label: `${s.name} added as partner`,
      time: ts ? timeAgo(ts) : '',
      amount: null,
      icon: 'pi pi-building',
      iconBg: 'bg-blue-100',
      iconColor: 'text-blue-600',
      sortTs: ts,
    })
  })

  agreements.value.slice(0, 3).forEach(a => {
    const ts = a.created_at?.toDate ? a.created_at.toDate() : null
    items.push({
      id: 'agr-' + a.id,
      label: `Agreement ${a.agreement_number} · ${a.school_name}`,
      time: ts ? timeAgo(ts) : '',
      amount: null,
      icon: 'pi pi-file-edit',
      iconBg: 'bg-purple-100',
      iconColor: 'text-purple-600',
      sortTs: ts,
    })
  })

  return items
    .filter(i => i.sortTs)
    .sort((a, b) => b.sortTs - a.sortTs)
    .slice(0, 8)
})

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadAll() {
  loading.value = true
  try {
    const [sSnap, iSnap, qSnap, aSnap] = await Promise.all([
      getDocs(query(opsCollection('schools'),    orderBy('created_at', 'desc'))),
      getDocs(query(opsCollection('invoices'),   orderBy('created_at', 'desc'))),
      getDocs(query(opsCollection('quotations'), orderBy('created_at', 'desc'))),
      getDocs(query(opsCollection('agreements'), orderBy('created_at', 'desc'))),
    ])
    schools.value    = sSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    invoices.value   = iSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    quotations.value = qSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    agreements.value = aSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatRupee(n) {
  if (!n) return '₹0'
  return '₹' + Number(n).toLocaleString('en-IN')
}

function formatDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function daysOverdue(ts) {
  if (!ts) return 0
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return Math.floor((new Date() - d) / 86400000)
}

function timeAgo(date) {
  const diff = Math.floor((new Date() - date) / 1000)
  if (diff < 60)     return 'just now'
  if (diff < 3600)   return Math.floor(diff / 60) + 'm ago'
  if (diff < 86400)  return Math.floor(diff / 3600) + 'h ago'
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago'
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

onMounted(loadAll)
</script>
