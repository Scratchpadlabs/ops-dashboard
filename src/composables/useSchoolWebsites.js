/**
 * Which website each school has been given — read from the live Firebase
 * Hosting sites through hosting_sites (functions/provision_hosting), which also
 * decides each site's school (see site_registry.py there).
 *
 * Module-level state: School Setup's header and the Tools → School Websites
 * page share one fetch, since listing every site's domains takes a few seconds.
 */
import { ref } from 'vue'
import { listHostingSites, assignHostingSite } from '../utils/hostingApi.js'

const sites = ref([])
const loaded = ref(false)
const loading = ref(false)
const error = ref('')
let inflight = null

/** The address to show for a site: a live custom domain, else any custom
 *  domain (still being set up), else the free *.web.app one. */
export function primaryUrl(site) {
  const d = site.domains?.[0]
  return d ? `https://${d.domain}` : site.defaultUrl
}

export function useSchoolWebsites() {
  async function load(force = false) {
    if (inflight) return inflight
    if (loaded.value && !force) return
    loading.value = true
    error.value = ''
    inflight = listHostingSites()
      .then(list => { sites.value = list; loaded.value = true })
      .catch(e => { error.value = e.message || 'Could not load websites' })
      .finally(() => { loading.value = false; inflight = null })
    return inflight
  }

  /** Sites belonging to one school (a school can have more than one). */
  function sitesFor(schoolId) {
    return schoolId ? sites.value.filter(s => s.schoolId === schoolId) : []
  }

  async function assign(siteId, schoolId) {
    await assignHostingSite(siteId, schoolId)
    // Keep the shared list in step without refetching every domain.
    sites.value = sites.value.map(s => s.siteId === siteId ? { ...s, schoolId, source: 'assigned' } : s)
  }

  return { sites, loaded, loading, error, load, sitesFor, assign }
}
