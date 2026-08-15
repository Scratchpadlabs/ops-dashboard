import {
  makeRemarkRowClassifier, groupRemarkRows, sampleRemarkRows, REMARK_CSV_COLUMNS,
} from '../src/utils/remarksImport.js'
let pass=0, fail=0
const ok=(name,cond,extra='')=>{ cond?pass++:fail++; console.log(`  ${cond?'ok  ':'FAIL'} ${name}${cond?'':'  <-- '+extra}`) }
const run=(rows,cats=[])=>{ const c=makeRemarkRowClassifier(cats); return rows.map((r,i)=>c(r,i)) }
const R=(o)=>({grade_band:'',category:'',category_order:'',remark_key:'',remark_order:'',text:'',type:'positive',...o})

console.log('=== doc id / band scoping ===')
let r=run([R({grade_band:'Foundational',category:'Discipline',text:'a',remark_key:'r1'})])
ok('band becomes the ID prefix', r[0].docId==='Foundational_Discipline', r[0].docId)
r=run([R({category:'Discipline',text:'a',remark_key:'r1'})])
ok('no band -> bare category id', r[0].docId==='Discipline', r[0].docId)
ok('no band is flagged', /applies to all grades/.test(r[0]._warning||''), r[0]._warning)
r=run([R({grade_band:'Middle',category:'Academic Effort',text:'a',remark_key:'r1'})])
ok('spaces slugified', r[0].docId==='Middle_Academic_Effort', r[0].docId)

console.log('=== the key invariant ===')
r=run([R({grade_band:'Foundational',category:'Discipline',text:'a',remark_key:'r1'}),
       R({grade_band:'Foundational',category:'Conduct',text:'b',remark_key:'r1'})])
ok('same key, two categories in one band -> ERROR', r[1]._status==='ERROR', JSON.stringify(r[1]._reason))
ok('   ...and the first row survives', r[0]._status==='CREATE')
r=run([R({grade_band:'F',category:'D',text:'a',remark_key:'r1'}),
       R({grade_band:'F',category:'D',text:'b',remark_key:'r1'})])
ok('same key twice in one category -> ERROR', r[1]._status==='ERROR', JSON.stringify(r[1]._reason))
const db=[{id:'Middle_Discipline',order:1,remarks:[{key:'middle_r7',text:'old',type:'positive',order:1}]}]
r=run([R({grade_band:'Middle',category:'Conduct',text:'a',remark_key:'r7'})], db)
ok('key owned by another category in DB -> ERROR', r[0]._status==='ERROR', JSON.stringify(r[0]._reason))
r=run([R({grade_band:'Middle',category:'Discipline',text:'new',remark_key:'r7'})], db)
ok('same key in its OWN category -> UPDATE, not error', r[0]._status==='UPDATE', r[0]._reason)
ok('   ...and says it replaces the text', /replaces the existing text/.test(r[0]._warning||''), r[0]._warning)
r=run([R({category:'Legacy',text:'x',remark_key:'r1'})], [{id:'Legacy',order:1,remarks:[{key:'r1',text:'old',type:'positive',order:1}]}])
ok('bandless import still matches legacy unprefixed keys', r[0]._status==='UPDATE' && /replaces the existing/.test(r[0]._warning||''), JSON.stringify([r[0]._status,r[0]._warning]))

console.log('=== band-prefixed keys (real Hillgreen bank reuses gr1 across bands) ===')
r=run([R({grade_band:'Foundational',category:'General Remarks',remark_key:'gr1',text:'Enjoys learning new things'}),
       R({grade_band:'Preparatory',category:'General Remarks',remark_key:'gr1',text:'Always submit work on time'}),
       R({grade_band:'Middle',category:'General Remarks',remark_key:'gr1',text:'Regular in submissions'})])
ok('same authored key in 3 bands -> no error', r.every(x=>x._status!=='ERROR'), JSON.stringify(r.map(x=>x._reason)))
ok('stored keys are distinct', new Set(r.map(x=>x.remark.key)).size===3, JSON.stringify(r.map(x=>x.remark.key)))
ok('prefix is the slugified band', r[0].remark.key==='foundational_gr1', r[0].remark.key)
ok('rewrite is disclosed on the row', /band prefixed/.test(r[0]._warning||''), r[0]._warning)
r=run([R({grade_band:'Foundational',category:'A',remark_key:'foundational_gr1',text:'x'})])
ok('already-prefixed key is not double-prefixed', r[0].remark.key==='foundational_gr1', r[0].remark.key)
r=run([R({category:'A',remark_key:'gr1',text:'x'})])
ok('no band -> key left exactly as authored', r[0].remark.key==='gr1', r[0].remark.key)
r=run([R({grade_band:'Foundational',category:'A',remark_key:'gr1',text:'x'}),
       R({grade_band:'Foundational',category:'B',remark_key:'gr1',text:'y'})])
ok('collision WITHIN one band is still rejected', r[1]._status==='ERROR', JSON.stringify(r[1]._reason))
const dbP=[{id:'Middle_General_Remarks',order:1,remarks:[{key:'middle_gr1',text:'old',type:'positive',order:1}]}]
r=run([R({grade_band:'Middle',category:'General Remarks',remark_key:'gr1',text:'new'})], dbP)
ok('re-import matches the stored prefixed key', r[0]._status==='UPDATE' && /replaces the existing text/.test(r[0]._warning||''), JSON.stringify([r[0]._status,r[0]._warning]))

console.log('=== auto key allocation ===')
r=run([R({grade_band:'F',category:'D',text:'a'}), R({grade_band:'F',category:'D',text:'b'})], db)
ok('auto keys continue past the DB max (r7)', r[0].remark.key==='f_r8'&&r[1].remark.key==='f_r9', r.map(x=>x.remark?.key).join(','))
r=run([R({grade_band:'F',category:'D',text:'a',remark_key:'r20'}), R({grade_band:'F',category:'D',text:'b'})])
ok('auto key skips past an explicit higher key', r[1].remark.key==='f_r21', r[1].remark?.key)

console.log('=== validation ===')
ok('missing category', run([R({text:'a'})])[0]._reason==='Missing category')
ok('missing text', run([R({category:'D'})])[0]._reason==='Missing text')
ok('bad type', /type must be/.test(run([R({category:'D',text:'a',type:'good'})])[0]._reason))
ok('type is case-insensitive', run([R({category:'D',text:'a',type:'Positive',remark_key:'r1'})])[0]._status==='CREATE')
ok('bad category_order', /category_order/.test(run([R({category:'D',text:'a',category_order:'x'})])[0]._reason))
ok('bad remark_order', /remark_order/.test(run([R({category:'D',text:'a',remark_order:'0'})])[0]._reason))

console.log('=== grouping / merge-by-key ===')
const rows=run([
  R({grade_band:'Foundational',category:'Discipline',category_order:'1',remark_key:'r1',remark_order:'2',text:'second',type:'positive'}),
  R({grade_band:'Foundational',category:'Discipline',category_order:'1',remark_key:'r2',remark_order:'1',text:'first',type:'negative'}),
  R({grade_band:'Middle',category:'Discipline',category_order:'2',remark_key:'r3',remark_order:'1',text:'m',type:'positive'}),
])
const g=groupRemarkRows(rows.filter(x=>x._status!=='ERROR'), [])
ok('one doc per (band, category)', g.length===2, JSON.stringify(g.map(x=>x.docId)))
const found=g.find(x=>x.docId==='Foundational_Discipline')
ok('rows grouped into one remarks array', found.remarks.length===2)
ok('remark_order respected', found.remarks[0].key==='foundational_r2'&&found.remarks[1].key==='foundational_r1', JSON.stringify(found.remarks.map(x=>x.key)))
ok('order renumbered 1..n', found.remarks.every((x,i)=>x.order===i+1))
ok('category_order used as doc order', found.order===1, found.order)

const db2=[{id:'Middle_Discipline',order:5,remarks:[
  {key:'middle_r7',text:'keep me',type:'positive',order:1},{key:'middle_r8',text:'old text',type:'positive',order:2}]}]
const rows2=run([R({grade_band:'Middle',category:'Discipline',remark_key:'r8',text:'new text',type:'negative',remark_order:'1'})], db2)
const g2=groupRemarkRows(rows2.filter(x=>x._status!=='ERROR'), db2)[0]
ok('untouched existing remark is KEPT', g2.remarks.some(x=>x.key==='middle_r7'&&x.text==='keep me'), JSON.stringify(g2.remarks))
ok('mentioned remark is REPLACED', g2.remarks.find(x=>x.key==='middle_r8').text==='new text')
ok('replaced remark keeps its key', g2.remarks.filter(x=>x.key==='middle_r8').length===1)
ok('existing doc order preserved when file omits it', g2.order===5, g2.order)

console.log('=== class_ids scoping ===')
const CLASSES=['III_A','III_B','IV_A']
const runC=(rows,cats=[])=>{ const c=makeRemarkRowClassifier(cats,CLASSES); return rows.map((r,i)=>c(r,i)) }
const groupOf=(rows,cats=[])=>groupRemarkRows(rows.filter(x=>x._status!=='ERROR'),cats)[0]

let c=runC([R({category:'Discipline',text:'a',remark_key:'r1',class_ids:'III_A; III_B'})])
ok('ids parsed off a semicolon list', c[0]._status!=='ERROR', JSON.stringify(c[0]._reason))
ok('   ...and reach the group', JSON.stringify(groupOf(c).classIds)==='["III_A","III_B"]', JSON.stringify(groupOf(c).classIds))

c=runC([R({category:'Discipline',text:'a',remark_key:'r1',class_ids:'III_A,IV_A|III_B'})])
ok('comma and pipe separate too', JSON.stringify(groupOf(c).classIds)==='["III_A","IV_A","III_B"]', JSON.stringify(groupOf(c).classIds))

c=runC([R({category:'Discipline',text:'a',remark_key:'r1',class_ids:''})])
ok('blank does NOT write classIds at all', !('classIds' in groupOf(c)), JSON.stringify(groupOf(c).classIds))

c=runC([R({category:'Discipline',text:'a',remark_key:'r1',class_ids:'all'})])
ok('"all" writes an empty array (widen to every class)',
  'classIds' in groupOf(c) && groupOf(c).classIds.length===0, JSON.stringify(groupOf(c).classIds))
ok('   ...and says so on the row', /widened to every class/.test(c[0]._warning||''), c[0]._warning)

c=runC([R({category:'Discipline',text:'a',remark_key:'r1',class_ids:'III_C'})])
ok('an unknown class id is an ERROR, not a silent scope-to-nobody',
  c[0]._status==='ERROR'&&/not a class/.test(c[0]._reason), JSON.stringify(c[0]._reason))
ok('   ...naming the offending value', /III_C/.test(c[0]._reason||''), c[0]._reason)

// Without a known-class list (caller could not load them) the check is skipped
// rather than rejecting everything.
const cNoList=makeRemarkRowClassifier([])
ok('unvalidated when the class list is unknown',
  cNoList(R({category:'D',text:'a',remark_key:'r1',class_ids:'ANYTHING'}),0)._status!=='ERROR')

c=runC([R({category:'Discipline',text:'a',remark_key:'r1',class_ids:'III_A'}),
        R({category:'Discipline',text:'b',remark_key:'r2',class_ids:'III_B'})])
ok('rows of one category disagreeing -> union', JSON.stringify(groupOf(c).classIds)==='["III_A","III_B"]', JSON.stringify(groupOf(c).classIds))
ok('   ...and the disagreement is flagged', /differs from an earlier row/.test(c[1]._warning||''), c[1]._warning)

c=runC([R({category:'Discipline',text:'a',remark_key:'r1',class_ids:'III_A'}),
        R({category:'Discipline',text:'b',remark_key:'r2',class_ids:''})])
ok('a blank row does not widen a category its siblings scoped',
  JSON.stringify(groupOf(c).classIds)==='["III_A"]', JSON.stringify(groupOf(c).classIds))

c=runC([R({category:'Discipline',text:'a',remark_key:'r1',class_ids:'III_A'}),
        R({category:'Discipline',text:'b',remark_key:'r2',class_ids:'all'})])
ok('"all" anywhere in the group wins outright', groupOf(c).classIds.length===0, JSON.stringify(groupOf(c).classIds))

c=runC([R({grade_band:'Foundational',category:'Discipline',text:'a',remark_key:'r1',class_ids:'III_A'}),
        R({grade_band:'Middle',category:'Discipline',text:'b',remark_key:'r2',class_ids:'IV_A'})])
const both=groupRemarkRows(c.filter(x=>x._status!=='ERROR'),[])
ok('scope stays with its own category doc',
  both.find(x=>x.docId==='Foundational_Discipline').classIds[0]==='III_A'
  && both.find(x=>x.docId==='Middle_Discipline').classIds[0]==='IV_A',
  JSON.stringify(both.map(x=>[x.docId,x.classIds])))

console.log('=== sample CSV stays importable ===')
const sample=sampleRemarkRows()
const sampleRows=(() => { const cl=makeRemarkRowClassifier([],['III_A','III_B']); return sample.map((r,i)=>cl(r,i)) })()
ok('every sample row classifies without error',
  sampleRows.every(r=>r._status!=='ERROR'), JSON.stringify(sampleRows.filter(r=>r._status==='ERROR').map(r=>r._reason)))
ok('sample demonstrates all three class_ids states',
  sample.some(r=>r.class_ids==='') && sample.some(r=>r.class_ids==='all') && sample.some(r=>/III_A/.test(r.class_ids)))
ok('class_ids is a declared column', REMARK_CSV_COLUMNS.includes('class_ids'), JSON.stringify(REMARK_CSV_COLUMNS))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail?1:0)
