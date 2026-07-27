import Papa from 'papaparse'

// Accepts comma or tab delimited — PapaParse auto-detects when delimiter is
// left unset, which is what lets pasting straight from Google Sheets work.
export function parseCsv(text) {
  const result = Papa.parse(text.trim(), { header: true, skipEmptyLines: true, transformHeader: h => h.trim() })
  return { rows: result.data, errors: result.errors }
}

export function toCsv(rows, columnKeys) {
  const data = rows.map(row => columnKeys.map(k => row[k] ?? ''))
  return Papa.unparse({ fields: columnKeys, data })
}

export function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Could not read the file'))
    reader.readAsText(file)
  })
}
