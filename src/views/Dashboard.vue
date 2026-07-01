<template>
  <div class="min-h-screen" style="background: var(--surface-ground)">

    <!-- ── STAT CARDS ──────────────────────────────────────────────────── -->
    <div class="grid grid-cols-4 gap-4 mb-6">
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
          <InputText v-model="linkForm.emoji" class="w-full" placeholder="📊" maxlength="2" />
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
import { ref, computed, onMounted, defineComponent, h } from 'vue'
import { opsCollection, opsDoc } from '../firebase/collections.js'
import { getDocs, addDoc, deleteDoc, orderBy, query, serverTimestamp } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

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

const confirm  = useConfirm()
const toast    = useToast()

const loading      = ref(true)
const linksLoading = ref(true)
const links        = ref([])

// Data
const schools   = ref([])
const invoices  = ref([])
const agreements = ref([])

// ── Stats ──────────────────────────────────────────────────────────────────
const paidInvoices   = computed(() => invoices.value.filter(i => i.status === 'paid'))
const unpaidInvoices = computed(() => invoices.value.filter(i => i.status !== 'paid'))
const signedAgreements = computed(() => agreements.value.filter(a => a.status === 'Signed'))

const totalCollected  = computed(() => paidInvoices.value.reduce((s, i) => s + (i.price_per_student || 0) * (i.quantity || 0), 0))
const totalOutstanding = computed(() => unpaidInvoices.value.reduce((s, i) => s + (i.price_per_student || 0) * (i.quantity || 0), 0))

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

// ── Load ────────────────────────────────────────────────────────────────────
async function loadAll() {
  loading.value = true
  try {
    const [sSnap, iSnap, aSnap] = await Promise.all([
      getDocs(query(opsCollection('schools'),    orderBy('created_at', 'desc'))),
      getDocs(query(opsCollection('invoices'),   orderBy('created_at', 'desc'))),
      getDocs(query(opsCollection('agreements'), orderBy('created_at', 'desc'))),
    ])
    schools.value    = sSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    invoices.value   = iSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    agreements.value = aSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

async function loadLinks() {
  linksLoading.value = true
  try {
    const snap = await getDocs(query(opsCollection('links'), orderBy('created_at', 'asc')))
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function timeAgo(date) {
  const diff = Math.floor((new Date() - date) / 1000)
  if (diff < 60)     return 'just now'
  if (diff < 3600)   return Math.floor(diff / 60) + 'm ago'
  if (diff < 86400)  return Math.floor(diff / 3600) + 'h ago'
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago'
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

onMounted(() => Promise.all([loadAll(), loadLinks()]))
</script>

<style scoped>
.form-label {
  display: block; font-size: 12px; font-weight: 500;
  color: #64748b; margin-bottom: 4px;
  text-transform: uppercase; letter-spacing: 0.04em;
}
</style>
