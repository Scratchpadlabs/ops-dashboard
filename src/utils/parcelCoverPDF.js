import jsPDF from 'jspdf'

// ─── Geometry ─────────────────────────────────────────────────────────────────
// The artwork is 1640 x 924 px. The PDF page matches that aspect ratio exactly
// so the label prints without letterboxing — print at 100% / actual size (not
// "fit to page") and it comes out 200 mm wide.
export const ART_W_PX = 1640
export const ART_H_PX = 924

export const LEFT_X_PX       = 80     // left edge of the "To" block
export const FIRST_BASE_Y_PX = 118    // baseline of the word "To,"
export const LINE_GAP_PX     = 57.5   // baseline-to-baseline spacing
export const MAX_TEXT_W_PX   = 870    // keeps text clear of the green curve
export const FONT_PX         = 37     // visual size in artwork pixels

const PAGE_W   = 200                          // mm
const PX_TO_MM = PAGE_W / ART_W_PX
const PAGE_H   = ART_H_PX * PX_TO_MM          // 112.68 mm
const FONT_PT  = (FONT_PX * PX_TO_MM) / 0.352778

export const TEMPLATE_URL = '/parcel_cover_template.png'

/**
 * Build the list of rendered lines. Used by BOTH the on-screen preview and the
 * PDF so what you see is exactly what prints.
 * @returns {{text: string, bold: boolean}[]}
 */
export function layoutLines(d) {
  const lines = [{ text: 'To,', bold: true }]

  if (d.receiverName?.trim()) {
    lines.push({ text: d.receiverName.trim().replace(/,+$/, '') + ',', bold: true })
  }

  if (d.address?.trim()) {
    // A throwaway doc gives us jsPDF's own wrapping, so preview and print agree.
    const measure = new jsPDF({ unit: 'mm', format: [PAGE_W, PAGE_H] })
    measure.setFont('helvetica', 'normal')
    measure.setFontSize(FONT_PT)
    measure
      .splitTextToSize(d.address.trim().replace(/\s*\n\s*/g, ' '), MAX_TEXT_W_PX * PX_TO_MM)
      .forEach(text => lines.push({ text, bold: false }))
  }

  if (d.pincode?.trim())  lines.push({ text: `Pin code: ${d.pincode.trim()}`, bold: false })
  if (d.phone?.trim())    lines.push({ text: `Phone No: ${d.phone.trim()}`, bold: false })
  if (d.altPhone?.trim()) lines.push({ text: `Alt. Phone: ${d.altPhone.trim()}`, bold: false })

  return lines
}

async function loadTemplate() {
  const res = await fetch(TEMPLATE_URL)
  if (!res.ok) throw new Error('Could not load the parcel cover template')
  const blob = await res.blob()
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Could not read the template image'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Build the parcel cover PDF.
 * @param {{receiverName?:string, address?:string, pincode?:string, phone?:string, altPhone?:string}} d
 * @returns {Promise<jsPDF>}
 */
export async function buildParcelCoverPDF(d) {
  const doc = new jsPDF({ unit: 'mm', format: [PAGE_W, PAGE_H], orientation: 'landscape' })

  doc.addImage(await loadTemplate(), 'PNG', 0, 0, PAGE_W, PAGE_H)

  doc.setTextColor(45, 45, 45)
  doc.setFontSize(FONT_PT)

  layoutLines(d).forEach((line, i) => {
    doc.setFont('helvetica', line.bold ? 'bold' : 'normal')
    doc.text(line.text, LEFT_X_PX * PX_TO_MM, (FIRST_BASE_Y_PX + i * LINE_GAP_PX) * PX_TO_MM)
  })

  return doc
}

export function parcelCoverFilename(receiverName, schoolName) {
  const base = (schoolName || receiverName || 'Parcel_Cover').trim()
  return `Parcel_Cover_${base.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}.pdf`
}
