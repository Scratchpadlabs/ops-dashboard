import { ref } from 'vue'
import { getDocs, query, orderBy } from 'firebase/firestore'
import { opsCollection } from '../firebase/collections.js'

export function useAllSchools() {
  const allSchools = ref([])

  async function loadAllSchools() {
    try {
      const snap = await getDocs(query(opsCollection('schools'), orderBy('name')))
      allSchools.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    } catch (e) {
      console.error('Could not load schools', e)
    }
  }

  return { allSchools, loadAllSchools }
}
