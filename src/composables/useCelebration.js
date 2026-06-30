import { ref } from 'vue'

const isVisible = ref(false)
const celebrationMessage = ref('')
const celebrationEmoji = ref('🎉')

export function useCelebration() {
  function celebrate(message, emoji = '🎉') {
    celebrationMessage.value = message
    celebrationEmoji.value = emoji
    isVisible.value = true
    setTimeout(() => { isVisible.value = false }, 4000)
  }

  return { isVisible, celebrationMessage, celebrationEmoji, celebrate }
}
