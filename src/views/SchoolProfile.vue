<template>
  <div v-if="loading" class="flex items-center justify-center py-20">
    <ProgressSpinner style="width:32px;height:32px" />
  </div>

  <div v-else-if="!school" class="text-center py-20 bg-white rounded-xl border border-slate-200">
    <i class="pi pi-building text-4xl text-slate-300 mb-3 block"></i>
    <p class="text-slate-500 font-medium">School not found</p>
    <Button label="Back to Schools" class="mt-4" @click="router.push('/schools')" />
  </div>

  <div v-else>

    <!-- Header -->
    <div class="mb-6">
      <button
        @click="router.push('/schools')"
        class="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-3 transition-colors"
      >
        <i class="pi pi-arrow-left text-xs"></i> Schools
      </button>

      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="flex items-center gap-3 flex-wrap">
            <h1 class="text-2xl font-bold text-slate-900">{{ school.name }}</h1>
            <span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">{{ school.city }}</span>
            <select
              :value="school.rm || ''"
              @change="changeRm($event.target.value)"
              class="px-2.5 py-1 rounded-full text-xs font-semibold border-0 cursor-pointer"
              :class="rmStyle(school.rm)"
            >
              <option value="">Assign RM</option>
              <option v-for="r in rmOptions" :key="r" :value="r">{{ r }}</option>
            </select>
          </div>

          <div class="flex flex-wrap gap-2 mt-3">
            <button
              v-for="s in allStatuses"
              :key="s"
              @click="toggleStatus(s)"
              class="px-3 py-1.5 rounded-full text-xs font-semibold border-2 transition-all"
              :class="school.statuses?.includes(s)
                ? statusStyle(s) + ' border-transparent'
                : 'bg-white text-slate-400 border-slate-200 hover:border-slate-300'"
            >
              {{ s }}
              <i v-if="school.statuses?.includes(s)" class="pi pi-check ml-1 text-xs"></i>
            </button>
          </div>

          <div class="flex flex-wrap gap-2 mt-3">
            <Button label="📄 Generate Agreement" size="small" outlined @click="goNewAgreement" />
            <Button label="🧾 Generate Invoice" size="small" outlined @click="goNewInvoice" />
            <Button label="📋 School Setup Guide" size="small" outlined :loading="generatingOnboarding" @click="downloadOnboardingDoc" />
          </div>
        </div>

        <Button icon="pi pi-pencil" label="Edit" text @click="openEditDialog" />
      </div>

      <!-- Overall progress bar -->
      <div class="mt-4 bg-white rounded-xl border border-slate-200 p-4">
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs font-semibold text-slate-400 uppercase tracking-wide">Overall Delivery Progress</span>
          <span class="text-sm font-bold text-slate-900">{{ overallProgress }}%</span>
        </div>
        <div class="h-2 rounded-full bg-slate-100 overflow-hidden">
          <div
            class="h-full rounded-full transition-all"
            :style="{ width: overallProgress + '%', background: progressColor(overallProgress) }"
          ></div>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <Tabs v-model:value="activeTab" value="overview">
      <TabList>
        <Tab value="overview">Overview</Tab>
        <Tab value="operations">Operations</Tab>
        <Tab value="quotations">Quotations ({{ schoolQuotations.length }})</Tab>
        <Tab value="agreements">Agreements ({{ schoolAgreements.length }})</Tab>
        <Tab value="invoices">Invoices ({{ schoolInvoices.length }})</Tab>
        <Tab value="data">Data Receivable</Tab>
      </TabList>
      <TabPanels>

        <!-- ── Overview ────────────────────────────────────────────────── -->
        <TabPanel value="overview">
          <div class="grid grid-cols-3 gap-5 pt-4">
            <div class="col-span-2 space-y-5">

              <!-- Details -->
              <div class="bg-white rounded-xl border border-slate-200 p-4">
                <div class="flex items-center justify-between mb-3">
                  <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide">Details</div>
                  <Button v-if="!editingDetails" icon="pi pi-pencil" text rounded size="small" v-tooltip="'Edit'" @click="openEditDetails" />
                  <div v-else class="flex gap-2">
                    <Button label="Cancel" text size="small" @click="cancelEditDetails" />
                    <Button label="Save" size="small" :loading="savingDetails" @click="saveDetails" />
                  </div>
                </div>

                <div v-if="!editingDetails" class="grid grid-cols-2 gap-3 text-sm">
                  <div><span class="text-slate-400">Contact</span><div class="text-slate-800 font-medium">{{ school.contact_person || '—' }}{{ school.contact_designation ? ' · ' + school.contact_designation : '' }}</div></div>
                  <div><span class="text-slate-400">Phone</span><div class="text-slate-800 font-medium">{{ school.contact_phone || '—' }}</div></div>
                  <div><span class="text-slate-400">Email</span><div class="text-slate-800 font-medium">{{ school.contact_email || '—' }}</div></div>
                  <div><span class="text-slate-400">Students</span><div class="text-slate-800 font-medium">{{ school.student_count || '—' }}</div></div>
                  <div><span class="text-slate-400">City</span><div class="text-slate-800 font-medium">{{ school.city || '—' }}</div></div>
                  <div><span class="text-slate-400">State</span><div class="text-slate-800 font-medium">{{ school.state || '—' }}</div></div>
                  <div><span class="text-slate-400">Modules</span><div class="text-slate-800 font-medium">{{ (school.modules || []).join(', ') || '—' }}</div></div>
                  <div><span class="text-slate-400">Second Language</span><div class="text-slate-800 font-medium">{{ school.second_language || 'Hindi' }}</div></div>
                  <div class="col-span-2"><span class="text-slate-400">Address</span><div class="text-slate-800 font-medium">{{ school.address || '—' }}</div></div>
                </div>

                <div v-else class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="form-label">Contact Person</label>
                    <InputText v-model="detailsForm.contact_person" class="w-full text-sm" />
                  </div>
                  <div>
                    <label class="form-label">Designation</label>
                    <InputText v-model="detailsForm.contact_designation" class="w-full text-sm" />
                  </div>
                  <div>
                    <label class="form-label">Phone</label>
                    <InputText v-model="detailsForm.contact_phone" class="w-full text-sm" />
                  </div>
                  <div>
                    <label class="form-label">Email</label>
                    <InputText v-model="detailsForm.contact_email" class="w-full text-sm" />
                  </div>
                  <div>
                    <label class="form-label">Students</label>
                    <InputNumber v-model="detailsForm.student_count" class="w-full" :min="1" />
                  </div>
                  <div>
                    <label class="form-label">City</label>
                    <InputText v-model="detailsForm.city" class="w-full text-sm" />
                  </div>
                  <div>
                    <label class="form-label">State</label>
                    <InputText v-model="detailsForm.state" class="w-full text-sm" />
                  </div>
                  <div>
                    <label class="form-label">Modules</label>
                    <MultiSelect v-model="detailsForm.modules" :options="moduleOptions" placeholder="Select modules" class="w-full" />
                  </div>
                  <div>
                    <label class="form-label">Second Language</label>
                    <InputText v-model="detailsForm.second_language" class="w-full text-sm" placeholder="e.g. Hindi" />
                  </div>
                  <div class="col-span-2">
                    <label class="form-label">Address</label>
                    <Textarea v-model="detailsForm.address" class="w-full" rows="2" autoResize />
                  </div>
                </div>
              </div>

              <!-- Commercial Details -->
              <div class="bg-white rounded-xl border border-slate-200 p-4">
                <div class="flex items-center justify-between mb-3">
                  <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide">Commercial Details</div>
                  <Button v-if="!editingCommercial" icon="pi pi-pencil" text rounded size="small" v-tooltip="'Edit'" @click="openEditCommercial" />
                  <div v-else class="flex gap-2">
                    <Button label="Cancel" text size="small" @click="cancelEditCommercial" />
                    <Button label="Save" size="small" :loading="savingCommercial" @click="saveCommercial" />
                  </div>
                </div>

                <div v-if="!editingCommercial" class="grid grid-cols-2 gap-3 text-sm">
                  <div><span class="text-slate-400">Price per Student</span><div class="text-slate-800 font-medium">{{ school.price_per_student ? '₹' + formatPrice(school.price_per_student) : '—' }}</div></div>
                  <div><span class="text-slate-400">HPC Type</span><div class="text-slate-800 font-medium">{{ hpcTypeLabel(school.hpc_type) }}</div></div>
                  <div><span class="text-slate-400">Installment Plan</span><div class="text-slate-800 font-medium">{{ school.installment_plan ? `Plan ${school.installment_plan} · ${school.installment_plan === 'B' ? '25-25-25-25' : '50-25-25'}` : '—' }}</div></div>
                  <div class="col-span-2"><span class="text-slate-400">Payment Terms Notes</span><div class="text-slate-800 font-medium">{{ school.payment_notes || '—' }}</div></div>
                </div>

                <div v-else class="space-y-3">
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <label class="form-label">Price per Student (₹)</label>
                      <InputNumber v-model="commercialForm.price_per_student" class="w-full" :min="1" :minFractionDigits="0" :maxFractionDigits="2" />
                    </div>
                    <div>
                      <label class="form-label">HPC Type</label>
                      <div class="flex gap-2">
                        <button
                          v-for="opt in hpcTypes"
                          :key="opt.value"
                          type="button"
                          @click="commercialForm.hpc_type = opt.value"
                          class="flex-1 py-2 px-2 rounded-lg text-xs font-medium border transition-all"
                          :class="commercialForm.hpc_type === opt.value
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
                        >{{ opt.label }}</button>
                      </div>
                    </div>
                  </div>
                  <div>
                    <label class="form-label">Installment Plan</label>
                    <div class="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        @click="commercialForm.installment_plan = 'A'"
                        class="p-2.5 rounded-lg border text-left transition-all"
                        :class="commercialForm.installment_plan === 'A' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'"
                      >
                        <div class="font-semibold text-xs text-slate-900">Plan A</div>
                        <div class="text-[11px] text-slate-500">50% · 25% · 25%</div>
                      </button>
                      <button
                        type="button"
                        @click="commercialForm.installment_plan = 'B'"
                        class="p-2.5 rounded-lg border text-left transition-all"
                        :class="commercialForm.installment_plan === 'B' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'"
                      >
                        <div class="font-semibold text-xs text-slate-900">Plan B</div>
                        <div class="text-[11px] text-slate-500">25% · 25% · 25% · 25%</div>
                      </button>
                    </div>
                  </div>
                  <div>
                    <label class="form-label">Payment Terms Notes</label>
                    <Textarea v-model="commercialForm.payment_notes" class="w-full" rows="2" autoResize />
                  </div>
                </div>
              </div>

              <!-- Points of Contact -->
              <div class="bg-white rounded-xl border border-slate-200 p-4">
                <div class="flex items-center justify-between mb-3">
                  <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide">Points of Contact</div>
                  <Button icon="pi pi-plus" text rounded size="small" v-tooltip="'Add Contact'" @click="openAddPoc" />
                </div>
                <div v-if="(school.pocs || []).length === 0 && editingPocIndex !== 'new'" class="text-center py-6 text-slate-300 text-sm">No contacts added yet</div>
                <div v-else class="space-y-2">
                  <div
                    v-for="(poc, i) in school.pocs"
                    :key="i"
                    class="bg-slate-50 rounded-lg p-3"
                  >
                    <div v-if="editingPocIndex !== i" class="flex items-center justify-between">
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="text-sm font-bold text-slate-900">{{ poc.name }}</span>
                        <span v-if="poc.position" class="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700">{{ poc.position }}</span>
                      </div>
                      <div class="flex items-center gap-1 flex-shrink-0">
                        <a v-if="poc.phone" :href="`tel:${poc.phone}`" class="text-sm text-violet-600 font-medium mr-1">📞 {{ poc.phone }}</a>
                        <Button icon="pi pi-pencil" text rounded size="small" @click="openEditPoc(poc, i)" />
                        <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="deletePoc(i)" />
                      </div>
                    </div>
                    <div v-else class="space-y-2">
                      <div class="grid grid-cols-3 gap-2">
                        <InputText v-model="pocForm.name" placeholder="Name" class="text-sm" />
                        <InputText v-model="pocForm.phone" placeholder="Phone" class="text-sm" />
                        <InputText v-model="pocForm.position" placeholder="Position" class="text-sm" />
                      </div>
                      <div class="flex justify-end gap-2">
                        <Button label="Cancel" text size="small" @click="cancelPocEdit" />
                        <Button label="Save" size="small" :loading="savingPoc" @click="savePoc" />
                      </div>
                    </div>
                  </div>

                  <div v-if="editingPocIndex === 'new'" class="bg-slate-50 rounded-lg p-3 space-y-2">
                    <div class="grid grid-cols-3 gap-2">
                      <InputText v-model="pocForm.name" placeholder="Name" class="text-sm" />
                      <InputText v-model="pocForm.phone" placeholder="Phone" class="text-sm" />
                      <InputText v-model="pocForm.position" placeholder="Position" class="text-sm" />
                    </div>
                    <div class="flex justify-end gap-2">
                      <Button label="Cancel" text size="small" @click="cancelPocEdit" />
                      <Button label="Save" size="small" :loading="savingPoc" @click="savePoc" />
                    </div>
                  </div>
                </div>
              </div>

              <!-- Notes -->
              <div class="bg-white rounded-xl border border-slate-200 p-4">
                <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Notes</div>
                <div class="flex gap-2 mb-3">
                  <InputText
                    v-model="newNote"
                    class="flex-1 text-sm"
                    placeholder="Add a note..."
                    @keyup.enter="addNote"
                  />
                  <Button icon="pi pi-plus" size="small" :disabled="!newNote.trim()" @click="addNote" />
                </div>
                <div v-if="(school.notes || []).length === 0" class="text-center py-6 text-slate-300 text-sm">No notes yet</div>
                <div v-else class="space-y-2">
                  <div
                    v-for="note in [...(school.notes || [])].reverse()"
                    :key="note.id"
                    class="bg-slate-50 rounded-lg p-3"
                  >
                    <div v-if="editingNoteId !== note.id">
                      <p class="text-sm text-slate-800 leading-relaxed">{{ note.text }}</p>
                      <div class="flex items-center justify-between mt-1.5">
                        <span class="text-xs text-slate-400">{{ formatDateTime(note.created_at) }}</span>
                        <div class="flex gap-1">
                          <Button icon="pi pi-pencil" text rounded size="small" @click="startEditNote(note)" />
                          <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="deleteNote(note.id)" />
                        </div>
                      </div>
                    </div>
                    <div v-else class="space-y-2">
                      <InputText v-model="editNoteText" class="w-full text-sm" @keyup.enter="saveEditNote(note.id)" />
                      <div class="flex gap-2 justify-end">
                        <Button label="Cancel" text size="small" @click="editingNoteId = null" />
                        <Button label="Save" size="small" @click="saveEditNote(note.id)" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Documents -->
            <div>
              <div class="bg-white rounded-xl border border-slate-200 p-4">
                <div class="flex items-center justify-between mb-3">
                  <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide">Documents ({{ (school.documents || []).length }})</div>
                  <div class="flex gap-1">
                    <Button icon="pi pi-link" text rounded size="small" v-tooltip="'Add Link'" @click="showAddLink = !showAddLink" />
                    <Button icon="pi pi-upload" text rounded size="small" :loading="uploadingDoc" v-tooltip="'Upload File'" @click="triggerDocUpload" />
                  </div>
                </div>

                <div
                  @dragover.prevent="onDocDragOver"
                  @dragleave.prevent="onDocDragLeave"
                  @drop.prevent="onDocDrop"
                  @click="triggerDocUpload"
                  class="mb-3 border-2 border-dashed rounded-lg py-4 px-3 text-center text-xs cursor-pointer transition-colors"
                  :class="isDraggingDoc ? 'border-blue-400 bg-blue-50 text-blue-600' : 'border-slate-200 text-slate-400 hover:border-slate-300'"
                >
                  <i class="pi pi-cloud-upload text-lg mb-1 block"></i>
                  Drag &amp; drop files here or click to browse
                </div>

                <div v-if="uploadQueue.length" class="space-y-1.5 mb-3">
                  <div v-for="item in uploadQueue" :key="item.id" class="flex items-center gap-2 text-xs bg-slate-50 rounded-lg px-2.5 py-1.5">
                    <i
                      :class="item.status === 'uploading' ? 'pi pi-spin pi-spinner text-blue-500'
                        : item.status === 'done' ? 'pi pi-check text-green-500'
                        : 'pi pi-times text-red-500'"
                    ></i>
                    <span class="flex-1 truncate text-slate-600">{{ item.name }}</span>
                  </div>
                </div>

                <div v-if="showAddLink" class="flex flex-col gap-2 mb-3 bg-slate-50 rounded-lg p-3">
                  <InputText v-model="linkForm.name" placeholder="Link name" class="text-sm" />
                  <InputText v-model="linkForm.url" placeholder="https://..." class="text-sm" />
                  <div class="flex gap-2 justify-end">
                    <Button label="Cancel" text size="small" @click="showAddLink = false" />
                    <Button label="Add" size="small" @click="addLink" />
                  </div>
                </div>

                <div v-if="(school.documents || []).length === 0 && !showAddLink" class="text-center py-6 text-slate-300 text-sm">No documents yet</div>
                <div v-else class="space-y-2">
                  <div
                    v-for="item in [...(school.documents || [])].reverse()"
                    :key="item.id"
                    class="bg-slate-50 rounded-lg p-2.5 flex items-center justify-between"
                  >
                    <div class="flex items-center gap-2 min-w-0">
                      <i :class="item.type === 'link' ? 'pi pi-link' : 'pi pi-file'" class="text-slate-400"></i>
                      <div class="min-w-0">
                        <div class="text-sm font-medium text-slate-800 truncate">{{ item.name }}</div>
                        <div class="text-xs text-slate-400">{{ formatDateTime(item.uploaded_at) }}</div>
                      </div>
                    </div>
                    <div class="flex items-center gap-1 flex-shrink-0">
                      <Button icon="pi pi-external-link" text rounded size="small" @click="downloadDocument(item)" />
                      <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="deleteDocument(item)" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </TabPanel>

        <!-- ── Operations ──────────────────────────────────────────────── -->
        <TabPanel value="operations">
          <div class="pt-4 space-y-5">
            <div class="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between">
              <div>
                <div class="text-sm font-semibold text-slate-800">Number of Terms</div>
                <div class="text-xs text-slate-400">Changes how many term sections are tracked</div>
              </div>
              <div class="flex gap-2">
                <button
                  v-for="n in [1, 2, 3, 4]"
                  :key="n"
                  @click="setNumTerms(n)"
                  class="w-10 h-10 rounded-lg text-sm font-semibold border transition-all"
                  :class="operations?.num_terms === n
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
                >{{ n }}</button>
              </div>
            </div>

            <div v-if="!operations" class="flex items-center justify-center py-10">
              <ProgressSpinner style="width:28px;height:28px" />
            </div>

            <template v-else>
              <OperationSectionCard title="Onboarding" :items="operations.onboarding" @change="saveOperations" />

              <div>
                <div class="text-sm font-bold text-slate-900 mb-3">Term Progress</div>
                <div class="grid gap-4" :class="termsGridClass">
                  <OperationSectionCard
                    v-for="t in operations.terms"
                    :key="t.term_number"
                    :title="`Term ${t.term_number}`"
                    :items="t.items"
                    @change="saveOperations"
                  />
                </div>
              </div>

              <OperationSectionCard title="Final Term" :items="operations.final_term" @change="saveOperations" />
            </template>
          </div>
        </TabPanel>

        <!-- ── Quotations ──────────────────────────────────────────────── -->
        <TabPanel value="quotations">
          <div class="pt-4">
            <div class="flex justify-end mb-3">
              <Button label="New Quotation" icon="pi pi-plus" size="small" @click="goNewQuotation" />
            </div>
            <div v-if="schoolQuotations.length === 0" class="text-center py-10 text-slate-300 text-sm bg-white rounded-xl border border-slate-200">No quotations yet</div>
            <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <DataTable :value="schoolQuotations" size="small" stripedRows>
                <Column field="quotation_number" header="Ref #">
                  <template #body="{ data }"><span class="font-mono text-xs text-slate-600">{{ data.quotation_number }}</span></template>
                </Column>
                <Column header="Date">
                  <template #body="{ data }"><span class="text-xs text-slate-500">{{ formatDate(data.created_at) }}</span></template>
                </Column>
                <Column header="Options">
                  <template #body="{ data }">
                    <div class="flex gap-1">
                      <span v-if="data.show_a !== false" class="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">A: ₹{{ data.price_a }}</span>
                      <span v-if="data.show_b !== false" class="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">B: ₹{{ data.price_b }}</span>
                    </div>
                  </template>
                </Column>
                <Column header="Status">
                  <template #body="{ data }">
                    <span v-if="data.converted_to_agreement_id" class="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">Converted</span>
                    <span v-else class="px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-500">Pending</span>
                  </template>
                </Column>
                <Column header="" style="width:60px">
                  <template #body="{ data }"><Button icon="pi pi-download" text rounded size="small" @click="downloadQuotation(data)" /></template>
                </Column>
              </DataTable>
            </div>
          </div>
        </TabPanel>

        <!-- ── Agreements ──────────────────────────────────────────────── -->
        <TabPanel value="agreements">
          <div class="pt-4">
            <div class="flex justify-end mb-3">
              <Button label="New Agreement" icon="pi pi-plus" size="small" @click="goNewAgreement" />
            </div>
            <div v-if="schoolAgreements.length === 0" class="text-center py-10 text-slate-300 text-sm bg-white rounded-xl border border-slate-200">No agreements yet</div>
            <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <DataTable :value="schoolAgreements" size="small" stripedRows>
                <Column field="agreement_number" header="Ref #">
                  <template #body="{ data }"><span class="font-mono text-xs text-slate-600">{{ data.agreement_number }}</span></template>
                </Column>
                <Column header="Date">
                  <template #body="{ data }"><span class="text-xs text-slate-500">{{ formatDate(data.created_at) }}</span></template>
                </Column>
                <Column header="Fee/Student">
                  <template #body="{ data }"><span class="text-sm font-semibold text-slate-900">₹{{ formatPrice(data.fee_per_student) }}/-</span></template>
                </Column>
                <Column header="Plan">
                  <template #body="{ data }"><span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700">Plan {{ data.installment_plan }}</span></template>
                </Column>
                <Column header="Status">
                  <template #body="{ data }">
                    <span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="data.status === 'Signed' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'">{{ data.status || 'Sent' }}</span>
                  </template>
                </Column>
                <Column header="" style="width:130px">
                  <template #body="{ data }">
                    <div class="flex gap-1">
                      <Button icon="pi pi-download" text rounded size="small" v-tooltip="'Download PDF'" @click="downloadAgreement(data)" />
                      <Button
                        v-if="data.signed_pdf_url"
                        icon="pi pi-file-check" text rounded size="small" severity="success"
                        v-tooltip="'View Signed PDF'" @click="viewSignedPdf(data)"
                      />
                      <Button
                        icon="pi pi-upload" text rounded size="small"
                        :loading="uploadingAgreementId === data.id"
                        v-tooltip="'Upload Signed PDF'" @click="triggerAgreementUpload(data)"
                      />
                    </div>
                  </template>
                </Column>
              </DataTable>
            </div>
          </div>
        </TabPanel>

        <!-- ── Invoices ────────────────────────────────────────────────── -->
        <TabPanel value="invoices">
          <div class="pt-4">
            <div class="grid grid-cols-3 gap-3 mb-4">
              <div class="bg-slate-50 rounded-lg p-3">
                <div class="text-xs text-slate-400 uppercase tracking-wide mb-1">Total Invoiced</div>
                <div class="text-sm font-bold text-slate-900">{{ formatRupee(invoiceSummary.total) }}</div>
              </div>
              <div class="bg-green-50 rounded-lg p-3">
                <div class="text-xs text-slate-400 uppercase tracking-wide mb-1">Total Paid</div>
                <div class="text-sm font-bold text-green-700">{{ formatRupee(invoiceSummary.paid) }}</div>
              </div>
              <div class="bg-amber-50 rounded-lg p-3">
                <div class="text-xs text-slate-400 uppercase tracking-wide mb-1">Outstanding</div>
                <div class="text-sm font-bold text-amber-700">{{ formatRupee(invoiceSummary.outstanding) }}</div>
              </div>
            </div>

            <div class="flex justify-end mb-3">
              <Button label="New Invoice" icon="pi pi-plus" size="small" @click="goNewInvoice" />
            </div>

            <div v-if="schoolInvoices.length === 0" class="text-center py-10 text-slate-300 text-sm bg-white rounded-xl border border-slate-200">No invoices yet</div>
            <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <DataTable :value="schoolInvoices" size="small" stripedRows>
                <Column field="invoice_number" header="Invoice #">
                  <template #body="{ data }"><span class="font-mono text-xs text-slate-700">{{ data.invoice_number }}</span></template>
                </Column>
                <Column field="description" header="Description">
                  <template #body="{ data }"><span class="text-sm text-slate-600">{{ data.description }}</span></template>
                </Column>
                <Column header="Stage">
                  <template #body="{ data }"><span class="text-xs font-medium text-slate-500">{{ data.installment_type || '—' }}</span></template>
                </Column>
                <Column header="Amount">
                  <template #body="{ data }"><span class="text-sm font-semibold text-slate-900">{{ formatRupee(data.price_per_student * data.quantity) }}</span></template>
                </Column>
                <Column header="Due Date">
                  <template #body="{ data }"><span class="text-xs text-slate-500">{{ formatDate(data.due_date) }}</span></template>
                </Column>
                <Column header="Status">
                  <template #body="{ data }">
                    <span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="data.status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'">{{ data.status === 'paid' ? 'Paid' : 'Unpaid' }}</span>
                  </template>
                </Column>
                <Column header="" style="width:100px">
                  <template #body="{ data }">
                    <div class="flex gap-1">
                      <Button
                        v-if="data.status !== 'paid'"
                        icon="pi pi-check" text rounded size="small" severity="success"
                        v-tooltip="'Mark as Paid'" @click="markInvoicePaid(data)"
                      />
                      <Button icon="pi pi-download" text rounded size="small" v-tooltip="'Download PDF'" @click="downloadInvoice(data)" />
                    </div>
                  </template>
                </Column>
              </DataTable>
            </div>
          </div>
        </TabPanel>

        <!-- ── Data Receivable ─────────────────────────────────────────── -->
        <TabPanel value="data">
          <div class="pt-4 space-y-5">
            <div v-if="!dataReceivable" class="flex items-center justify-center py-10">
              <ProgressSpinner style="width:28px;height:28px" />
            </div>
            <template v-else>
              <DataReceivableSectionCard title="Onboarding Data" :items="dataReceivable.phases.onboarding" @change="saveDataReceivable" />
              <DataReceivableSectionCard title="Term 1 Data" :items="dataReceivable.phases.term1" @change="saveDataReceivable" />
              <DataReceivableSectionCard title="Term 2 Data" :items="dataReceivable.phases.term2" @change="saveDataReceivable" />
              <DataReceivableSectionCard title="Final Term Data" :items="dataReceivable.phases.final" @change="saveDataReceivable" />
            </template>
          </div>
        </TabPanel>

      </TabPanels>
    </Tabs>
  </div>

  <!-- Edit School Dialog -->
  <Dialog v-model:visible="dialogVisible" header="Edit School" modal :style="{ width: '520px' }">
    <div class="space-y-4 pt-2">
      <div class="grid grid-cols-2 gap-4">
        <div class="col-span-2">
          <label class="form-label">School Name *</label>
          <InputText v-model="form.name" class="w-full" />
        </div>
        <div>
          <label class="form-label">City *</label>
          <InputText v-model="form.city" class="w-full" />
        </div>
        <div>
          <label class="form-label">Student Count *</label>
          <InputNumber v-model="form.student_count" class="w-full" :min="1" />
        </div>
        <div class="col-span-2">
          <label class="form-label">Address</label>
          <Textarea v-model="form.address" class="w-full" rows="2" autoResize />
        </div>
        <div>
          <label class="form-label">Contact Person *</label>
          <InputText v-model="form.contact_person" class="w-full" />
        </div>
        <div>
          <label class="form-label">Designation</label>
          <InputText v-model="form.contact_designation" class="w-full" />
        </div>
        <div>
          <label class="form-label">Phone</label>
          <InputText v-model="form.contact_phone" class="w-full" />
        </div>
        <div>
          <label class="form-label">Email</label>
          <InputText v-model="form.contact_email" class="w-full" />
        </div>
        <div>
          <label class="form-label">Relationship Manager</label>
          <Select v-model="form.rm" :options="rmOptions" placeholder="Assign RM" class="w-full" showClear />
        </div>
        <div class="col-span-2">
          <label class="form-label">Modules</label>
          <MultiSelect v-model="form.modules" :options="moduleOptions" placeholder="Select modules" class="w-full" />
        </div>
      </div>
      <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
    </div>
    <template #footer>
      <Button label="Cancel" text @click="dialogVisible = false" />
      <Button label="Save Changes" :loading="saving" @click="saveSchoolDetails" />
    </template>
  </Dialog>

  <input ref="agreementFileInputEl" type="file" accept="application/pdf" class="hidden" @change="onAgreementFileSelected" />
  <input ref="docFileInputEl" type="file" multiple class="hidden" @change="onDocFileSelected" />

  <SanityCheckDialog
    :visible="sanityDialogVisible"
    :warnings="pendingWarnings"
    document-type="school setup guide"
    :on-confirm="onOnboardingSanityConfirm"
    :on-cancel="onOnboardingSanityCancel"
  />

  <ConfirmDialog />
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { activeYear, effectiveAcademicYear } from '../composables/useAcademicYear.js'
import { db, storage, auth } from '../firebase/config'
import { opsCollection, opsDoc } from '../firebase/collections.js'
import { getDoc, getDocs, setDoc, updateDoc, doc, serverTimestamp, query, limit } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import { useCelebration } from '../composables/useCelebration'
import { useSanityCheck } from '../composables/useSanityCheck.js'
import { generateAgreementFiles, generateQuotationPDF, generateInvoicePDF, generateOnboardingPDF } from '../utils/api.js'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import MultiSelect from 'primevue/multiselect'
import Select from 'primevue/select'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import TabPanels from 'primevue/tabpanels'
import TabPanel from 'primevue/tabpanel'
import OperationSectionCard from '../components/shared/OperationSectionCard.vue'
import DataReceivableSectionCard from '../components/shared/DataReceivableSectionCard.vue'
import SanityCheckDialog from '../components/shared/SanityCheckDialog.vue'

const route = useRoute()
const router = useRouter()
const confirm = useConfirm()
const toast = useToast()
const { celebrate } = useCelebration()
const { checkOnboarding } = useSanityCheck()

// ── Sanity check ─────────────────────────────────────────────────────────────
const sanityDialogVisible = ref(false)
const pendingWarnings     = ref([])

const loading    = ref(true)
const school     = ref(null)
const operations = ref(null)
const dataReceivable = ref(null)
const quotations  = ref([])
const agreements  = ref([])
const invoices    = ref([])
const activeTab   = ref('overview')

const allStatuses   = ['Lead', 'Negotiation', 'Converted']
const rmOptions     = ['Angel', 'Siddhesh']
const moduleOptions = ref(['HPC', 'SEW', 'Co-Scholastic', 'Remarks', 'Parent App'])
const hpcTypes = [
  { label: 'Printed + Digital HPC', value: 'printed and digital' },
  { label: 'Only Digital HPC',      value: 'digital only' },
]

// ── Style helpers ──────────────────────────────────────────────────────────────
function statusStyle(s) {
  if (s === 'Converted')   return 'bg-green-100 text-green-700'
  if (s === 'Negotiation') return 'bg-amber-100 text-amber-700'
  return 'bg-blue-100 text-blue-700'
}
function hpcTypeLabel(value) {
  if (value === 'printed and digital') return 'Printed + Digital HPC'
  if (value === 'digital only')        return 'Only Digital HPC'
  return '—'
}
function rmStyle(rm) {
  if (rm === 'Angel') return 'bg-purple-100 text-purple-700'
  if (rm === 'Siddhesh') return 'bg-blue-100 text-blue-700'
  return 'bg-slate-100 text-slate-500'
}
function progressColor(pct) {
  if (pct >= 80) return '#16a34a'
  if (pct >= 50) return '#d97706'
  return '#dc2626'
}

// ── Load school ────────────────────────────────────────────────────────────────
async function loadSchool() {
  try {
    const snap = await getDoc(opsDoc('schools', route.params.id))
    school.value = snap.exists()
      ? { id: snap.id, statuses: ['Converted'], notes: [], documents: [], pocs: [], ...snap.data() }
      : null
  } catch (e) {
    console.error('Could not load school', e)
    school.value = null
  }
}

async function loadModuleSettings() {
  try {
    const snap = await getDoc(doc(db, 'operations', 'settings'))
    if (snap.exists()) {
      const data = snap.data()
      if (Array.isArray(data.modules) && data.modules.length) moduleOptions.value = data.modules
    }
  } catch (e) {
    console.error('Could not load settings', e)
  }
}

async function saveSchoolField(field, value) {
  try {
    await updateDoc(opsDoc('schools', school.value.id), {
      [field]: value,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not save', life: 3000 })
  }
}

async function toggleStatus(status) {
  const current = [...(school.value.statuses || [])]
  let newStatuses
  if (status === 'Converted' && !current.includes('Converted')) {
    newStatuses = ['Converted']
  } else if (!current.includes(status)) {
    newStatuses = current.filter(s => s !== 'Converted').concat(status)
  } else {
    newStatuses = current.filter(s => s !== status)
  }
  school.value = { ...school.value, statuses: newStatuses }
  await saveSchoolField('statuses', newStatuses)
}

// ── Details (inline edit) ───────────────────────────────────────────────────
const editingDetails = ref(false)
const savingDetails  = ref(false)
const detailsForm = reactive({
  contact_person: '', contact_designation: '', contact_phone: '',
  contact_email: '', student_count: null, city: '', state: '',
  modules: [], second_language: '', address: '',
})

function openEditDetails() {
  Object.assign(detailsForm, {
    contact_person:       school.value.contact_person || '',
    contact_designation:  school.value.contact_designation || '',
    contact_phone:        school.value.contact_phone || '',
    contact_email:        school.value.contact_email || '',
    student_count:        school.value.student_count || null,
    city:                 school.value.city || '',
    state:                school.value.state || '',
    modules:              school.value.modules || [],
    second_language:      school.value.second_language || 'Hindi',
    address:              school.value.address || '',
  })
  editingDetails.value = true
}
function cancelEditDetails() {
  editingDetails.value = false
}
async function saveDetails() {
  savingDetails.value = true
  try {
    const payload = {
      contact_person:       detailsForm.contact_person.trim(),
      contact_designation:  detailsForm.contact_designation.trim(),
      contact_phone:        detailsForm.contact_phone.trim(),
      contact_email:        detailsForm.contact_email.trim(),
      student_count:        detailsForm.student_count,
      city:                 detailsForm.city.trim(),
      state:                detailsForm.state.trim(),
      modules:              detailsForm.modules,
      second_language:      detailsForm.second_language.trim() || 'Hindi',
      address:              detailsForm.address.trim(),
    }
    await updateDoc(opsDoc('schools', school.value.id), {
      ...payload,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })
    school.value = { ...school.value, ...payload }
    toast.add({ severity: 'success', summary: 'Saved', detail: 'Details updated', life: 2500 })
    editingDetails.value = false
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not save details', life: 3000 })
  } finally {
    savingDetails.value = false
  }
}

// ── Commercial Details (inline edit) ────────────────────────────────────────
const editingCommercial = ref(false)
const savingCommercial  = ref(false)
const commercialForm = reactive({ price_per_student: null, hpc_type: null, installment_plan: 'A', payment_notes: '' })

function openEditCommercial() {
  Object.assign(commercialForm, {
    price_per_student: school.value.price_per_student || null,
    hpc_type:           school.value.hpc_type || null,
    installment_plan:   school.value.installment_plan || 'A',
    payment_notes:      school.value.payment_notes || '',
  })
  editingCommercial.value = true
}
function cancelEditCommercial() {
  editingCommercial.value = false
}
async function saveCommercial() {
  savingCommercial.value = true
  try {
    const payload = {
      price_per_student: commercialForm.price_per_student || null,
      hpc_type:           commercialForm.hpc_type || null,
      installment_plan:   commercialForm.installment_plan || 'A',
      payment_notes:      commercialForm.payment_notes.trim(),
    }
    await updateDoc(opsDoc('schools', school.value.id), {
      ...payload,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })
    school.value = { ...school.value, ...payload }
    toast.add({ severity: 'success', summary: 'Saved', detail: 'Commercial details updated', life: 2500 })
    editingCommercial.value = false
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not save commercial details', life: 3000 })
  } finally {
    savingCommercial.value = false
  }
}

// ── Points of Contact (inline edit) ─────────────────────────────────────────
const savingPoc       = ref(false)
const editingPocIndex = ref(null) // null = not editing, 'new' = adding, number = editing that row
const pocForm = reactive({ name: '', phone: '', position: '' })

function openAddPoc() {
  editingPocIndex.value = 'new'
  Object.assign(pocForm, { name: '', phone: '', position: '' })
}

function openEditPoc(poc, i) {
  editingPocIndex.value = i
  Object.assign(pocForm, { name: poc.name || '', phone: poc.phone || '', position: poc.position || '' })
}

function cancelPocEdit() {
  editingPocIndex.value = null
}

async function savePoc() {
  if (!pocForm.name.trim()) {
    toast.add({ severity: 'warn', summary: 'Name is required', life: 2500 })
    return
  }
  savingPoc.value = true
  try {
    const entry = { name: pocForm.name.trim(), phone: pocForm.phone.trim(), position: pocForm.position.trim() }
    const pocs = [...(school.value.pocs || [])]
    if (editingPocIndex.value === 'new') {
      pocs.push(entry)
    } else {
      pocs[editingPocIndex.value] = entry
    }
    school.value.pocs = pocs
    await saveSchoolField('pocs', pocs)
    toast.add({ severity: 'success', summary: 'Saved', detail: 'Contact saved', life: 2000 })
    editingPocIndex.value = null
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not save contact', life: 3000 })
  } finally {
    savingPoc.value = false
  }
}

async function deletePoc(i) {
  const pocs = (school.value.pocs || []).filter((_, idx) => idx !== i)
  school.value.pocs = pocs
  await saveSchoolField('pocs', pocs)
  toast.add({ severity: 'info', summary: 'Removed', life: 2000 })
}

async function changeRm(value) {
  const rm = value || null
  school.value = { ...school.value, rm }
  await saveSchoolField('rm', rm)
}

// ── Notes ──────────────────────────────────────────────────────────────────────
const newNote       = ref('')
const editingNoteId = ref(null)
const editNoteText  = ref('')

async function addNote() {
  if (!newNote.value.trim()) return
  const note = { id: Date.now().toString(), text: newNote.value.trim(), created_at: new Date().toISOString(), academic_year: effectiveAcademicYear() }
  const notes = [...(school.value.notes || []), note]
  school.value.notes = notes
  newNote.value = ''
  await saveSchoolField('notes', notes)
}
function startEditNote(note) {
  editingNoteId.value = note.id
  editNoteText.value  = note.text
}
async function saveEditNote(id) {
  const notes = school.value.notes.map(n => n.id === id ? { ...n, text: editNoteText.value.trim() } : n)
  school.value.notes = notes
  editingNoteId.value = null
  await saveSchoolField('notes', notes)
}
async function deleteNote(id) {
  const notes = school.value.notes.filter(n => n.id !== id)
  school.value.notes = notes
  await saveSchoolField('notes', notes)
}

// ── Documents (files + links) ───────────────────────────────────────────────────
const uploadingDoc   = ref(false)
const docFileInputEl = ref(null)
const showAddLink    = ref(false)
const linkForm       = reactive({ name: '', url: '' })
const isDraggingDoc  = ref(false)
const uploadQueue    = ref([]) // [{ id, name, status: 'uploading' | 'done' | 'error' }]

function triggerDocUpload() { docFileInputEl.value?.click() }

function onDocDragOver()  { isDraggingDoc.value = true }
function onDocDragLeave() { isDraggingDoc.value = false }

async function onDocDrop(e) {
  isDraggingDoc.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  if (files.length) await uploadDocumentFiles(files)
}

async function onDocFileSelected(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  if (files.length) await uploadDocumentFiles(files)
}

async function uploadDocumentFiles(files) {
  if (!school.value) return
  uploadingDoc.value = true

  const queueItems = files.map((f, i) => ({ id: `${Date.now()}_${i}_${f.name}`, name: f.name, status: 'uploading' }))
  uploadQueue.value.push(...queueItems)

  let successCount = 0
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const queueItem = queueItems[i]
    try {
      const path = `schools/${school.value.id}/documents/${Date.now()}_${file.name}`
      const sRef = storageRef(storage, path)
      await uploadBytes(sRef, file)
      const url = await getDownloadURL(sRef)

      const docEntry = { id: `${Date.now()}_${i}`, name: file.name, url, path, type: 'file', uploaded_at: new Date().toISOString() }
      const documents = [...(school.value.documents || []), docEntry]
      school.value.documents = documents
      await saveSchoolField('documents', documents)
      queueItem.status = 'done'
      successCount++
    } catch (err) {
      console.error(err)
      queueItem.status = 'error'
      toast.add({ severity: 'error', summary: 'Upload failed', detail: err.message || `Could not upload ${file.name}`, life: 4000 })
    }
  }

  if (successCount) {
    toast.add({ severity: 'success', summary: 'Uploaded', detail: `${successCount} file${successCount !== 1 ? 's' : ''} added`, life: 2500 })
  }
  uploadingDoc.value = false
  setTimeout(() => {
    uploadQueue.value = uploadQueue.value.filter(q => !queueItems.includes(q))
  }, 3000)
}

async function addLink() {
  if (!linkForm.name.trim() || !linkForm.url.trim()) return
  const docEntry = { id: Date.now().toString(), name: linkForm.name.trim(), url: linkForm.url.trim(), type: 'link', uploaded_at: new Date().toISOString() }
  const documents = [...(school.value.documents || []), docEntry]
  school.value.documents = documents
  await saveSchoolField('documents', documents)
  linkForm.name = ''
  linkForm.url  = ''
  showAddLink.value = false
}

function downloadDocument(docEntry) {
  if (docEntry.url) window.open(docEntry.url, '_blank')
}

async function deleteDocument(docEntry) {
  const documents = (school.value.documents || []).filter(d => d.id !== docEntry.id)
  school.value.documents = documents
  await saveSchoolField('documents', documents)
  if (docEntry.path) {
    try { await deleteObject(storageRef(storage, docEntry.path)) } catch (e) { console.error('Could not delete file from storage', e) }
  }
}

// ── Operations ──────────────────────────────────────────────────────────────────
function defaultOnboarding() {
  return [
    { id: 'onboarding_doc',     label: 'Onboarding Doc Sent',      done: false, comment: '' },
    { id: 'data_entry',         label: 'Data Entry Mode Set',      done: false, comment: '' },
    { id: 'workshop',           label: 'Workshop Done',            done: false, comment: '' },
    { id: 'teacher_ids',        label: 'Teacher ID Distribution',  done: false, comment: '' },
    { id: 'student_ids',        label: 'Student ID Distribution',  done: false, comment: '' },
    { id: 'hpc_calendar',       label: 'HPC Calendar Sent',        done: false, comment: '' },
    { id: 'onboarding_parcel',  label: 'Onboarding Parcel Sent',   done: false, comment: '' },
  ]
}
function defaultTermItems(n) {
  return [
    { id: 'inclusion',              label: `T${n} Inclusion`,               done: false, comment: '' },
    { id: 'design_draft_sent',      label: 'HPC Design Draft Sent',         done: false, comment: '' },
    { id: 'design_draft_approved',  label: 'HPC Design Draft Approved',     done: false, comment: '' },
    { id: 'hpc_published',          label: 'HPC Published',                 done: false, comment: '' },
  ]
}
function defaultTerms(n) {
  return Array.from({ length: n }, (_, i) => ({ term_number: i + 1, items: defaultTermItems(i + 1) }))
}
function defaultFinalTerm() {
  return [
    { id: 'design_meeting',         label: 'Design Meeting Set',              done: false, comment: '' },
    { id: 'design_draft_sent',      label: 'Final Design Draft Sent',         done: false, comment: '' },
    { id: 'design_draft_approved',  label: 'Final Design Draft Approved',     done: false, comment: '' },
    { id: 'final_hpc_sent',         label: 'Final HPC Sent',                  done: false, comment: '' },
    { id: 'final_hpc_received',     label: 'Final HPC Received by School',    done: false, comment: '' },
    { id: 'master_folder',          label: 'Master Folder (Digital)',         done: false, comment: '' },
  ]
}

async function loadOperations() {
  try {
    const ref_ = opsDoc('school_operations', route.params.id)
    const snap = await getDoc(ref_)
    if (snap.exists()) {
      operations.value = snap.data()
    } else {
      const fresh = {
        school_id:  route.params.id,
        num_terms:  2,
        onboarding: defaultOnboarding(),
        terms:      defaultTerms(2),
        final_term: defaultFinalTerm(),
      }
      await setDoc(ref_, fresh)
      operations.value = fresh
    }
  } catch (e) {
    console.error('Could not load operations', e)
  }
}

async function saveOperations() {
  if (!operations.value) return
  try {
    await setDoc(opsDoc('school_operations', route.params.id), operations.value)
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not save operations', life: 3000 })
  }
}

// ── Data Receivable ──────────────────────────────────────────────────────────
function defaultReceivableOnboarding() {
  return [
    { id: 'academic_calendar', label: 'Academic Calendar',     received: false, date: '', notes: '' },
    { id: 'student_names',     label: 'Student Names List',    received: false, date: '', notes: '' },
    { id: 'student_photos',    label: 'Student Photos',        received: false, date: '', notes: '' },
    { id: 'teacher_list',      label: 'Teacher List',          received: false, date: '', notes: '' },
    { id: 'school_logo',       label: 'School Logo',           received: false, date: '', notes: '' },
    { id: 'principal_sign',    label: 'Principal Signature',   received: false, date: '', notes: '' },
  ]
}
function defaultReceivableTerm() {
  return [
    { id: 'attendance',     label: 'Attendance Data',      received: false, date: '', notes: '' },
    { id: 'marks',          label: 'Marks / Grades',       received: false, date: '', notes: '' },
    { id: 'remarks',        label: 'Teacher Remarks',      received: false, date: '', notes: '' },
    { id: 'sew_data',       label: 'SEW Assessment Data',  received: false, date: '', notes: '' },
    { id: 'co_scholastic',  label: 'Co-Scholastic Data',   received: false, date: '', notes: '' },
  ]
}
function defaultReceivableFinal() {
  return [
    { id: 'attendance',         label: 'Final Attendance',        received: false, date: '', notes: '' },
    { id: 'marks',              label: 'Final Marks',             received: false, date: '', notes: '' },
    { id: 'remarks',            label: 'Final Remarks',           received: false, date: '', notes: '' },
    { id: 'sew_data',           label: 'Final SEW Data',          received: false, date: '', notes: '' },
    { id: 'co_scholastic',      label: 'Final Co-Scholastic',     received: false, date: '', notes: '' },
    { id: 'extra_curricular',   label: 'Extra Curricular Data',   received: false, date: '', notes: '' },
  ]
}

async function loadDataReceivable() {
  try {
    const ref_ = opsDoc('school_data_receivable', route.params.id)
    const snap = await getDoc(ref_)
    if (snap.exists()) {
      dataReceivable.value = snap.data()
    } else {
      const fresh = {
        school_id: route.params.id,
        phases: {
          onboarding: defaultReceivableOnboarding(),
          term1:      defaultReceivableTerm(),
          term2:      defaultReceivableTerm(),
          final:      defaultReceivableFinal(),
        },
      }
      await setDoc(ref_, fresh)
      dataReceivable.value = fresh
    }
  } catch (e) {
    console.error('Could not load data receivable', e)
  }
}

async function saveDataReceivable() {
  if (!dataReceivable.value) return
  try {
    await setDoc(opsDoc('school_data_receivable', route.params.id), dataReceivable.value)
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not save data receivable', life: 3000 })
  }
}

async function setNumTerms(n) {
  if (!operations.value || operations.value.num_terms === n) return
  const existing = operations.value.terms || []
  const newTerms = Array.from({ length: n }, (_, i) => {
    const termNum = i + 1
    return existing.find(t => t.term_number === termNum) || { term_number: termNum, items: defaultTermItems(termNum) }
  })
  operations.value.num_terms = n
  operations.value.terms = newTerms
  await saveOperations()
}

const termsGridClass = computed(() => {
  const n = operations.value?.num_terms || 2
  if (n === 1) return 'grid-cols-1'
  if (n === 3) return 'grid-cols-3'
  if (n === 4) return 'grid-cols-2 lg:grid-cols-4'
  return 'grid-cols-2'
})

const allOperationItems = computed(() => {
  if (!operations.value) return []
  return [
    ...(operations.value.onboarding || []),
    ...((operations.value.terms || []).flatMap(t => t.items || [])),
    ...(operations.value.final_term || []),
  ]
})
const overallProgress = computed(() => {
  const items = allOperationItems.value
  if (!items.length) return 0
  return Math.round(items.filter(i => i.done).length / items.length * 100)
})

// ── Quotations / Agreements / Invoices ──────────────────────────────────────────
async function loadQuotations() {
  try {
    const snap = await getDocs(query(opsCollection('quotations'), limit(500)))
    quotations.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load quotations', e)
  }
}
async function loadAgreements() {
  try {
    const snap = await getDocs(query(opsCollection('agreements'), limit(500)))
    agreements.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load agreements', e)
  }
}
async function loadInvoices() {
  try {
    const snap = await getDocs(query(opsCollection('invoices'), limit(500)))
    invoices.value = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(i => !i.deleted)
  } catch (e) {
    console.error('Could not load invoices', e)
  }
}

function belongsToSchool(record) {
  if (!school.value) return false
  if (record.school_id && record.school_id === school.value.id) return true
  const name = (school.value.name || '').trim().toLowerCase()
  return (record.school_name || '').trim().toLowerCase() === name
}

function belongsToYear(record) {
  if (!activeYear.value || activeYear.value === 'All Years') return true
  return record.academic_year === activeYear.value
}

const schoolQuotations = computed(() => quotations.value.filter(r => belongsToSchool(r) && belongsToYear(r)))
const schoolAgreements = computed(() => agreements.value.filter(r => belongsToSchool(r) && belongsToYear(r)))
const schoolInvoices   = computed(() => invoices.value.filter(r => belongsToSchool(r) && belongsToYear(r)))

const invoiceSummary = computed(() => {
  const total = schoolInvoices.value.reduce((s, i) => s + i.price_per_student * i.quantity, 0)
  const paid  = schoolInvoices.value.filter(i => i.status === 'paid').reduce((s, i) => s + i.price_per_student * i.quantity, 0)
  return { total, paid, outstanding: total - paid }
})

function goNewQuotation() {
  router.push({ name: 'quotations', query: { school_id: school.value.id, school_name: school.value.name, student_count: school.value.student_count || undefined } })
}
function goNewAgreement() {
  router.push({ name: 'agreements', query: { school_id: school.value.id, school_name: school.value.name, school_address: school.value.address || undefined, school_phone: school.value.contact_phone || undefined, student_count: school.value.student_count || undefined } })
}
function goNewInvoice() {
  router.push({ name: 'invoices', query: {
    school_id: school.value.id, school_name: school.value.name,
    school_address: school.value.address || undefined, school_phone: school.value.contact_phone || undefined,
    student_count: school.value.student_count || undefined,
    price_per_student: school.value.price_per_student || undefined,
    installment_plan: school.value.installment_plan || undefined,
  } })
}

async function downloadQuotation(q) {
  try {
    await generateQuotationPDF(q)
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Download failed', detail: e.message || 'Could not generate PDF', life: 4000 })
  }
}

async function downloadAgreement(a) {
  try {
    await generateAgreementFiles(a)
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Download failed', detail: e.message || 'Could not generate files', life: 4000 })
  }
}
function viewSignedPdf(a) {
  if (a.signed_pdf_url) window.open(a.signed_pdf_url, '_blank')
}

const uploadingAgreementId  = ref(null)
const agreementFileInputEl  = ref(null)
const agreementUploadTarget = ref(null)

function triggerAgreementUpload(a) {
  agreementUploadTarget.value = a
  agreementFileInputEl.value?.click()
}

async function onAgreementFileSelected(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file || !agreementUploadTarget.value) return

  const a = agreementUploadTarget.value
  uploadingAgreementId.value = a.id
  try {
    const path = `agreements/${a.id}/signed_${Date.now()}.pdf`
    const sRef = storageRef(storage, path)
    await uploadBytes(sRef, file)
    const url = await getDownloadURL(sRef)

    await updateDoc(opsDoc('agreements', a.id), {
      status: 'Signed',
      signed_pdf_url: url,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })
    toast.add({ severity: 'success', summary: 'Signed', detail: `Signed agreement saved for ${a.school_name}`, life: 3000 })
    celebrate(`${a.school_name} signed the agreement!`, '✍️', 'agreement')
    await loadAgreements()
  } catch (err) {
    console.error(err)
    toast.add({ severity: 'error', summary: 'Upload failed', detail: err.message || 'Could not upload signed PDF', life: 4000 })
  } finally {
    uploadingAgreementId.value = null
    agreementUploadTarget.value = null
  }
}

const generatingOnboarding = ref(false)
function downloadOnboardingDoc() {
  if (!school.value) return
  const warnings = checkOnboarding(school.value)
  if (warnings.length > 0) {
    pendingWarnings.value = warnings
    sanityDialogVisible.value = true
    return
  }
  executeDownloadOnboardingDoc()
}

function onOnboardingSanityConfirm() {
  const count = pendingWarnings.value.length
  sanityDialogVisible.value = false
  executeDownloadOnboardingDoc(count)
}

function onOnboardingSanityCancel() {
  sanityDialogVisible.value = false
}

async function executeDownloadOnboardingDoc(bypassedWarnings = 0) {
  generatingOnboarding.value = true
  try {
    const year = activeYear.value && activeYear.value !== 'All Years' ? activeYear.value : effectiveAcademicYear()
    await generateOnboardingPDF(school.value, year)
    toast.add({ severity: 'success', summary: 'Downloaded', detail: 'Onboarding doc generated', life: 2500 })
    if (bypassedWarnings > 0) {
      toast.add({ severity: 'warn', summary: 'Heads up', detail: `Generated with ${bypassedWarnings} unresolved warning${bypassedWarnings !== 1 ? 's' : ''} — please review`, life: 5000 })
    }
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Download failed', detail: e.message || 'Could not generate onboarding doc', life: 4000 })
  } finally {
    generatingOnboarding.value = false
  }
}

async function downloadInvoice(inv) {
  try {
    await generateInvoicePDF(inv)
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Download failed', detail: e.message || 'Could not generate PDF', life: 4000 })
  }
}

function markInvoicePaid(invoice) {
  confirm.require({
    message: `Mark invoice ${invoice.invoice_number} as paid?`,
    header: 'Mark as Paid',
    icon: 'pi pi-check-circle',
    rejectLabel: 'Cancel',
    acceptLabel: 'Mark Paid',
    accept: async () => {
      try {
        await updateDoc(opsDoc('invoices', invoice.id), {
          status: 'paid',
          paid_on: serverTimestamp(),
          updated_at: serverTimestamp(),
          updated_by: auth.currentUser?.email || 'unknown',
        })
        const amount = formatRupee(invoice.price_per_student * invoice.quantity)
        toast.add({ severity: 'success', summary: 'Paid!', detail: `${amount} received from ${invoice.school_name}`, life: 3000 })
        celebrate(`${amount} received from ${invoice.school_name}!`, '💰', 'invoice')
        await loadInvoices()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not update invoice', life: 3000 })
      }
    }
  })
}

// ── Edit School dialog ───────────────────────────────────────────────────────────
const dialogVisible = ref(false)
const saving        = ref(false)
const formError      = ref('')
const emptyForm = () => ({
  name: '', city: '', address: '', student_count: null,
  contact_person: '', contact_designation: '',
  contact_phone: '', contact_email: '', modules: [], rm: null,
})
const form = reactive(emptyForm())

function openEditDialog() {
  Object.assign(form, {
    name: school.value.name || '', city: school.value.city || '',
    address: school.value.address || '', student_count: school.value.student_count || null,
    contact_person: school.value.contact_person || '', contact_designation: school.value.contact_designation || '',
    contact_phone: school.value.contact_phone || '', contact_email: school.value.contact_email || '',
    modules: school.value.modules || [], rm: school.value.rm || null,
  })
  formError.value = ''
  dialogVisible.value = true
}

function validate() {
  if (!form.name.trim())           return 'School name is required'
  if (!form.city.trim())           return 'City is required'
  if (!form.contact_person.trim()) return 'Contact person is required'
  if (!form.student_count)         return 'Student count is required'
  return ''
}

async function saveSchoolDetails() {
  formError.value = validate()
  if (formError.value) return
  saving.value = true
  try {
    const payload = {
      name: form.name.trim(), city: form.city.trim(), address: form.address.trim(),
      student_count: form.student_count,
      contact_person: form.contact_person.trim(), contact_designation: form.contact_designation.trim(),
      contact_phone: form.contact_phone.trim(), contact_email: form.contact_email.trim(),
      modules: form.modules, rm: form.rm || null,
    }
    payload.updated_at = serverTimestamp()
    payload.updated_by = auth.currentUser?.email || 'unknown'
    await updateDoc(opsDoc('schools', school.value.id), payload)
    school.value = { ...school.value, ...payload }
    toast.add({ severity: 'success', summary: 'Saved', detail: 'School updated', life: 2500 })
    dialogVisible.value = false
  } catch (e) {
    formError.value = 'Something went wrong. Try again.'
  } finally {
    saving.value = false
  }
}

// ── Formatters ────────────────────────────────────────────────────────────────
function formatDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}
function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' · ' +
    d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
}
function formatRupee(amount) {
  if (!amount) return '₹0'
  return '₹' + formatPrice(amount)
}
function formatPrice(n) {
  if (n == null) return '0'
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

// ── Load everything ──────────────────────────────────────────────────────────────
async function loadEverything() {
  loading.value = true
  activeTab.value = 'overview'
  try {
    await loadSchool()
    if (school.value) {
      await Promise.all([loadOperations(), loadDataReceivable(), loadQuotations(), loadAgreements(), loadInvoices()])
    }
  } finally {
    loading.value = false
  }
}

watch(() => route.params.id, loadEverything)
watch(activeYear, () => { Promise.all([loadQuotations(), loadAgreements(), loadInvoices()]) })

onMounted(async () => {
  await Promise.all([loadEverything(), loadModuleSettings()])
})
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
</style>
