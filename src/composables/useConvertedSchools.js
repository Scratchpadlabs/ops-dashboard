import { ref } from 'vue'
import { getDocs, query, orderBy } from 'firebase/firestore'
import { opsCollection } from '../firebase/collections.js'

export function useConvertedSchools() {
  const convertedSchools = ref([])

  async function loadConverted() {
    try {
      const snap = await getDocs(query(opsCollection('schools'), orderBy('name')))
      convertedSchools.value = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.statuses?.includes('Converted'))
    } catch (e) {
      console.error('Could not load converted schools', e)
    }
  }

  return { convertedSchools, loadConverted }
}
