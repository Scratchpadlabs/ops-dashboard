<template>
  <div>
    <!-- Personalised AAM year-wrap videos. Storylines are built in the browser
         from AAM1/AAM2 answers; the render service (video/server) turns the
         reviewed storyline into an MP4. See video/README.md. -->
    <div v-if="!YEAR_WRAP_URL" class="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4">
      <i class="pi pi-exclamation-triangle mr-1"></i>
      The year-wrap render service isn't configured for this build. Set <code>VITE_YEAR_WRAP_URL</code>
      to the Cloud Run URL (video/README.md → Deploying) and rebuild.
    </div>

    <div class="flex items-end justify-between gap-4 mb-4 flex-wrap">
      <div class="flex items-end gap-3 flex-wrap">
        <div>
          <label class="form-label">School</label>
          <Select v-model="schoolId" :options="schools" optionLabel="name" optionValue="id"
            placeholder="Select a school" class="w-72" :loading="loadingSchools" filter />
        </div>
        <div>
          <label class="form-label">Class</label>
          <Select v-model="classId" :options="classOptions" optionLabel="label" optionValue="value"
            placeholder="Select a class" class="w-64" :loading="loadingRoster" :disabled="!classes.length" filter />
        </div>
        <div>
          <label class="form-label">Academic year</label>
          <InputText v-model="academicYear" class="w-28" @change="yearTouched = true; openClass()"
            v-tooltip.bottom="'Taken from the AAM survey dates. Shown in the intro and used in the storage path.'" />
        </div>
      </div>
      <div class="flex gap-2 flex-wrap">
        <Button label="Refresh" icon="pi pi-refresh" size="small" text :disabled="!classId" :loading="loadingClass" @click="openClass" />
        <Button label="Cancel queued" icon="pi pi-times" size="small" text severity="secondary"
          :disabled="!anyActive" @click="cancelQueued" />
        <Button v-if="doneRows.length" :label="zipLabel" icon="pi pi-download" size="small" text
          :disabled="zipping" :loading="zipping" @click="downloadZip" />
        <Button :label="selection.length ? `Render MP4 (${selection.length})` : 'Render MP4s'" icon="pi pi-video" size="small" text
          v-tooltip.bottom="'Optional: make video files. Share links need no rendering.'"
          :disabled="!renderTargets.length || !YEAR_WRAP_URL" @click="confirmRender(renderTargets)" />
        <Button label="Download links (CSV)" icon="pi pi-file-excel" size="small" outlined
          :disabled="!linkedRows.length" @click="downloadLinks" />
        <Button :label="selection.length ? `Create links for ${selection.length} selected` : 'Create links for whole class'" icon="pi pi-link" size="small"
          :disabled="!renderTargets.length || !YEAR_WRAP_URL" :loading="publishing" @click="confirmPublish(renderTargets)" />
      </div>
    </div>

    <div v-if="pendingFile" class="flex items-center gap-3 bg-emerald-50 rounded-lg px-3 py-2 mb-3">
      <i class="pi pi-check-circle text-emerald-600"></i>
      <div class="flex-1 text-xs text-slate-700">{{ pendingFile.name }} is ready</div>
      <Button label="Save" size="small" @click="savePending" />
      <Button label="Discard" size="small" text severity="secondary" @click="discardPending" />
    </div>

    <div v-if="error" class="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 mb-3">{{ error }}</div>

    <div v-if="!schoolId" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-video text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">Select a school to make its year-wrap videos</p>
      <p class="text-xs text-slate-400 mt-1">Built from each student's All About Me answers (AAM1 vs AAM2) — Preparatory and Middle.</p>
    </div>

    <div v-else-if="loadingRoster" class="flex justify-center py-20"><ProgressSpinner style="width:32px;height:32px" /></div>

    <div v-else-if="!classId" class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div class="px-4 py-2.5 border-b border-slate-100 text-sm font-bold text-slate-900">Classes with AAM surveys</div>
      <DataTable :value="classes" size="small" stripedRows selectionMode="single" @row-click="(e) => classId = e.data.classId">
        <Column header="Class" field="classId" />
        <Column header="Segment"><template #body="{ data }"><SegmentTag :segment="data.segment" /></template></Column>
        <Column header="Students" field="total" />
        <Column header="With AAM answers">
          <template #body="{ data }">{{ data.withData }} <span class="text-xs text-slate-400">({{ pct(data.withData, data.total) }}%)</span></template>
        </Column>
        <template #empty><div class="text-sm text-slate-500 py-6 text-center">No Preparatory or Middle students found.</div></template>
      </DataTable>
    </div>

    <div v-else-if="loadingClass" class="flex justify-center py-20"><ProgressSpinner style="width:32px;height:32px" /></div>

    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div class="px-4 py-2.5 border-b border-slate-100 flex items-center gap-3 flex-wrap text-xs text-slate-500">
        <span class="text-sm font-bold text-slate-900">{{ classId }}</span>
        <SegmentTag v-if="classRows[0]" :segment="classRows[0].segment" />
        <span>{{ classRows.length }} students</span>
        <span>· {{ counts.ready }} ready</span>
        <span v-if="counts.noData">· {{ counts.noData }} without AAM answers</span>
        <span>· {{ linkedRows.length }} with links</span>
        <span v-if="counts.done">· {{ counts.done }} MP4s</span>
      </div>
      <DataTable v-model:selection="selection" :value="classRows" dataKey="id" size="small" stripedRows>
        <Column selectionMode="multiple" style="width:40px" />
        <Column header="Student">
          <template #body="{ data }">
            <div class="text-sm text-slate-800">{{ data.name }}</div>
            <span v-if="data.edited" class="text-[11px] font-semibold text-violet-700">edited</span>
          </template>
        </Column>
        <Column header="AAM1" style="width:70px"><template #body="{ data }"><Tick :on="data.aam1" :draft="data.aam1 && !data.aam1Submitted" /></template></Column>
        <Column header="AAM2" style="width:70px"><template #body="{ data }"><Tick :on="data.aam2" :draft="data.aam2 && !data.aam2Submitted" /></template></Column>
        <Column header="Story" style="width:190px">
          <template #body="{ data }">
            <span v-if="!data.storyline.renderable" class="text-xs text-slate-400">no answers — nothing to show</span>
            <span v-else-if="!data.storyline.warnings.length" class="text-xs text-emerald-700 font-semibold">complete</span>
            <span v-else class="text-xs text-amber-700 font-semibold cursor-help"
              v-tooltip.top="data.storyline.warnings.join('\n')">{{ data.storyline.warnings.length }} gap{{ data.storyline.warnings.length > 1 ? 's' : '' }} filled</span>
            <div v-if="data.storyline.renderable" class="text-[11px] text-slate-400">{{ (data.storyline.durationInFrames / 30).toFixed(0) }}s · {{ data.storyline.scenes.length }} scenes</div>
          </template>
        </Column>
        <Column header="Share link" style="width:190px">
          <template #body="{ data }">
            <div v-if="videos[data.id]?.linkId" class="flex items-center gap-0.5">
              <Button icon="pi pi-copy" text rounded size="small" v-tooltip.top="'Copy link'" @click="copyLink(data)" />
              <Button icon="pi pi-whatsapp" text rounded size="small" severity="success" v-tooltip.top="'Send on WhatsApp'" @click="whatsapp(data)" />
              <Button icon="pi pi-external-link" text rounded size="small" severity="secondary" v-tooltip.top="'Open as a parent sees it'" @click="openLink(data)" />
              <Button icon="pi pi-ban" text rounded size="small" severity="danger" v-tooltip.top="'Revoke link'" @click="confirmRevoke([data])" />
            </div>
            <span v-else class="text-xs text-slate-400">No link yet</span>
          </template>
        </Column>
        <Column header="MP4" style="width:150px">
          <template #body="{ data }">
            <VideoStatus :video="videos[data.id]" />
          </template>
        </Column>
        <Column style="width:150px">
          <template #body="{ data }">
            <div class="flex gap-1 justify-end">
              <Button v-if="videos[data.id]?.videoUrl" icon="pi pi-play" text rounded size="small" v-tooltip.top="'Watch'" @click="watchVideo(data)" />
              <Button label="Review" size="small" text :disabled="!data.storyline.renderable" @click="openReview(data)" />
            </div>
          </template>
        </Column>
      </DataTable>
    </div>

    <!-- Review & edit -->
    <Dialog v-model:visible="reviewOpen" modal :header="review ? `${review.name} · ${review.classId}` : ''" :style="{ width: '1150px' }" :breakpoints="{ '1200px': '96vw' }">
      <div v-if="review && draft" class="grid gap-5" style="grid-template-columns: 340px 1fr">
        <div>
          <YearWrapPlayer :storyline="draft" />
          <p class="text-xs text-slate-400 mt-2">Live preview, exactly what a parent sees from the link. Edits show immediately.</p>
          <p v-if="videos[review.id]?.linkId" class="text-xs text-emerald-700 mt-1"><i class="pi pi-link text-xs"></i> Linked: saving updates what parents see, on the same link.</p>
        </div>
        <div class="max-h-[70vh] overflow-y-auto pr-1">
          <StorylineEditor :storyline="draft" @update:storyline="(s) => draft = s" />
        </div>
      </div>
      <template #footer>
        <Button v-if="review?.edited" label="Reset to automatic" text severity="secondary" icon="pi pi-undo" @click="resetDraft" />
        <span class="flex-1"></span>
        <Button label="Close" text @click="reviewOpen = false" />
        <Button label="Save" outlined :loading="saving" :disabled="!dirty" @click="saveDraft(null)" />
        <Button label="Save & render MP4" text :loading="saving" :disabled="!YEAR_WRAP_URL" @click="saveDraft('render')" />
        <Button :label="videos[review?.id]?.linkId ? 'Save & update link' : 'Save & create link'" icon="pi pi-link" :loading="saving" :disabled="!YEAR_WRAP_URL" @click="saveDraft('link')" />
      </template>
    </Dialog>

    <!-- Watch a rendered video -->
    <Dialog v-model:visible="watchOpen" modal :header="watching?.name" :style="{ width: '420px' }">
      <video v-if="watching" :src="videos[watching.id]?.videoUrl" controls autoplay playsinline class="w-full rounded-lg bg-black" style="aspect-ratio: 9/16"></video>
      <template #footer>
        <a v-if="watching" :href="videos[watching.id]?.videoUrl" target="_blank" rel="noopener" class="text-sm text-blue-600">Open / download</a>
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import ConfirmDialog from 'primevue/confirmdialog'
import ProgressSpinner from 'primevue/progressspinner'
import JSZip from 'jszip'

import YearWrapPlayer from '../components/year-wrap/YearWrapPlayer.vue'
import StorylineEditor from '../components/year-wrap/StorylineEditor.vue'
import { useSurveys } from '../composables/useSurveys.js'
import { useYearWrap, videoState, shareUrl, SEGMENT_LABELS } from '../composables/useYearWrap.js'
import { computeCurrentAcademicYear } from '../composables/useAcademicYear.js'
import { YEAR_WRAP_URL } from '../utils/yearWrapApi.js'
import { deliverFile, pendingFile, savePending, discardPending } from '../utils/deliverFile.js'

const toast = useToast()
const confirm = useConfirm()
const route = useRoute()
const router = useRouter()
const { schools, loadSchools } = useSurveys()
const {
  school, classes, classRows, videos, loadingRoster, loadingClass, surveyYear,
  loadRoster, loadClass, saveEdit, render, publish, unpublish, cancel, stopPolling,
} = useYearWrap()

const schoolId = ref(route.query.school || null)
const classId = ref(route.query.class || null)
const academicYear = ref(computeCurrentAcademicYear())
const yearTouched = ref(false)
const loadingSchools = ref(false)
const error = ref('')
const selection = ref([])

const classOptions = computed(() => classes.value.map((c) => ({
  value: c.classId, label: `${c.classId} · ${SEGMENT_LABELS[c.segment]} · ${c.withData}/${c.total}`,
})))

onMounted(async () => {
  loadingSchools.value = true
  try { await loadSchools() } finally { loadingSchools.value = false }
  if (schoolId.value) await openSchool()
})
onBeforeUnmount(stopPolling)

watch(schoolId, () => { classId.value = null; openSchool() })
watch(classId, () => { syncUrl(); openClass() })

function syncUrl() {
  router.replace({ query: { ...(schoolId.value ? { school: schoolId.value } : {}), ...(classId.value ? { class: classId.value } : {}) } })
}

async function guard(fn) {
  error.value = ''
  try { return await fn() } catch (e) { error.value = e.message || String(e) }
}

async function openSchool() {
  syncUrl()
  selection.value = []
  await guard(() => loadRoster(schoolId.value))
  if (surveyYear.value && !yearTouched.value) academicYear.value = surveyYear.value
  if (classId.value) await openClass()
}
async function openClass() {
  selection.value = []
  if (!classId.value) return
  await guard(() => loadClass(classId.value, academicYear.value))
}

const counts = computed(() => ({
  ready: classRows.value.filter((r) => r.storyline.renderable).length,
  noData: classRows.value.filter((r) => !r.storyline.renderable).length,
  done: classRows.value.filter((r) => videos.value[r.id]?.status === 'done').length,
}))
const anyActive = computed(() => classRows.value.some((r) => ['queued', 'rendering'].includes(videoState(videos.value[r.id]))))
const renderTargets = computed(() => (selection.value.length ? selection.value : classRows.value).filter((r) => r.storyline.renderable))
const doneRows = computed(() => classRows.value.filter((r) => videos.value[r.id]?.status === 'done' && videos.value[r.id]?.videoUrl))
const zipLabel = computed(() => (doneRows.value.length ? `Download ${doneRows.value.length} video${doneRows.value.length > 1 ? 's' : ''} (ZIP)` : 'Download ZIP'))
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0)

function confirmRender(rows) {
  const rerender = rows.filter((r) => videos.value[r.id]?.status === 'done').length
  confirm.require({
    header: 'Render videos',
    message: `Render ${rows.length} video${rows.length > 1 ? 's' : ''} for ${classId.value}?`
      + (rerender ? ` ${rerender} already rendered will be replaced.` : '')
      + ` Each takes about a minute and a half; you can leave this page while they render.`,
    acceptLabel: 'Render',
    rejectLabel: 'Cancel',
    accept: () => guard(async () => {
      const res = await render(rows, academicYear.value)
      toast.add({ severity: 'success', summary: `${res.queued} queued`, detail: res.ahead ? `${res.ahead} other video(s) ahead in the queue` : '', life: 4000 })
      selection.value = []
    }),
  })
}

async function cancelQueued() {
  await guard(async () => {
    const r = await cancel()
    toast.add({ severity: 'info', summary: `${r.cancelled} queued render(s) cancelled`, life: 3000 })
  })
}

// ── share links ─────────────────────────────────────────────────────────────
const publishing = ref(false)
const linkedRows = computed(() => classRows.value.filter((r) => videos.value[r.id]?.linkId))
const linkOf = (row) => shareUrl(videos.value[row.id]?.linkId)
const firstNameOf = (row) => row.storyline?.scenes?.[0]?.name || String(row.name || '').split(' ')[0]

function confirmPublish(rows) {
  const already = rows.filter((r) => videos.value[r.id]?.linkId).length
  confirm.require({
    header: 'Create share links',
    message: `Create links for ${rows.length} student${rows.length > 1 ? 's' : ''} in ${classId.value}?`
      + (already ? ` ${already} already have a link — theirs stay the same and show the latest version.` : '')
      + ' Anyone with a link can watch that one video, so send each link only to that child\'s family.',
    acceptLabel: 'Create links',
    rejectLabel: 'Cancel',
    accept: async () => {
      publishing.value = true
      await guard(async () => {
        const r = await publish(rows)
        toast.add({ severity: 'success', summary: `${r.published} link${r.published === 1 ? '' : 's'} ready`, detail: 'Copy, send on WhatsApp, or download them all as a CSV.', life: 4000 })
        selection.value = []
      })
      publishing.value = false
    },
  })
}

function confirmRevoke(rows) {
  confirm.require({
    header: 'Revoke link',
    message: `Stop ${rows.map((r) => r.name).join(', ')}'s link from working? Anyone who opens it will see "link expired". Creating a link again gives a new address.`,
    acceptLabel: 'Revoke',
    rejectLabel: 'Keep',
    acceptClass: 'p-button-danger',
    accept: () => guard(async () => {
      await unpublish(rows)
      toast.add({ severity: 'info', summary: 'Link revoked', life: 2500 })
    }),
  })
}

async function copyLink(row, { quiet = false } = {}) {
  const url = linkOf(row)
  try {
    await navigator.clipboard.writeText(url)
    if (!quiet) toast.add({ severity: 'success', summary: 'Link copied', detail: url, life: 2500 })
  } catch {
    window.prompt('Copy this link:', url)
  }
}

function shareMessage(row) {
  const from = school.value?.name ? ` from ${school.value.name}` : ''
  return `Here is ${firstNameOf(row)}'s year in review${from} 🎉 Tap to watch: ${linkOf(row)}`
}
const whatsapp = (row) => window.open(`https://wa.me/?text=${encodeURIComponent(shareMessage(row))}`, '_blank', 'noopener')
const openLink = (row) => window.open(linkOf(row), '_blank', 'noopener')

function downloadLinks() {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = [['Student', 'Class', 'Link', 'WhatsApp message'].map(esc).join(',')]
  for (const r of linkedRows.value) lines.push([r.name, r.classId, linkOf(r), shareMessage(r)].map(esc).join(','))
  // BOM so Excel reads the emoji and Indian names correctly.
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  deliverFile(blob, `year-wrap-links_${classId.value}_${academicYear.value}.csv`)
}

// ── review dialog ───────────────────────────────────────────────────────────
const reviewOpen = ref(false)
const review = ref(null)
const draft = ref(null)
const saving = ref(false)
const dirty = computed(() => review.value && JSON.stringify(draft.value) !== JSON.stringify(review.value.storyline))

function openReview(row) {
  review.value = row
  draft.value = JSON.parse(JSON.stringify(row.storyline))
  reviewOpen.value = true
}
function resetDraft() {
  draft.value = JSON.parse(JSON.stringify(review.value.auto))
}
// then: null (just save) | 'link' (save + create/update the share link) | 'render' (save + MP4)
async function saveDraft(then) {
  saving.value = true
  try {
    await guard(async () => {
      const isAuto = JSON.stringify(draft.value) === JSON.stringify(review.value.auto)
      if (dirty.value || (isAuto && review.value.edited)) await saveEdit(review.value.id, isAuto ? null : draft.value)
      const row = classRows.value.find((r) => r.id === review.value.id)
      // A sent link always shows the latest saved version.
      const linked = !!videos.value[row.id]?.linkId
      if (then === 'link' || linked) await publish([row])
      if (then === 'render') {
        await render([row], academicYear.value)
        toast.add({ severity: 'success', summary: 'Saved and queued', life: 3000 })
        reviewOpen.value = false
      } else if (then === 'link') {
        await copyLink(row, { quiet: true })
        toast.add({ severity: 'success', summary: linked ? 'Saved — link updated' : 'Link created', detail: 'Copied to clipboard', life: 3000 })
        reviewOpen.value = false
      } else {
        review.value = row
        toast.add({ severity: 'success', summary: linked ? 'Saved — link updated' : 'Saved', life: 2000 })
      }
    })
  } finally {
    saving.value = false
  }
}

// ── watch / download ────────────────────────────────────────────────────────
const watchOpen = ref(false)
const watching = ref(null)
function watchVideo(row) { watching.value = row; watchOpen.value = true }

const zipping = ref(false)
async function downloadZip() {
  zipping.value = true
  await guard(async () => {
    const zip = new JSZip()
    const used = new Set()
    for (const r of doneRows.value) {
      const res = await fetch(videos.value[r.id].videoUrl)
      if (!res.ok) throw new Error(`Could not download ${r.name}'s video (${res.status})`)
      let base = `${r.classId}_${String(r.name || r.id).replace(/[^\p{L}\p{N}]+/gu, '_')}`.replace(/_+$/, '')
      while (used.has(base)) base += '_'
      used.add(base)
      zip.file(`${base}.mp4`, await res.blob())
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
    deliverFile(blob, `year-wrap_${classId.value}_${academicYear.value}.zip`)
  })
  zipping.value = false
}

// ── small inline components ────────────────────────────────────────────────
const SegmentTag = (p) => h('span', {
  class: ['px-2 py-0.5 rounded-full text-[11px] font-semibold', p.segment === 'prep' ? 'bg-orange-50 text-orange-700' : 'bg-indigo-50 text-indigo-700'],
}, SEGMENT_LABELS[p.segment] || p.segment)
SegmentTag.props = ['segment']

const Tick = (p) => p.on
  ? h('i', { class: ['pi', p.draft ? 'pi-circle text-amber-500' : 'pi-check-circle text-emerald-600'], title: p.draft ? 'Started, not submitted' : 'Submitted' })
  : h('i', { class: 'pi pi-minus text-slate-300', title: 'Not answered' })
Tick.props = ['on', 'draft']

const STATUS = {
  none: ['Not rendered', 'text-slate-400'], queued: ['Queued', 'text-slate-600'], rendering: ['Rendering', 'text-blue-700'],
  done: ['Ready', 'text-emerald-700'], failed: ['Failed', 'text-red-700'], cancelled: ['Cancelled', 'text-slate-500'],
  stale: ['Stuck — render again', 'text-amber-700'],
}
const VideoStatus = (p) => {
  const s = videoState(p.video)
  const [label, cls] = STATUS[s] || [s, 'text-slate-500']
  const kids = [h('span', { class: ['text-xs font-semibold', cls] }, label)]
  if (s === 'rendering') {
    kids.push(h('div', { class: 'h-1.5 bg-slate-100 rounded-full mt-1 overflow-hidden' },
      h('div', { class: 'h-full bg-blue-500 transition-all', style: { width: `${Math.round((p.video.progress || 0) * 100)}%` } })))
  }
  if (s === 'failed' && p.video.error) kids.push(h('div', { class: 'text-[11px] text-red-600 truncate', title: p.video.error }, p.video.error))
  return h('div', kids)
}
VideoStatus.props = ['video']
</script>
