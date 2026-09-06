import { ref } from 'vue'

// Same singleton-ref idiom as useGlobalSearch's isSearchOpen — the header
// button in App.vue and AiAssistantPanel.vue share this one instance.
export const isAiAssistantOpen = ref(false)
