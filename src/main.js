import { createApp } from 'vue'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import ToastService from 'primevue/toastservice'
import ConfirmationService from 'primevue/confirmationservice'
import Tooltip from 'primevue/tooltip'
import 'primeicons/primeicons.css'
import { getAuth, onAuthStateChanged } from 'firebase/auth'

import './style.css'
import App from './App.vue'
import { router } from './router'
import './firebase/config'

function mountApp() {
  const app = createApp(App)

  app.use(router)
  app.use(PrimeVue, {
    theme: {
      preset: Aura,
      options: {
        darkModeSelector: false,
      }
    }
  })
  app.use(ToastService)
  app.use(ConfirmationService)
  app.directive('tooltip', Tooltip)

  app.mount('#app')
}

const unsubscribe = onAuthStateChanged(getAuth(), () => {
  unsubscribe()
  mountApp()
})
