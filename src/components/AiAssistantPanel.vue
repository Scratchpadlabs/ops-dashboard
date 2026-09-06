<template>
  <Teleport to="body">
    <div v-if="isAiAssistantOpen" class="ai-overlay" @click="close">
      <div class="ai-card" @click.stop @keydown.esc="close">
        <div class="ai-header">
          <div class="ai-header-title">
            <i class="pi pi-sparkles"></i>
            <span>AI Assistant</span>
          </div>
          <div class="ai-school-badge" :class="{ 'ai-school-badge--empty': !activeSchoolId }">
            <i class="pi pi-building" style="font-size:10px"></i>
            {{ activeSchoolId ? (activeSchoolName || activeSchoolId) : 'No school selected' }}
          </div>
          <button class="ai-close-btn" @click="close"><i class="pi pi-times"></i></button>
        </div>

        <p class="ai-disclaimer">
          Read-only — it never writes to Firestore. When it drafts something, you'll review
          and save it yourself on the existing page for that config.
        </p>

        <div ref="transcriptEl" class="ai-transcript">
          <div v-if="!messages.length" class="ai-empty">
            Ask about how the dashboard works, this school's config, or say
            "draft an import template for ..." to get a pre-filled form.
          </div>
          <div
            v-for="(m, i) in messages"
            :key="i"
            class="ai-msg"
            :class="m.role === 'user' ? 'ai-msg--user' : 'ai-msg--assistant'"
          >
            <div class="ai-msg-bubble">{{ m.content }}</div>
            <button
              v-if="m.proposalKind"
              class="ai-apply-btn"
              @click="applyProposal(m)"
            >
              <i class="pi pi-external-link"></i> Open as draft in {{ registryLabel(m.proposalKind) }}
            </button>
          </div>
          <div v-if="loading" class="ai-msg ai-msg--assistant">
            <div class="ai-msg-bubble ai-msg-bubble--loading"><ProgressSpinner style="width:16px;height:16px" /></div>
          </div>
        </div>

        <div v-if="errorText" class="ai-error">{{ errorText }}</div>

        <div class="ai-input-row">
          <input
            ref="inputEl"
            v-model="draft"
            type="text"
            placeholder="Ask a question, or 'draft an import template for ...'"
            class="ai-input"
            :disabled="loading"
            @keydown.enter="send"
          />
          <Button icon="pi pi-send" :loading="loading" :disabled="!draft.trim()" @click="send" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import ProgressSpinner from 'primevue/progressspinner'

import { isAiAssistantOpen } from '../composables/useAiAssistant.js'
import { activeSchoolId, activeSchoolName } from '../composables/useActiveSchool.js'
import { setPendingAiDraft } from '../composables/usePendingAiDraft.js'
import { aiAssistantRemote } from '../utils/api.js'

const router = useRouter()

// proposalKind -> where a drafted proposal of that kind gets pre-filled.
// Adding a new kind is an additive row here PLUS a matching onMounted
// pickup in that target view (see usePendingAiDraft.js) — never a new write
// path. Kinds not listed here still get plain-text help from the assistant
// (see functions/ai_assistant/main.py's PROPOSAL_INSTRUCTIONS fallback).
const REGISTRY = {
  import_template: { label: 'Import Templates', route: () => ({ name: 'import-templates' }) },
  subject_draft: { label: 'School Setup → Subjects', route: () => ({ name: 'school-setup', query: { aiDraftTab: 'subjects', aiDraftSchoolId: activeSchoolId.value || '' } }) },
  assessment_bulk: { label: 'School Setup → Assessments', route: () => ({ name: 'school-setup', query: { aiDraftTab: 'assessments', aiDraftSchoolId: activeSchoolId.value || '' } }) },
}

function registryLabel(kind) { return REGISTRY[kind]?.label || kind }

const messages = ref([])
const draft = ref('')
const loading = ref(false)
const errorText = ref('')
const inputEl = ref(null)
const transcriptEl = ref(null)

function close() { isAiAssistantOpen.value = false }

async function scrollToBottom() {
  await nextTick()
  if (transcriptEl.value) transcriptEl.value.scrollTop = transcriptEl.value.scrollHeight
}

// Only role/content is ever sent to the callable — proposalKind/proposal are
// local UI state on the assistant's own turn, not part of the chat history.
function historyPayload() {
  return messages.value.map(m => ({ role: m.role, content: m.content }))
}

function detectProposalKind(text) {
  const t = text.toLowerCase()
  if (/import template/.test(t)) return 'import_template'
  if (/subject/.test(t) && /(draft|add|create)/.test(t)) return 'subject_draft'
  if (/assessment/.test(t) && /(draft|bulk|create|build)/.test(t)) return 'assessment_bulk'
  return null
}

async function send() {
  const text = draft.value.trim()
  if (!text || loading.value) return
  draft.value = ''
  messages.value.push({ role: 'user', content: text })
  await scrollToBottom()

  loading.value = true
  errorText.value = ''
  try {
    const proposalKind = detectProposalKind(text)
    const res = await aiAssistantRemote({
      schoolId: activeSchoolId.value,
      messages: historyPayload(),
      proposalKind,
    })
    if (res.type === 'proposal') {
      messages.value.push({
        role: 'assistant',
        content: `Drafted a ${registryLabel(res.proposalKind)} entry from our conversation.`,
        proposalKind: res.proposalKind,
        proposal: res.proposal,
      })
    } else {
      messages.value.push({ role: 'assistant', content: res.content })
    }
  } catch (e) {
    console.error(e)
    errorText.value = e.message || 'Something went wrong.'
  } finally {
    loading.value = false
    await scrollToBottom()
  }
}

function applyProposal(m) {
  const entry = REGISTRY[m.proposalKind]
  if (!entry) return
  setPendingAiDraft(m.proposalKind, m.proposal)
  close()
  router.push(entry.route())
}

watch(isAiAssistantOpen, async (val) => {
  if (val) {
    await nextTick()
    inputEl.value?.focus()
  }
})
</script>

<style scoped>
.ai-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  justify-content: flex-end;
  background: rgba(15, 23, 42, 0.35);
}

.ai-card {
  width: 420px;
  max-width: 100vw;
  height: 100vh;
  background: white;
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.25);
  display: flex;
  flex-direction: column;
}

.ai-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.ai-header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  color: #0f172a;
}
.ai-school-badge {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  color: #334155;
  background: #f1f5f9;
  border-radius: 999px;
  padding: 4px 10px;
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 180px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ai-school-badge--empty { color: #94a3b8; }
.ai-close-btn {
  border: none;
  background: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px;
}
.ai-close-btn:hover { color: #334155; }

.ai-disclaimer {
  font-size: 11px;
  color: #94a3b8;
  padding: 8px 16px;
  border-bottom: 1px solid #f1f5f9;
  margin: 0;
  flex-shrink: 0;
}

.ai-transcript {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-empty {
  font-size: 13px;
  color: #94a3b8;
  text-align: center;
  padding: 32px 12px;
}

.ai-msg { display: flex; flex-direction: column; gap: 6px; }
.ai-msg--user { align-items: flex-end; }
.ai-msg--assistant { align-items: flex-start; }

.ai-msg-bubble {
  max-width: 88%;
  font-size: 13px;
  line-height: 1.45;
  padding: 8px 12px;
  border-radius: 12px;
  white-space: pre-wrap;
}
.ai-msg--user .ai-msg-bubble { background: #2563eb; color: white; }
.ai-msg--assistant .ai-msg-bubble { background: #f1f5f9; color: #0f172a; }
.ai-msg-bubble--loading { display: flex; align-items: center; }

.ai-apply-btn {
  font-size: 12px;
  font-weight: 600;
  color: #2563eb;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ai-apply-btn:hover { background: #dbeafe; }

.ai-error {
  font-size: 12px;
  color: #b91c1c;
  background: #fef2f2;
  padding: 8px 16px;
  flex-shrink: 0;
}

.ai-input-row {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.ai-input {
  flex: 1;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  outline: none;
}
.ai-input:focus { border-color: #93c5fd; }
</style>
