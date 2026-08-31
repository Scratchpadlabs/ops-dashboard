// READ-ONLY dump of every staff record's classIds/assignments for
// Hillgreen_Highschool, plus classes (id -> clazz/section) and subjects
// (id -> name) so the output is human-readable without a second lookup.
// Writes nothing. Prints JSON to stdout — redirect to a file.
//
// Usage:
//   node dump_hillgreen_staff.mjs > hillgreen_staff_dump.json

import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const SCHOOL_ID = 'Hillgreen_Highschool'

initializeApp({ credential: applicationDefault(), projectId: 'clarified-1501' })
const db = getFirestore()

async function main() {
  const schoolRef = db.collection('schools').doc(SCHOOL_ID)

  const [staffSnap, classSnap, subjectSnap] = await Promise.all([
    schoolRef.collection('staffs').get(),
    schoolRef.collection('classes').get(),
    schoolRef.collection('subjects').get(),
  ])

  const classes = {}
  classSnap.docs.forEach(d => {
    const c = d.data()
    classes[d.id] = { clazz: c.clazz, section: c.section }
  })

  const subjects = {}
  subjectSnap.docs.forEach(d => {
    subjects[d.id] = d.data().name || d.id
  })

  const staff = staffSnap.docs.map(d => {
    const s = d.data()
    return {
      id: d.id,
      name: s.name || '',
      email: s.email || '',
      type: s.type || '',
      classIds: s.classIds || [],
      assignments: s.assignments || {},
    }
  })

  console.log(JSON.stringify({ classes, subjects, staff }, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
