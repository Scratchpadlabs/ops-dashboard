/**
 * Client for the provision_hosting Cloud Functions.
 *
 * Kept out of utils/api.js on purpose. Those endpoints are
 * --allow-unauthenticated with a shared X-Api-Key, which is fine for rendering a
 * PDF from data the caller already has. These create Hosting sites, edit
 * the DNS of a live domain and trigger deploys, so they are deployed
 * authenticated and send the signed-in user's Firebase ID token instead. Mixing
 * the two auth models in one module invites copying the wrong one.
 */
import { auth } from '../firebase/config'

const BASE = 'https://asia-south1-clarified-1501.cloudfunctions.net'

const URLS = {
  preview: `${BASE}/hosting_preview`,
  provision: `${BASE}/hosting_provision`,
  status: `${BASE}/hosting_status`,
  sites: `${BASE}/hosting_sites`,
}

async function call(url, payload) {
  const user = auth.currentUser
  if (!user) throw new Error('Not signed in')
  const token = await user.getIdToken()

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload || {}),
  })

  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { error: text }
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
  return body
}

/** What provisioning would do, computed against live state. Writes nothing. */
export const previewHosting = (payload) => call(URLS.preview, payload)

/** Create site + domain + DNS, then dispatch the build. Idempotent per school. */
export const provisionHosting = (payload) => call(URLS.provision, payload)

/** Poll a run. Safe on an interval. */
export const hostingStatus = (runId) => call(URLS.status, { runId })

/** Every Hosting site with its domains and the school it belongs to. */
export const listHostingSites = () => call(URLS.sites, {}).then(r => r.sites || [])

/** Set which school a site belongs to; '' marks it as no school's. */
export const assignHostingSite = (siteId, schoolId) => call(URLS.sites, { action: 'assign', siteId, schoolId })

/**
 * Mirror of slugify_site_id() in functions/provision_hosting/main.py, so the UI
 * can show the site id before the first call. The server recomputes it — this is
 * a preview, never the source of truth.
 */
export function suggestSiteId(schoolId) {
  if (!schoolId) return ''
  let slug = String(schoolId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  slug = slug.replace(/-{2,}/g, '-').slice(0, 30).replace(/^-+|-+$/g, '')
  if (slug.length < 6) slug = `${slug}-school`.slice(0, 30).replace(/^-+|-+$/g, '')
  return slug
}
