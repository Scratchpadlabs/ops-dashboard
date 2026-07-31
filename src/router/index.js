import { createRouter, createWebHistory } from 'vue-router'
import { getAuth } from 'firebase/auth'

import Home from '../views/Home.vue'
import Tasks from '../views/Tasks.vue'
import Tools from '../views/Tools.vue'
import Schools from '../views/Schools.vue'
import SchoolProfile from '../views/SchoolProfile.vue'
import SchoolSetup from '../views/SchoolSetup.vue'
import Import from '../views/Import.vue'
import ImportReview from '../views/ImportReview.vue'
import Intake from '../views/Intake.vue'
import Quotations from '../views/Quotations.vue'
import Agreements from '../views/Agreements.vue'
import Invoices from '../views/Invoices.vue'
import Expenses from '../views/Expenses.vue'
import Settings from '../views/Settings.vue'
import Login from '../views/Login.vue'
import { isOpsAdmin } from '../config/opsAdmins.js'

const routes = [
  { path: '/login',        component: Login,        name: 'login', meta: { public: true } },
  { path: '/',              component: Home,          name: 'home' },
  { path: '/tasks',         component: Tasks,         name: 'tasks' },
  { path: '/tools',         component: Tools,         name: 'tools' },
  { path: '/schools',       component: Schools,       name: 'schools' },
  { path: '/schools/:id',   component: SchoolProfile, name: 'school-profile' },
  { path: '/school-setup',  component: SchoolSetup,   name: 'school-setup', meta: { opsAdminOnly: true } },
  { path: '/import',        component: Import,        name: 'import', meta: { opsAdminOnly: true } },
  { path: '/import/:jobId', component: ImportReview,  name: 'import-review', meta: { opsAdminOnly: true } },
  { path: '/intake',        component: Intake,        name: 'intake', meta: { opsAdminOnly: true } },
  { path: '/quotations',    component: Quotations,    name: 'quotations' },
  { path: '/agreements',    component: Agreements,    name: 'agreements' },
  { path: '/invoices',      component: Invoices,      name: 'invoices' },
  { path: '/expenses',      component: Expenses,      name: 'expenses' },
  { path: '/settings',      component: Settings,      name: 'settings' },
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
  return true
})
