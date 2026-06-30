import { createRouter, createWebHistory } from 'vue-router'

import Dashboard from '../views/Dashboard.vue'
import Schools from '../views/Schools.vue'
import Quotations from '../views/Quotations.vue'
import Agreements from '../views/Agreements.vue'
import Invoices from '../views/Invoices.vue'

const routes = [
  { path: '/',            component: Dashboard,   name: 'dashboard' },
  { path: '/schools',     component: Schools,     name: 'schools' },
  { path: '/quotations',  component: Quotations,  name: 'quotations' },
  { path: '/agreements',  component: Agreements,  name: 'agreements' },
  { path: '/invoices',    component: Invoices,    name: 'invoices' },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
