<template>
  <div>

    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">Expenses</h2>
        <p class="text-sm text-slate-500 mt-0.5">{{ visibleExpenses.length }} logged · P&amp;L at a glance</p>
      </div>
      <div class="flex items-center gap-2">
        <Button label="Export" icon="pi pi-download" severity="secondary" outlined @click="exportToExcel" />
        <Button label="New Expense" icon="pi pi-plus" @click="openNewExpense" />
      </div>
    </div>

    <!-- Disclaimer -->
    <div class="disclaimer-banner mb-5">
      <i class="pi pi-exclamation-triangle"></i>
      Expense figures are indicative estimates and may not reflect actual audited financials
    </div>

    <!-- Smart prompts -->
    <div v-if="smartPrompts.length" class="grid gap-2.5 mb-6" :class="smartPrompts.length > 1 ? 'md:grid-cols-2' : ''">
      <div v-for="p in smartPrompts" :key="p.id" class="prompt-card" :class="p.tone">
        <span class="text-lg">{{ p.emoji }}</span>
        <span class="text-sm font-medium">{{ p.message }}</span>
      </div>
    </div>

    <!-- P&L cards -->
    <div class="grid grid-cols-3 gap-4 mb-6">
      <div class="pl-card pl-income">
        <div class="flex items-center justify-between mb-2">
          <span class="pl-label">Total Income</span>
          <span class="text-xl">💰</span>
        </div>
        <div class="pl-value">{{ formatRupee(displayIncome) }}</div>
        <div class="pl-sub">{{ paidInvoices.length }} paid invoice{{ paidInvoices.length !== 1 ? 's' : '' }}</div>
      </div>

      <div class="pl-card pl-expense">
        <div class="flex items-center justify-between mb-2">
          <span class="pl-label">Total Expenses</span>
          <span class="text-xl">💸</span>
        </div>
        <div class="pl-value">{{ formatRupee(displayExpenses) }}</div>
        <div class="pl-sub">{{ visibleExpenses.length }} expense{{ visibleExpenses.length !== 1 ? 's' : '' }} logged</div>
      </div>

      <div class="pl-card" :class="netPL >= 0 ? 'pl-net-positive' : 'pl-net-negative'">
        <div class="flex items-center justify-between mb-2">
          <span class="pl-label">Net P&amp;L</span>
          <span class="text-xl">{{ netPL >= 0 ? '📈' : '📉' }}</span>
        </div>
        <div class="pl-value">{{ formatRupee(Math.abs(displayNet)) }}<span v-if="netPL < 0" class="text-sm font-semibold opacity-80"> deficit</span></div>
        <div class="pl-sub">{{ netPL >= 0 ? "You're in the green" : 'Spending more than earning' }}</div>
      </div>
    </div>

    <!-- School Profitability -->
    <div v-if="schoolProfitability.length" class="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-6">
      <div class="px-5 py-3.5 border-b border-slate-100">
        <h3 class="text-sm font-semibold text-slate-900">School Profitability</h3>
        <p class="text-xs text-slate-400 mt-0.5">Schools with both invoiced revenue and linked expenses.</p>
      </div>
      <DataTable :value="schoolProfitability" size="small" stripedRows>
        <Column header="School Name">
          <template #body="{ data }">
            <span class="text-sm font-medium text-slate-800">{{ data.school_name }}</span>
          </template>
        </Column>
        <Column header="Revenue">
          <template #body="{ data }">
            <span class="text-sm font-semibold text-emerald-600">{{ formatRupee(data.revenue) }}</span>
          </template>
        </Column>
        <Column header="Costs">
          <template #body="{ data }">
            <span class="text-sm font-semibold text-rose-600">{{ formatRupee(data.cost) }}</span>
          </template>
        </Column>
        <Column header="Profit">
          <template #body="{ data }">
            <span class="text-sm font-bold" :class="data.profit >= 0 ? 'text-slate-900' : 'text-red-600'">{{ formatRupee(data.profit) }}</span>
          </template>
        </Column>
        <Column header="Margin">
          <template #body="{ data }">
            <span class="px-2 py-0.5 rounded-full text-xs font-bold" :class="marginClass(data.margin)">{{ data.margin.toFixed(1) }}%</span>
          </template>
        </Column>
      </DataTable>
    </div>

    <!-- Monthly bar chart -->
    <div class="bg-white rounded-2xl border border-slate-200 p-5 mb-6">
      <div class="flex items-center justify-between mb-5">
        <h3 class="text-sm font-semibold text-slate-900">Income vs Expenses — Last 6 Months</h3>
        <div class="flex items-center gap-4 text-xs text-slate-500">
          <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full" style="background:#10b981"></span> Income</span>
          <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full" style="background:#f43f5e"></span> Expenses</span>
        </div>
      </div>
      <div class="flex items-end justify-between gap-2" style="height: 180px">
        <div v-for="m in monthlyChartData" :key="m.label" class="flex-1 flex flex-col items-center justify-end h-full">
          <div class="flex items-end gap-1.5 h-full">
            <div
              class="chart-bar w-4 rounded-t-md"
              style="background: linear-gradient(180deg, #34d399, #10b981)"
              :style="{ height: barHeight(m.income) + '%' }"
              v-tooltip.top="'Income: ' + formatRupee(m.income)"
            ></div>
            <div
              class="chart-bar w-4 rounded-t-md"
              style="background: linear-gradient(180deg, #fb7185, #f43f5e)"
              :style="{ height: barHeight(m.expense) + '%' }"
              v-tooltip.top="'Expenses: ' + formatRupee(m.expense)"
            ></div>
          </div>
          <div class="text-[11px] font-semibold text-slate-400 mt-2">{{ m.label }}</div>
        </div>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <ProgressSpinner style="width:32px;height:32px" />
    </div>

    <!-- Empty -->
    <div v-else-if="expenses.length === 0" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-wallet text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">No expenses logged yet</p>
      <p class="text-xs text-slate-400 mt-1">Click "New Expense" to log your first one.</p>
    </div>

    <template v-else>

      <!-- Filter bar -->
      <div class="filter-bar mb-5">
        <div class="filter-field">
          <label class="form-label">Category</label>
          <MultiSelect
            v-model="filterCategories"
            :options="allCategories"
            optionLabel="name"
            optionValue="name"
            display="chip"
            placeholder="All categories"
            class="w-full"
          >
            <template #option="{ option }">
              <span>{{ option.emoji }} {{ option.name }}</span>
            </template>
          </MultiSelect>
        </div>
        <div class="filter-field">
          <label class="form-label">Month</label>
          <DatePicker v-model="filterMonth" view="month" dateFormat="M yy" placeholder="Any month" showIcon class="w-full" />
        </div>
        <div class="filter-field">
          <label class="form-label">From</label>
          <DatePicker v-model="filterFrom" dateFormat="d M yy" placeholder="From date" showIcon class="w-full" />
        </div>
        <div class="filter-field">
          <label class="form-label">To</label>
          <DatePicker v-model="filterTo" dateFormat="d M yy" placeholder="To date" showIcon class="w-full" />
        </div>
        <Button label="Clear Filters" icon="pi pi-filter-slash" text @click="clearFilters" />
      </div>

      <!-- Category-wise summary table -->
      <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-6">
        <div class="px-5 py-3.5 border-b border-slate-100">
          <h3 class="text-sm font-semibold text-slate-900">Category-wise Summary</h3>
          <p class="text-xs text-slate-400 mt-0.5">Click a category to filter the list below.</p>
        </div>
        <DataTable
          :value="categorySummaryTable"
          size="small"
          stripedRows
          class="category-summary-table"
          @row-click="e => onCategoryRowClick(e.data)"
        >
          <Column header="Category">
            <template #body="{ data }">
              <span class="text-sm font-medium text-slate-800">{{ data.emoji }} {{ data.name }}</span>
            </template>
          </Column>
          <Column header="This Month">
            <template #body="{ data }">
              <span
                class="text-sm font-semibold"
                :class="data.thisMonth > data.lastMonth ? 'text-red-600' : data.thisMonth < data.lastMonth ? 'text-green-600' : 'text-slate-600'"
              >{{ formatRupee(data.thisMonth) }}</span>
            </template>
          </Column>
          <Column header="Last Month">
            <template #body="{ data }">
              <span class="text-sm text-slate-500">{{ formatRupee(data.lastMonth) }}</span>
            </template>
          </Column>
          <Column header="Total">
            <template #body="{ data }">
              <span class="text-sm font-bold text-slate-900">{{ formatRupee(data.total) }}</span>
            </template>
          </Column>
          <Column header="% of Expenses">
            <template #body="{ data }">
              <span class="text-sm text-slate-500">{{ data.pct.toFixed(1) }}%</span>
            </template>
          </Column>
        </DataTable>
      </div>

      <!-- School-wise summary table -->
      <div v-if="schoolWiseExpenses.length" class="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-6">
        <div class="px-5 py-3.5 border-b border-slate-100">
          <h3 class="text-sm font-semibold text-slate-900">School-wise Expenses</h3>
          <p class="text-xs text-slate-400 mt-0.5">Click a school to filter the list below.</p>
        </div>
        <DataTable
          :value="schoolWiseExpenses"
          size="small"
          stripedRows
          class="category-summary-table"
          @row-click="e => onSchoolRowClick(e.data)"
        >
          <Column header="School Name">
            <template #body="{ data }">
              <span class="text-sm font-medium text-slate-800">{{ data.school_name }}</span>
            </template>
          </Column>
          <Column header="Total Expenses">
            <template #body="{ data }">
              <span class="text-sm font-bold text-rose-600">{{ formatRupee(data.total) }}</span>
            </template>
          </Column>
          <Column header="% of Total Expenses">
            <template #body="{ data }">
              <span class="text-sm text-slate-500">{{ data.pct.toFixed(1) }}%</span>
            </template>
          </Column>
        </DataTable>
      </div>

      <!-- Expense list -->
      <div v-if="filterSchoolId" class="flex items-center gap-2 mb-3 text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-3 py-2 w-fit">
        Filtering by <strong>{{ activeSchoolFilterName }}</strong>
        <button type="button" class="pi pi-times text-[10px] ml-1" @click="filterSchoolId = null"></button>
      </div>
      <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div v-if="filteredExpensesList.length === 0" class="text-center py-16">
          <p class="text-sm text-slate-400">No expenses match the current filters.</p>
        </div>
        <DataTable v-else :value="filteredExpensesList" size="small" stripedRows :rowClass="rowClass">
          <Column header="Date" style="width:110px">
            <template #body="{ data }">
              <span class="text-xs text-slate-500">{{ formatDate(data.date) }}</span>
            </template>
          </Column>
          <Column header="Category">
            <template #body="{ data }">
              <span class="text-sm text-slate-700">{{ data.category_emoji }} {{ data.category }}</span>
            </template>
          </Column>
          <Column header="Name">
            <template #body="{ data }">
              <span class="text-sm font-medium text-slate-900">{{ data.name }}</span>
            </template>
          </Column>
          <Column header="Amount">
            <template #body="{ data }">
              <span class="text-sm font-bold text-rose-600">{{ formatRupee(data.amount) }}</span>
            </template>
          </Column>
          <Column header="Payee">
            <template #body="{ data }">
              <span class="text-sm text-slate-700">{{ data.payee || '—' }}</span>
            </template>
          </Column>
          <Column header="Payment Mode" style="width:130px">
            <template #body="{ data }">
              <span v-if="data.payment_mode" class="payment-badge" :class="paymentModeClass(data.payment_mode)">{{ data.payment_mode }}</span>
              <span v-else class="text-xs text-slate-300">—</span>
            </template>
          </Column>
          <Column header="School">
            <template #body="{ data }">
              <span class="text-sm text-slate-600">{{ data.school_name || '—' }}</span>
            </template>
          </Column>
          <Column header="Receipt" style="width:100px">
            <template #body="{ data }">
              <a v-if="data.receipt_url" :href="data.receipt_url" target="_blank" class="text-xs text-violet-600 font-semibold">📎 View</a>
              <Button
                v-else
                label="Upload"
                icon="pi pi-upload"
                text
                size="small"
                :loading="uploadingRowReceiptId === data.id"
                @click="triggerRowReceiptUpload(data)"
              />
            </template>
          </Column>
          <Column header="Recurring" style="width:130px">
            <template #body="{ data }">
              <span v-if="data.recurring" class="recurring-badge pulse-badge">
                <span class="pulse-dot"></span> {{ data.frequency }}
              </span>
              <span v-else class="text-xs text-slate-300">—</span>
            </template>
          </Column>
          <Column header="Notes">
            <template #body="{ data }">
              <span class="text-xs text-slate-400">{{ data.notes || '—' }}</span>
            </template>
          </Column>
          <Column header="" style="width:90px">
            <template #body="{ data }">
              <div class="flex gap-1">
                <Button icon="pi pi-pencil" text rounded size="small" v-tooltip="'Edit'" @click="openEditExpense(data)" />
                <Button icon="pi pi-trash" text rounded size="small" severity="danger" v-tooltip="'Delete'" @click="confirmDelete(data)" />
              </div>
            </template>
          </Column>
        </DataTable>
      </div>

    </template>

    <!-- New/Edit Expense Dialog -->
    <Dialog v-model:visible="dialogVisible" :header="editingId ? 'Edit Expense' : 'New Expense'" modal :style="{ width: '520px' }">
      <div class="space-y-4 pt-2">

        <div>
          <label class="form-label">Expense Name *</label>
          <AutoComplete v-model="form.name" :suggestions="nameSuggestions" @complete="searchNames" class="w-full" inputClass="w-full" placeholder="e.g. AWS Hosting" />
          <p class="text-xs text-slate-400 mt-1">Start typing — past expense names will suggest themselves.</p>
        </div>

        <div>
          <label class="form-label">Category *</label>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="c in allCategories"
              :key="c.name"
              type="button"
              @click="form.category = c.name; form.category_emoji = c.emoji"
              class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-all"
              :class="form.category === c.name
                ? 'bg-violet-600 text-white border-violet-600 scale-[1.02]'
                : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
            >
              <span class="text-base">{{ c.emoji }}</span> {{ c.name }}
            </button>
          </div>
          <button type="button" class="text-xs text-violet-600 font-semibold mt-2" @click="addCategoryOpen = !addCategoryOpen">
            {{ addCategoryOpen ? 'Cancel' : '+ Add custom category' }}
          </button>
          <div v-if="addCategoryOpen" class="mt-2 p-3 bg-slate-50 rounded-lg space-y-2">
            <InputText v-model="newCategoryName" placeholder="Category name" class="w-full" />
            <div class="grid grid-cols-10 gap-1">
              <button
                v-for="em in categoryEmojiOptions"
                :key="em"
                type="button"
                @click="newCategoryEmoji = em"
                class="w-7 h-7 flex items-center justify-center rounded-md text-base hover:bg-slate-100 transition-colors"
                :class="newCategoryEmoji === em ? 'bg-violet-100 ring-1 ring-violet-300' : ''"
              >{{ em }}</button>
            </div>
            <Button label="Add Category" size="small" :disabled="!newCategoryName.trim()" @click="addCustomCategory" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Amount (₹) *</label>
            <InputNumber v-model="form.amount" class="w-full" :min="1" />
          </div>
          <div>
            <label class="form-label">Date *</label>
            <DatePicker v-model="form.date" class="w-full" dateFormat="d M yy" showIcon />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Payee / Vendor</label>
            <InputText v-model="form.payee" class="w-full" placeholder="e.g. Figma Inc" />
          </div>
          <div>
            <label class="form-label">Payment Mode</label>
            <Select v-model="form.payment_mode" :options="paymentModes" placeholder="Select mode" class="w-full" showClear />
          </div>
        </div>

        <div>
          <label class="form-label">School (optional)</label>
          <Select
            v-model="form.school_id"
            :options="allSchools"
            optionLabel="name"
            optionValue="id"
            filter
            showClear
            placeholder="Link to a school, if applicable"
            class="w-full"
          >
            <template #option="{ option }">
              <div>
                <div class="text-sm font-medium text-slate-800">{{ option.name }}</div>
                <div class="text-xs text-slate-400">{{ option.city || '—' }}</div>
              </div>
            </template>
          </Select>
        </div>

        <div>
          <label class="form-label">Receipt</label>
          <div v-if="pendingReceiptFile" class="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2">
            <span class="text-sm text-slate-700 truncate"><i class="pi pi-file mr-1.5"></i>{{ pendingReceiptFile.name }}</span>
            <Button icon="pi pi-times" text rounded size="small" severity="danger" v-tooltip="'Remove'" @click="removeReceipt" />
          </div>
          <div v-else-if="form.receipt_url" class="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2">
            <a :href="form.receipt_url" target="_blank" class="text-sm text-violet-600 font-medium truncate"><i class="pi pi-paperclip mr-1.5"></i>View receipt</a>
            <Button icon="pi pi-times" text rounded size="small" severity="danger" v-tooltip="'Remove'" @click="removeReceipt" />
          </div>
          <Button
            v-else
            label="Upload Receipt"
            icon="pi pi-upload"
            outlined
            size="small"
            :loading="uploadingReceipt"
            @click="triggerReceiptUpload"
          />
          <input ref="receiptFileInputEl" type="file" accept="image/*,application/pdf" class="hidden" @change="onReceiptFileSelected" />
        </div>

        <div>
          <label class="form-label">Notes</label>
          <Textarea v-model="form.notes" class="w-full" rows="2" placeholder="Optional context..." />
        </div>

        <div class="flex items-center justify-between bg-slate-50 rounded-lg px-4 py-3">
          <div>
            <div class="text-sm font-medium text-slate-700">Recurring Expense</div>
            <div class="text-xs text-slate-400">Repeats regularly — shown with a glow in the list</div>
          </div>
          <ToggleSwitch v-model="form.recurring" />
        </div>

        <div v-if="form.recurring">
          <label class="form-label">Frequency</label>
          <div class="grid grid-cols-3 gap-2">
            <button
              v-for="f in frequencies"
              :key="f"
              type="button"
              @click="form.frequency = f"
              class="py-2 px-3 rounded-lg text-sm font-medium border capitalize transition-all"
              :class="form.frequency === f
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
            >{{ f }}</button>
          </div>
        </div>

        <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
      </div>

      <template #footer>
        <Button label="Cancel" text @click="dialogVisible = false" />
        <Button :label="editingId ? 'Save Changes' : 'Save Expense'" :loading="saving" @click="saveExpense" />
      </template>
    </Dialog>

    <input ref="rowReceiptInputEl" type="file" accept="image/*,application/pdf" class="hidden" @change="onRowReceiptFileSelected" />

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { auth, storage } from '../firebase/config'
import { activeYear, effectiveAcademicYear } from '../composables/useAcademicYear.js'
import { useAllSchools } from '../composables/useAllSchools.js'
import { opsCollection, opsDoc } from '../firebase/collections.js'
import {
  getDocs, addDoc, updateDoc, deleteDoc,
  orderBy, query, serverTimestamp, Timestamp, limit,
} from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import * as XLSX from 'xlsx'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import AutoComplete from 'primevue/autocomplete'
import DatePicker from 'primevue/datepicker'
import Textarea from 'primevue/textarea'
import ToggleSwitch from 'primevue/toggleswitch'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import MultiSelect from 'primevue/multiselect'
import Select from 'primevue/select'

const route = useRoute()
const confirm = useConfirm()
const toast = useToast()

// Row highlight from a global search result (?highlight=id)
const highlightedId = ref(route.query.highlight || null)
function rowClass(data) {
  return data.id === highlightedId.value ? 'gs-highlight-row' : ''
}
watch(() => route.query.highlight, (id) => {
  if (!id) return
  highlightedId.value = id
  setTimeout(() => { highlightedId.value = null }, 4000)
})

// ── Constants ─────────────────────────────────────────────────────────────────

const PRESET_CATEGORIES = [
  { name: 'Salaries',                  emoji: '💰' },
  { name: 'Software & Subscriptions',  emoji: '💻' },
  { name: 'Travel',                    emoji: '✈️' },
  { name: 'Printing',                  emoji: '🖨️' },
  { name: 'Marketing',                 emoji: '📣' },
  { name: 'Office Rent',               emoji: '🏢' },
  { name: 'Utilities',                 emoji: '💡' },
  { name: 'Training',                  emoji: '🎓' },
  { name: 'Operations',                emoji: '⚙️' },
  { name: 'Miscellaneous',             emoji: '🗂️' },
]

const categoryEmojiOptions = [
  '💰', '💻', '✈️', '🖨️', '📣', '🏢', '💡', '🎓', '⚙️', '🗂️',
  '📚', '🛠️', '🚗', '🍽️', '📦', '🏥', '🎉', '📱', '🔧', '🛒',
]

const frequencies = ['monthly', 'quarterly', 'yearly']
const paymentModes = ['Cash', 'UPI', 'Bank Transfer', 'Cheque']

// ── State ─────────────────────────────────────────────────────────────────────

const expenses = ref([])
const invoices = ref([])
const customCategories = ref([])
const loading = ref(true)
const { allSchools, loadAllSchools } = useAllSchools()

const dialogVisible = ref(false)
const saving = ref(false)
const formError = ref('')
const editingId = ref(null)

const addCategoryOpen = ref(false)
const newCategoryName = ref('')
const newCategoryEmoji = ref('')
const nameSuggestions = ref([])

// Receipt upload
const receiptFileInputEl = ref(null)
const pendingReceiptFile = ref(null)
const originalReceiptPath = ref('')
const uploadingReceipt = ref(false)

// Row-level receipt upload
const rowReceiptInputEl = ref(null)
const rowUploadTargetId = ref(null)
const uploadingRowReceiptId = ref(null)

// Filters
const filterCategories = ref([])
const filterMonth = ref(null)
const filterFrom = ref(null)
const filterTo = ref(null)
const filterSchoolId = ref(null)

const emptyForm = () => ({
  name: '',
  category: '',
  category_emoji: '',
  amount: null,
  date: new Date(),
  notes: '',
  recurring: false,
  frequency: 'monthly',
  payee: '',
  payment_mode: null,
  school_id: null,
  receipt_url: '',
  receipt_path: '',
})

const form = reactive(emptyForm())

// ── Computed ──────────────────────────────────────────────────────────────────

const allCategories = computed(() => {
  const extra = customCategories.value.filter(
    c => !PRESET_CATEGORIES.some(p => p.name.toLowerCase() === c.name.toLowerCase())
  )
  return [...PRESET_CATEGORIES, ...extra]
})

const visibleExpenses = computed(() => {
  if (!activeYear.value || activeYear.value === 'All Years') return expenses.value
  return expenses.value.filter(e => e.academic_year === activeYear.value)
})

const visibleInvoicesForPL = computed(() => {
  if (!activeYear.value || activeYear.value === 'All Years') return invoices.value
  return invoices.value.filter(i => i.academic_year === activeYear.value)
})

const sortedExpenses = computed(() =>
  [...visibleExpenses.value].sort((a, b) => toDate(b.date) - toDate(a.date))
)

const paidInvoices = computed(() => visibleInvoicesForPL.value.filter(i => i.status === 'paid'))

const totalIncome = computed(() =>
  paidInvoices.value.reduce((s, i) => s + (i.price_per_student || 0) * (i.quantity || 0), 0)
)
const totalExpenses = computed(() =>
  visibleExpenses.value.reduce((s, e) => s + Number(e.amount || 0), 0)
)
const netPL = computed(() => totalIncome.value - totalExpenses.value)

// Animated number counters
const displayIncome = ref(0)
const displayExpenses = ref(0)
const displayNet = ref(0)

function animateTo(displayRef, target, duration = 800) {
  const start = displayRef.value
  const startTime = performance.now()
  function tick(now) {
    const t = Math.min((now - startTime) / duration, 1)
    const eased = 1 - Math.pow(1 - t, 3)
    displayRef.value = start + (target - start) * eased
    if (t < 1) requestAnimationFrame(tick)
    else displayRef.value = target
  }
  requestAnimationFrame(tick)
}

watch(totalIncome, v => animateTo(displayIncome, v), { immediate: true })
watch(totalExpenses, v => animateTo(displayExpenses, v), { immediate: true })
watch(netPL, v => animateTo(displayNet, v), { immediate: true })

// Monthly chart — last 6 months, income vs expenses
const monthlyChartData = computed(() => {
  const months = []
  const now = new Date()
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const income = paidInvoices.value.reduce((sum, inv) => {
      const pd = toDate(inv.paid_on || inv.created_at)
      if (pd && pd.getFullYear() === d.getFullYear() && pd.getMonth() === d.getMonth()) {
        return sum + (inv.price_per_student || 0) * (inv.quantity || 0)
      }
      return sum
    }, 0)
    const expense = visibleExpenses.value.reduce((sum, e) => {
      const ed = toDate(e.date)
      if (ed && ed.getFullYear() === d.getFullYear() && ed.getMonth() === d.getMonth()) {
        return sum + Number(e.amount || 0)
      }
      return sum
    }, 0)
    months.push({ label: d.toLocaleDateString('en-IN', { month: 'short' }), income, expense })
  }
  return months
})

const chartMax = computed(() =>
  Math.max(1, ...monthlyChartData.value.flatMap(m => [m.income, m.expense]))
)

function barHeight(v) {
  if (!v) return 3
  return Math.max(4, (v / chartMax.value) * 100)
}

// Category totals for a given month offset (0 = this month, 1 = last month)
function monthTotals(offsetMonths) {
  const now = new Date()
  const target = new Date(now.getFullYear(), now.getMonth() - offsetMonths, 1)
  const totals = {}
  visibleExpenses.value.forEach(e => {
    const d = toDate(e.date)
    if (d && d.getFullYear() === target.getFullYear() && d.getMonth() === target.getMonth()) {
      totals[e.category] = (totals[e.category] || 0) + Number(e.amount || 0)
    }
  })
  return totals
}

const categorySummaryTable = computed(() => {
  const thisMonth = monthTotals(0)
  const lastMonth = monthTotals(1)
  const totals = {}
  visibleExpenses.value.forEach(e => {
    totals[e.category] = (totals[e.category] || 0) + Number(e.amount || 0)
  })
  const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0) || 1
  return Object.keys(totals)
    .map(name => ({
      name,
      emoji: categoryEmoji(name),
      thisMonth: thisMonth[name] || 0,
      lastMonth: lastMonth[name] || 0,
      total: totals[name],
      pct: (totals[name] / grandTotal) * 100,
    }))
    .sort((a, b) => b.total - a.total)
})

// School-wise expense breakdown (only schools with at least one linked expense)
const schoolWiseExpenses = computed(() => {
  const totals = {}
  visibleExpenses.value.forEach(e => {
    if (!e.school_id) return
    if (!totals[e.school_id]) totals[e.school_id] = { school_id: e.school_id, school_name: e.school_name || 'Unknown', total: 0 }
    totals[e.school_id].total += Number(e.amount || 0)
  })
  const grandTotal = totalExpenses.value || 1
  return Object.values(totals)
    .map(t => ({ ...t, pct: (t.total / grandTotal) * 100 }))
    .sort((a, b) => b.total - a.total)
})

const activeSchoolFilterName = computed(() =>
  schoolWiseExpenses.value.find(s => s.school_id === filterSchoolId.value)?.school_name || ''
)

function onSchoolRowClick(row) {
  filterSchoolId.value = filterSchoolId.value === row.school_id ? null : row.school_id
}

// School profitability — schools with both invoiced revenue and linked expenses
const schoolProfitability = computed(() => {
  const bySchool = {}
  const upsert = (id, name) => {
    if (!bySchool[id]) bySchool[id] = { school_id: id, school_name: name || 'Unknown', revenue: 0, cost: 0 }
    return bySchool[id]
  }
  paidInvoices.value.forEach(i => {
    if (!i.school_id) return
    upsert(i.school_id, i.school_name).revenue += (i.price_per_student || 0) * (i.quantity || 0)
  })
  visibleExpenses.value.forEach(e => {
    if (!e.school_id) return
    upsert(e.school_id, e.school_name).cost += Number(e.amount || 0)
  })
  return Object.values(bySchool)
    .filter(s => s.revenue > 0 && s.cost > 0)
    .map(s => ({ ...s, profit: s.revenue - s.cost, margin: (s.revenue - s.cost) / s.revenue * 100 }))
    .sort((a, b) => b.profit - a.profit)
})

function marginClass(margin) {
  if (margin > 50) return 'bg-emerald-100 text-emerald-700'
  if (margin >= 20) return 'bg-amber-100 text-amber-700'
  return 'bg-red-100 text-red-700'
}

// ── Filters ───────────────────────────────────────────────────────────────────

const filteredExpensesList = computed(() => {
  return sortedExpenses.value.filter(e => {
    if (filterCategories.value.length && !filterCategories.value.includes(e.category)) return false
    if (filterSchoolId.value && e.school_id !== filterSchoolId.value) return false

    const d = toDate(e.date)
    if (filterMonth.value && d) {
      if (d.getFullYear() !== filterMonth.value.getFullYear() || d.getMonth() !== filterMonth.value.getMonth()) return false
    }
    if (filterFrom.value && d && d < filterFrom.value) return false
    if (filterTo.value && d) {
      const to = new Date(filterTo.value)
      to.setHours(23, 59, 59, 999)
      if (d > to) return false
    }
    return true
  })
})

function clearFilters() {
  filterCategories.value = []
  filterMonth.value = null
  filterFrom.value = null
  filterTo.value = null
  filterSchoolId.value = null
}

function onCategoryRowClick(row) {
  if (filterCategories.value.length === 1 && filterCategories.value[0] === row.name) {
    filterCategories.value = []
  } else {
    filterCategories.value = [row.name]
  }
}

function paymentModeClass(mode) {
  switch (mode) {
    case 'Cash':           return 'bg-emerald-100 text-emerald-700'
    case 'UPI':            return 'bg-blue-100 text-blue-700'
    case 'Bank Transfer':  return 'bg-purple-100 text-purple-700'
    case 'Cheque':         return 'bg-amber-100 text-amber-700'
    default:               return 'bg-slate-100 text-slate-600'
  }
}

function exportToExcel() {
  const rows = filteredExpensesList.value.map(e => ({
    Date: formatDate(e.date),
    Category: e.category,
    Name: e.name,
    Payee: e.payee || '',
    Amount: Number(e.amount || 0),
    'Payment Mode': e.payment_mode || '',
    School: e.school_name || '',
    Notes: e.notes || '',
    Recurring: e.recurring ? (e.frequency || 'yes') : 'No',
  }))
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Expenses')
  const refDate = filterMonth.value || new Date()
  const month = refDate.toLocaleDateString('en-US', { month: 'long' })
  const year = refDate.getFullYear()
  XLSX.writeFile(wb, `Expenses_${month}_${year}.xlsx`)
}

// Smart prompts
const smartPrompts = computed(() => {
  const prompts = []
  const now = new Date()

  const salariesLogged = expenses.value.some(e => {
    const d = toDate(e.date)
    return e.category === 'Salaries' && d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
  })
  if (!salariesLogged) {
    prompts.push({ id: 'salaries', emoji: '⚠️', tone: 'warn', message: "Haven't logged Salaries this month" })
  }

  const thisMonth = monthTotals(0)
  const lastMonth = monthTotals(1)
  const cats = new Set([...Object.keys(thisMonth), ...Object.keys(lastMonth)])
  const changes = []
  cats.forEach(cat => {
    const cur = thisMonth[cat] || 0
    const prev = lastMonth[cat] || 0
    if (prev > 0) {
      const pct = Math.round(((cur - prev) / prev) * 100)
      if (Math.abs(pct) >= 20) {
        changes.push({
          id: 'cat-' + cat,
          emoji: categoryEmoji(cat),
          tone: pct > 0 ? 'warn' : 'good',
          message: `${cat} spend ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% vs last month`,
          abs: Math.abs(pct),
        })
      }
    }
  })
  changes.sort((a, b) => b.abs - a.abs)
  prompts.push(...changes.slice(0, 3))

  return prompts.slice(0, 4)
})

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadExpenses() {
  loading.value = true
  try {
    const q = query(opsCollection('expenses'), orderBy('created_at', 'desc'), limit(500))
    const snap = await getDocs(q)
    expenses.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not load expenses', life: 3000 })
  } finally {
    loading.value = false
  }
}

async function loadInvoices() {
  try {
    const snap = await getDocs(opsCollection('invoices'))
    invoices.value = snap.docs.map(d => d.data()).filter(i => !i.deleted)
  } catch (e) {
    console.error('Could not load invoices', e)
  }
}

async function loadCategories() {
  try {
    const snap = await getDocs(opsCollection('expense_categories'))
    customCategories.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load expense categories', e)
  }
}

// ── Form helpers ──────────────────────────────────────────────────────────────

function searchNames(e) {
  const q = e.query.toLowerCase()
  const names = [...new Set(expenses.value.map(x => x.name).filter(Boolean))]
  nameSuggestions.value = q ? names.filter(n => n.toLowerCase().includes(q)) : names
}

function categoryEmoji(name) {
  const found = allCategories.value.find(c => c.name === name)
  return found ? found.emoji : '💸'
}

async function addCustomCategory() {
  const name = newCategoryName.value.trim()
  if (!name) return
  const emoji = newCategoryEmoji.value || '🗂️'
  try {
    await addDoc(opsCollection('expense_categories'), {
      name, emoji,
      created_at: serverTimestamp(),
      created_by: auth.currentUser?.email || 'unknown',
    })
    customCategories.value.push({ name, emoji })
    form.category = name
    form.category_emoji = emoji
    newCategoryName.value = ''
    newCategoryEmoji.value = ''
    addCategoryOpen.value = false
    toast.add({ severity: 'success', summary: 'Category added', detail: `${emoji} ${name}`, life: 2000 })
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not add category', life: 3000 })
  }
}

function openNewExpense() {
  editingId.value = null
  Object.assign(form, emptyForm())
  pendingReceiptFile.value = null
  originalReceiptPath.value = ''
  formError.value = ''
  addCategoryOpen.value = false
  dialogVisible.value = true
}

function openEditExpense(e) {
  editingId.value = e.id
  Object.assign(form, {
    name: e.name,
    category: e.category,
    category_emoji: e.category_emoji,
    amount: e.amount,
    date: toDate(e.date) || new Date(),
    notes: e.notes || '',
    recurring: !!e.recurring,
    frequency: e.frequency || 'monthly',
    payee: e.payee || '',
    payment_mode: e.payment_mode || null,
    school_id: e.school_id || null,
    receipt_url: e.receipt_url || '',
    receipt_path: e.receipt_path || '',
  })
  pendingReceiptFile.value = null
  originalReceiptPath.value = e.receipt_path || ''
  formError.value = ''
  addCategoryOpen.value = false
  dialogVisible.value = true
}

function triggerReceiptUpload() { receiptFileInputEl.value?.click() }

function onReceiptFileSelected(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  pendingReceiptFile.value = file
  form.receipt_url = ''
}

async function removeReceipt() {
  pendingReceiptFile.value = null
  form.receipt_url = ''
  form.receipt_path = ''
  if (originalReceiptPath.value) {
    try { await deleteObject(storageRef(storage, originalReceiptPath.value)) } catch (e) { console.error('Could not remove receipt', e) }
    originalReceiptPath.value = ''
  }
}

async function uploadReceiptFile(expenseId, file, existingPath = '') {
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase()
  const path = `expenses/${expenseId}/receipt.${ext}`
  const sRef = storageRef(storage, path)
  await uploadBytes(sRef, file)
  const url = await getDownloadURL(sRef)
  if (existingPath && existingPath !== path) {
    try { await deleteObject(storageRef(storage, existingPath)) } catch (e) { console.error('Could not remove old receipt', e) }
  }
  await updateDoc(opsDoc('expenses', expenseId), { receipt_url: url, receipt_path: path })
  return url
}

function triggerRowReceiptUpload(expense) {
  rowUploadTargetId.value = expense.id
  rowReceiptInputEl.value?.click()
}

async function onRowReceiptFileSelected(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  const expenseId = rowUploadTargetId.value
  if (!file || !expenseId) return

  uploadingRowReceiptId.value = expenseId
  try {
    await uploadReceiptFile(expenseId, file)
    toast.add({ severity: 'success', summary: 'Uploaded', detail: 'Receipt attached', life: 2000 })
    await loadExpenses()
  } catch (err) {
    console.error(err)
    toast.add({ severity: 'error', summary: 'Upload failed', detail: err.message || 'Could not upload receipt', life: 4000 })
  } finally {
    uploadingRowReceiptId.value = null
    rowUploadTargetId.value = null
  }
}

function validate() {
  if (!form.name.trim())    return 'Expense name is required'
  if (!form.category)       return 'Select a category'
  if (!form.amount)         return 'Amount is required'
  if (!form.date)           return 'Date is required'
  if (form.recurring && !form.frequency) return 'Select a recurrence frequency'
  return ''
}

async function saveExpense() {
  formError.value = validate()
  if (formError.value) return

  saving.value = true
  try {
    const school = form.school_id ? allSchools.value.find(s => s.id === form.school_id) : null
    const payload = {
      name: form.name.trim(),
      category: form.category,
      category_emoji: form.category_emoji,
      amount: form.amount,
      date: Timestamp.fromDate(form.date instanceof Date ? form.date : new Date(form.date)),
      notes: form.notes.trim(),
      recurring: !!form.recurring,
      frequency: form.recurring ? form.frequency : null,
      payee: form.payee.trim(),
      payment_mode: form.payment_mode || null,
      school_id: form.school_id || null,
      school_name: school?.name || '',
      receipt_url: form.receipt_url || '',
      receipt_path: form.receipt_path || '',
    }

    let expenseId = editingId.value
    if (expenseId) {
      await updateDoc(opsDoc('expenses', expenseId), {
        ...payload,
        updated_at: serverTimestamp(),
        updated_by: auth.currentUser?.email || 'unknown',
      })
    } else {
      const docRef = await addDoc(opsCollection('expenses'), {
        ...payload,
        academic_year: effectiveAcademicYear(),
        created_at: serverTimestamp(),
        created_by: auth.currentUser?.email || 'unknown',
      })
      expenseId = docRef.id
    }

    if (pendingReceiptFile.value) {
      uploadingReceipt.value = true
      try {
        await uploadReceiptFile(expenseId, pendingReceiptFile.value, originalReceiptPath.value)
      } finally {
        uploadingReceipt.value = false
      }
    }

    toast.add({ severity: 'success', summary: editingId.value ? 'Updated' : 'Saved!', detail: `${payload.name} ${editingId.value ? 'updated' : 'added'}`, life: 2500 })
    dialogVisible.value = false
    await loadExpenses()
  } catch (e) {
    formError.value = 'Something went wrong. Try again.'
    console.error(e)
  } finally {
    saving.value = false
  }
}

function confirmDelete(expense) {
  confirm.require({
    message: `Delete "${expense.name}"?`,
    header: 'Delete Expense',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel',
    acceptLabel: 'Delete',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(opsDoc('expenses', expense.id))
        toast.add({ severity: 'info', summary: 'Deleted', life: 2000 })
        await loadExpenses()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not delete', life: 3000 })
      }
    }
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDate(ts) {
  if (!ts) return null
  return ts.toDate ? ts.toDate() : new Date(ts)
}

function formatDate(ts) {
  const d = toDate(ts)
  if (!d) return '—'
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatRupee(amount) {
  if (!amount) return '₹0'
  return '₹' + Math.round(Number(amount)).toLocaleString('en-IN')
}

onMounted(async () => {
  await Promise.all([loadExpenses(), loadInvoices(), loadCategories(), loadAllSchools()])

  if (highlightedId.value) {
    setTimeout(() => { highlightedId.value = null }, 4000)
  }
})

watch(activeYear, () => { loadExpenses() })
</script>

<style scoped>
.form-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: #64748b;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.disclaimer-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #fefce8;
  border: 1px solid #fde047;
  color: #854d0e;
  font-size: 12.5px;
  font-weight: 500;
  padding: 10px 14px;
  border-radius: 10px;
}

.prompt-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  color: #334155;
}
.prompt-card.warn { background: #fff7ed; border-color: #fed7aa; color: #9a3412; }
.prompt-card.good { background: #f0fdf4; border-color: #bbf7d0; color: #166534; }

.pl-card {
  border-radius: 18px;
  padding: 18px 20px;
  color: white;
  box-shadow: 0 8px 24px -8px rgba(0,0,0,0.15);
}
.pl-income { background: linear-gradient(135deg, #10b981, #059669); }
.pl-expense { background: linear-gradient(135deg, #f43f5e, #e11d48); }
.pl-net-positive { background: linear-gradient(135deg, #6366f1, #8b5cf6, #a855f7); }
.pl-net-negative { background: linear-gradient(135deg, #f97316, #ea580c); }

.pl-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.85;
}
.pl-value {
  font-size: 26px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
}
.pl-sub {
  font-size: 12px;
  opacity: 0.8;
  margin-top: 4px;
}

.chart-bar {
  transition: height 0.7s cubic-bezier(0.16, 1, 0.3, 1);
  min-height: 3px;
}

.recurring-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: #ede9fe;
  color: #7c3aed;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 3px 8px;
  border-radius: 999px;
}

.payment-badge {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 3px 8px;
  border-radius: 999px;
}

.pulse-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #7c3aed;
  display: inline-block;
  animation: pulseDot 1.4s ease-in-out infinite;
}
@keyframes pulseDot {
  0%, 100% { box-shadow: 0 0 0 0 rgba(124, 58, 237, 0.5); }
  50%      { box-shadow: 0 0 0 5px rgba(124, 58, 237, 0); }
}

.filter-bar {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 12px;
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 14px 16px;
}
.filter-field {
  flex: 1;
  min-width: 160px;
}

.category-summary-table :deep(.p-datatable-tbody > tr) {
  cursor: pointer;
}

:deep(.gs-highlight-row) {
  animation: gs-row-fade 4s ease-out;
}
@keyframes gs-row-fade {
  0%   { background-color: #fef9c3; }
  70%  { background-color: #fef9c3; }
  100% { background-color: transparent; }
}
</style>
