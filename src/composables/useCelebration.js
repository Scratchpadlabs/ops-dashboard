import { ref } from 'vue'

const isVisible = ref(false)
const celebrationMessage = ref('')
const celebrationEmoji = ref('🎉')
const celebrationEventType = ref('default')

export function useCelebration() {
  function celebrate(message, emoji = '🎉', eventType = 'default') {
    celebrationMessage.value = message
    celebrationEmoji.value = emoji
    celebrationEventType.value = eventType
    isVisible.value = true
    setTimeout(() => { isVisible.value = false }, 4000)
  }

  return { isVisible, celebrationMessage, celebrationEmoji, celebrationEventType, celebrate }
}
