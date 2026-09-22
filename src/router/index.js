import { createRouter, createWebHistory } from 'vue-router'
import { getAuth } from 'firebase/auth'

import { isOpsAdmin } from '../config/opsAdmins.js'

const routes = [
  { path: '/login',        component: () => import('../views/Login.vue'),        name: 'login', meta: { public: true } },
  { path: '/',              component: () => import('../views/Home.vue'),          name: 'home' },
  { path: '/tasks',         component: () => import('../views/Tasks.vue'),         name: 'tasks' },
  { path: '/tools',         component: () => import('../views/Tools.vue'),         name: 'tools' },
  { path: '/schools',       component: () => import('../views/Schools.vue'),       name: 'schools' },
  { path: '/schools/:id',   component: () => import('../views/SchoolProfile.vue'), name: 'school-profile' },
  { path: '/school-setup',  component: () => import('../views/SchoolSetup.vue'),   name: 'school-setup', meta: { opsAdminOnly: true } },
  { path: '/import',        component: () => import('../views/Import.vue'),        name: 'import', meta: { opsAdminOnly: true } },
  { path: '/surveys',       component: () => import('../views/Surveys.vue'),       name: 'surveys', meta: { opsAdminOnly: true } },
  { path: '/import/:jobId', component: () => import('../views/ImportReview.vue'),  name: 'import-review', meta: { opsAdminOnly: true } },
  { path: '/import-templates', component: () => import('../views/ImportTemplates.vue'), name: 'import-templates', meta: { opsAdminOnly: true } },
  { path: '/aap-remarks',   component: () => import('../views/AapRemarks.vue'),    name: 'aap-remarks', meta: { opsAdminOnly: true } },
  { path: '/smart-remarks', component: () => import('../views/SmartRemarks.vue'),  name: 'smart-remarks', meta: { opsAdminOnly: true } },
  { path: '/quotations',    component: () => import('../views/Quotations.vue'),    name: 'quotations' },
  { path: '/agreements',    component: () => import('../views/Agreements.vue'),    name: 'agreements' },
  { path: '/invoices',      component: () => import('../views/Invoices.vue'),      name: 'invoices' },
  { path: '/expenses',      component: () => import('../views/Expenses.vue'),      name: 'expenses', meta: { hiddenFromEmails: ['ruchika@ops.clarified.in'] } },
  { path: '/settings',      component: () => import('../views/Settings.vue'),      name: 'settings' },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

// Tracks the live auth state; `authReady` resolves once the initial state
// is known so the very first navigation doesn't race the auth SDK.
let currentUser = null
let resolveAuthReady
const authReady = new Promise((resolve) => { resolveAuthReady = resolve })

getAuth().onAuthStateChanged((user) => {
  currentUser = user
  resolveAuthReady()
})

router.beforeEach(async (to) => {
  await authReady
  const user = currentUser

  if (!to.meta.public && !user) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.name === 'login' && user) {
    return { path: '/' }
  }
  if (to.meta.opsAdminOnly && !isOpsAdmin(user?.email)) {
    return { name: 'home' }
  }
  if (to.meta.hiddenFromEmails?.includes(String(user?.email).trim().toLowerCase())) {
    return { name: 'home' }
  }
  return true
})
