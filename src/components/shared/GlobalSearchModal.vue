<template>
  <Teleport to="body">
    <div v-if="isSearchOpen" class="gs-overlay" @click="close">
      <div class="gs-card" @click.stop @keydown.esc="close">
        <div class="gs-input-row">
          <i class="pi pi-search gs-search-icon"></i>
          <input
            ref="inputEl"
            v-model="query"
            @keydown="onKeydown"
            type="text"
            placeholder="Search anything..."
            class="gs-input"
            autocomplete="off"
          />
          <span class="gs-esc-hint">ESC</span>
        </div>

        <div class="gs-body">

          <!-- Empty state: recent searches + smart suggestions -->
          <div v-if="!query.trim()">
            <div v-if="recentSearches.length" class="gs-section">
              <div class="gs-section-title">Recent Searches</div>
              <button
                v-for="(r, i) in recentSearches"
                :key="'recent-' + i"
                class="gs-suggestion-row"
                @click="selectSuggestion(r)"
              >
                <i class="pi pi-history gs-suggestion-icon"></i>
                <span>{{ r }}</span>
              </button>
            </div>
            <div class="gs-section">
              <div class="gs-section-title">Try Searching</div>
              <button
                v-for="s in SUGGESTIONS"
                :key="s.label"
                class="gs-suggestion-row"
                @click="selectSuggestion(s.label)"
              >
                <i :class="s.icon" class="gs-suggestion-icon"></i>
                <span>{{ s.label }}</span>
              </button>
            </div>
          </div>

          <!-- Cache still loading on very first search -->
          <div v-else-if="cacheLoading && groups.length === 0" class="gs-loading">
            <ProgressSpinner style="width:24px;height:24px" />
          </div>

          <!-- Results -->
          <div v-else-if="flatResults.length">
            <div v-for="group in groups" :key="group.type" class="gs-section">
              <div class="gs-section-title">{{ group.count }} result{{ group.count !== 1 ? 's' : '' }} in {{ group.label }}</div>
              <div
                v-for="item in group.items"
                :key="group.type + ':' + item.id"
                class="gs-result-row"
                :class="{ 'gs-result-row--active': isSelected(item) }"
                @click="openResult(item)"
                @mousemove="hoverSelect(item)"
              >
                <span class="gs-type-emoji">{{ group.icon }}</span>
                <div class="gs-result-text">
                  <div class="gs-result-primary" v-html="highlightMatches(item.primary, debouncedQuery)"></div>
                  <div class="gs-result-secondary">{{ item.secondary }}</div>
                </div>
                <span v-if="item.badge" class="gs-badge" :class="item.badge.cls">{{ item.badge.text }}</span>
                <button
                  :ref="el => setActionRef(item, el)"
                  class="gs-action-btn"
                  @click.stop="runQuickAction(item)"
                >
                  <i :class="quickAction(item).icon"></i> {{ quickAction(item).label }}
                </button>
              </div>
            </div>
          </div>

          <!-- No results -->
          <div v-else class="gs-no-results">
            <img src="https://media.giphy.com/media/l2JehQ2GitHGdVG9a/giphy.gif" class="gs-no-results-gif" alt="" />
            <p>No results. That's what she said.</p>
          </div>

        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from 'primevue/usetoast'
import ProgressSpinner from 'primevue/progressspinner'
import { updateDoc, serverTimestamp } from 'firebase/firestore'
import { auth } from '../../firebase/config'
import { opsDoc } from '../../firebase/collections.js'
import { useCelebration } from '../../composables/useCelebration'
import { useGlobalSearch, SUGGESTIONS } from '../../composables/useGlobalSearch.js'
import { generateQuotationPDF, generateAgreementFiles, generateInvoicePDF } from '../../utils/api.js'

const router = useRouter()
const toast = useToast()
const { celebrate } = useCelebration()
const { isSearchOpen, ensureCache, search, highlightMatches, cacheLoading, cacheVersion } = useGlobalSearch()

const inputEl = ref(null)
const query = ref('')
const debouncedQuery = ref('')
const selectedIndex = ref(0)
const recentSearches = ref([])

const RECENT_KEY = 'ops_recent_searches'
function loadRecentSearches() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
  } catch {
    return []
  }
}
function pushRecentSearch(term) {
  const t = term.trim()
  if (!t) return
  let list = loadRecentSearches().filter(x => x.toLowerCase() !== t.toLowerCase())
  list.unshift(t)
  list = list.slice(0, 5)
  localStorage.setItem(RECENT_KEY, JSON.stringify(list))
}

let debounceTimer = null
watch(query, (val) => {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => { debouncedQuery.value = val }, 200)
})

const searchResult = computed(() => {
  cacheVersion.value // eslint-disable-line no-unused-expressions -- tracked so results refresh once the cache finishes loading
  return search(debouncedQuery.value)
})
const groups = computed(() => searchResult.value.groups)
const flatResults = computed(() => groups.value.flatMap(g => g.items))

watch(flatResults, () => {
  selectedIndex.value = flatResults.value.length ? 0 : -1
})

function isSelected(item) {
  return flatResults.value[selectedIndex.value] === item
}
function hoverSelect(item) {
  const idx = flatResults.value.indexOf(item)
  if (idx !== -1 && idx !== selectedIndex.value) selectedIndex.value = idx
}

const actionRefs = new Map()
function itemKey(item) { return item.type + ':' + item.id }
function setActionRef(item, el) {
  if (el) actionRefs.set(itemKey(item), el)
  else actionRefs.delete(itemKey(item))
}

function onKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (flatResults.value.length) selectedIndex.value = Math.min(selectedIndex.value + 1, flatResults.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (flatResults.value.length) selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const item = flatResults.value[selectedIndex.value]
    if (item) openResult(item)
  } else if (e.key === 'Tab' && !e.shiftKey) {
    const item = flatResults.value[selectedIndex.value]
    const btn = item && actionRefs.get(itemKey(item))
    if (btn) {
      e.preventDefault()
      btn.focus()
    }
  } else if (e.key === 'Escape') {
    close()
  }
}

function selectSuggestion(text) {
  query.value = text
  debouncedQuery.value = text
}

function close() {
  isSearchOpen.value = false
  query.value = ''
  debouncedQuery.value = ''
}

function openResult(item) {
  pushRecentSearch(debouncedQuery.value)
  close()
  if (item.type === 'school') {
    router.push({ name: 'school-profile', params: { id: item.id } })
  } else {
    const paths = { quotation: '/quotations', agreement: '/agreements', invoice: '/invoices', expense: '/expenses' }
    router.push({ path: paths[item.type], query: { highlight: item.id } })
  }
}

function quickAction(item) {
  if (item.type === 'invoice') {
    return item.raw.status !== 'paid' ? { icon: 'pi pi-check', label: 'Mark Paid' } : { icon: 'pi pi-download', label: 'Download' }
  }
  if (item.type === 'quotation' || item.type === 'agreement') return { icon: 'pi pi-download', label: 'Download' }
  return { icon: 'pi pi-arrow-right', label: 'View' }
}

async function markInvoicePaidFromSearch(inv) {
  await updateDoc(opsDoc('invoices', inv.id), {
    status: 'paid',
    paid_on: serverTimestamp(),
    updated_at: serverTimestamp(),
    updated_by: auth.currentUser?.email || 'unknown',
  })
  const amount = (inv.price_per_student || 0) * (inv.quantity || 0)
  celebrate(`₹${amount.toLocaleString('en-IN')} received from ${inv.school_name}!`, '💰', 'invoice')
  await ensureCache(true)
}

async function runQuickAction(item) {
  try {
    if (item.type === 'quotation') {
      await generateQuotationPDF(item.raw)
    } else if (item.type === 'agreement') {
      await generateAgreementFiles(item.raw)
    } else if (item.type === 'invoice') {
      if (item.raw.status !== 'paid') {
        await markInvoicePaidFromSearch(item.raw)
      } else {
        await generateInvoicePDF(item.raw)
      }
    } else {
      openResult(item)
      return
    }
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Action failed', detail: e.message || 'Something went wrong', life: 4000 })
  }
}

watch(isSearchOpen, async (val) => {
  if (val) {
    recentSearches.value = loadRecentSearches()
    query.value = ''
    debouncedQuery.value = ''
    ensureCache()
    await nextTick()
    inputEl.value?.focus()
  }
})
</script>

<style scoped>
.gs-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  background: rgba(15, 23, 42, 0.55);
  backdrop-filter: blur(2px);
}

.gs-card {
  width: 600px;
  max-width: calc(100vw - 32px);
  max-height: 70vh;
  background: white;
  border-radius: 16px;
  box-shadow: 0 25px 60px rgba(0, 0, 0, 0.35);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  animation: gs-pop 0.15s ease-out;
}

@keyframes gs-pop {
  from { transform: translateY(-8px); opacity: 0; }
  to   { transform: translateY(0);     opacity: 1; }
}

.gs-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}

.gs-search-icon {
  color: #94a3b8;
  font-size: 16px;
}

.gs-input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 16px;
  color: #0f172a;
}
.gs-input::placeholder { color: #94a3b8; }

.gs-esc-hint {
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 2px 6px;
}

.gs-body {
  overflow-y: auto;
  padding: 8px;
}

.gs-loading {
  display: flex;
  justify-content: center;
  padding: 32px 0;
}

.gs-section { padding: 6px 0; }

.gs-section-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
  padding: 8px 10px 4px;
}

.gs-suggestion-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 9px 10px;
  border-radius: 10px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  color: #334155;
  transition: background 0.1s;
}
.gs-suggestion-row:hover { background: #f1f5f9; }

.gs-suggestion-icon { color: #94a3b8; width: 16px; text-align: center; }

.gs-result-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  cursor: pointer;
}
.gs-result-row--active { background: #eff6ff; }

.gs-type-emoji { font-size: 18px; flex-shrink: 0; }

.gs-result-text { flex: 1; min-width: 0; }

.gs-result-primary {
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gs-result-primary :deep(b) { color: #2563eb; font-weight: 700; }

.gs-result-secondary {
  font-size: 12px;
  color: #64748b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gs-badge {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
}

.gs-action-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  color: #334155;
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 5px 10px;
  cursor: pointer;
  transition: all 0.1s;
}
.gs-action-btn:hover, .gs-action-btn:focus {
  border-color: #93c5fd;
  color: #2563eb;
  outline: none;
}

.gs-no-results {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px 16px;
  text-align: center;
}
.gs-no-results-gif {
  width: 220px;
  border-radius: 12px;
  margin-bottom: 14px;
}
.gs-no-results p {
  font-size: 14px;
  font-weight: 500;
  color: #64748b;
}
</style>
