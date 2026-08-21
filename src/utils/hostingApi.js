/**
 * Client for the provision_hosting Cloud Functions.
 *
 * Kept out of utils/api.js on purpose. Those endpoints are
 * --allow-unauthenticated with a shared X-Api-Key, which is fine for rendering a
 * PDF from data the caller already has. These three create Hosting sites, edit
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
}

async function call(url, payload) {
  const user = auth.currentUser
  if (!user) throw new Error('Not signed in')
  const token = await user.getIdToken()

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload || {}),
    })
  } catch (e) {
    // fetch() rejects with a bare "Failed to fetch" for every network-layer
    // failure, and a blocked CORS preflight is one of them. The distinguishing
    // detail — that the preflight came back without an
    // Access-Control-Allow-Origin header — is only in the console, so the UI
    // showed a two-word error with nowhere to go. The overwhelmingly common
    // cause is the function being deployed with IAM auth required, which
    // rejects the browser's anonymous OPTIONS request before the function
    // runs; see functions/provision_hosting/README.md.
    throw new Error(
      `Could not reach ${url.split('/').pop()}. This is a network or CORS-preflight ` +
        'failure, not a rejection by the function — check that the function is deployed, ' +
        'is deployed with --allow-unauthenticated, and that this origin is in its ' +
        `cors_origins allowlist. (${e.message})`,
    )
  }

  const text = await res.text()
  let body
  let parsed = true
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    parsed = false
    body = { error: text }
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
  // A 200 whose body is not JSON is a broken endpoint, not a result. Swallowing
  // it is how a function returning a malformed body reached the UI as an empty
  // plan with no error shown anywhere.
  if (!parsed) {
    throw new Error(
      `${url.split('/').pop()} returned ${res.status} with a non-JSON body: ${text.slice(0, 200)}`,
    )
  }
  return body
}

/** What provisioning would do, computed against live state. Writes nothing. */
export const previewHosting = (payload) => call(URLS.preview, payload)

/** Create site + domain + DNS, then dispatch the build. Idempotent per school. */
export const provisionHosting = (payload) => call(URLS.provision, payload)

/** Poll a run. Safe on an interval. */
export const hostingStatus = (runId) => call(URLS.status, { runId })

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
