import { makeRemarkRowClassifier, groupRemarkRows } from '../src/utils/remarksImport.js'
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
       R({grade_band:'Middle',category:'Discipline',text:'b',remark_key:'r1'})])
ok('same key, two categories in file -> ERROR', r[1]._status==='ERROR', JSON.stringify(r[1]._reason))
ok('   ...and the first row survives', r[0]._status==='CREATE')
r=run([R({grade_band:'F',category:'D',text:'a',remark_key:'r1'}),
       R({grade_band:'F',category:'D',text:'b',remark_key:'r1'})])
ok('same key twice in one category -> ERROR', r[1]._status==='ERROR', JSON.stringify(r[1]._reason))
const db=[{id:'Middle_Discipline',order:1,remarks:[{key:'r7',text:'old',type:'positive',order:1}]}]
r=run([R({grade_band:'Foundational',category:'Discipline',text:'a',remark_key:'r7'})], db)
ok('key owned by another category in DB -> ERROR', r[0]._status==='ERROR', JSON.stringify(r[0]._reason))
r=run([R({grade_band:'Middle',category:'Discipline',text:'new',remark_key:'r7'})], db)
ok('same key in its OWN category -> UPDATE, not error', r[0]._status==='UPDATE', r[0]._reason)
ok('   ...and says it replaces the text', /replaces the existing text/.test(r[0]._warning||''), r[0]._warning)

console.log('=== auto key allocation ===')
r=run([R({grade_band:'F',category:'D',text:'a'}), R({grade_band:'F',category:'D',text:'b'})], db)
ok('auto keys continue past the DB max (r7)', r[0].remark.key==='r8'&&r[1].remark.key==='r9', r.map(x=>x.remark?.key).join(','))
r=run([R({grade_band:'F',category:'D',text:'a',remark_key:'r20'}), R({grade_band:'F',category:'D',text:'b'})])
ok('auto key skips past an explicit higher key', r[1].remark.key==='r21', r[1].remark?.key)

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
ok('remark_order respected', found.remarks[0].key==='r2'&&found.remarks[1].key==='r1', JSON.stringify(found.remarks.map(x=>x.key)))
ok('order renumbered 1..n', found.remarks.every((x,i)=>x.order===i+1))
ok('category_order used as doc order', found.order===1, found.order)

const db2=[{id:'Middle_Discipline',order:5,remarks:[
  {key:'r7',text:'keep me',type:'positive',order:1},{key:'r8',text:'old text',type:'positive',order:2}]}]
const rows2=run([R({grade_band:'Middle',category:'Discipline',remark_key:'r8',text:'new text',type:'negative',remark_order:'1'})], db2)
const g2=groupRemarkRows(rows2.filter(x=>x._status!=='ERROR'), db2)[0]
ok('untouched existing remark is KEPT', g2.remarks.some(x=>x.key==='r7'&&x.text==='keep me'), JSON.stringify(g2.remarks))
ok('mentioned remark is REPLACED', g2.remarks.find(x=>x.key==='r8').text==='new text')
ok('replaced remark keeps its key', g2.remarks.filter(x=>x.key==='r8').length===1)
ok('existing doc order preserved when file omits it', g2.order===5, g2.order)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail?1:0)
