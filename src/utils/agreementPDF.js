import jsPDF from 'jspdf'

const COMPANY = {
  name:       'Scratchpad Labs Pvt Ltd',
  address:    'SCEI, Sus, Pune - 411021',
  regOffice:  'Karmanghat, Saroornagar, Hyderabad, Telangana - 500079',
}

const BLACK = [15, 15, 15]
const GRAY  = [90, 90, 90]
const LGRAY = [180, 180, 180]
const WHITE = [255, 255, 255]
const BLUE  = [30, 58, 138]
const LBLUE = [235, 240, 255]

function sf(doc, style = 'normal', size = 10) {
  doc.setFontSize(size)
  doc.setFont('helvetica', style)
}
function rgb(doc, ...c) { doc.setTextColor(...c) }
function fill(doc, ...c) { doc.setFillColor(...c) }
function draw(doc, ...c) { doc.setDrawColor(...c) }

// Wraps text and returns new Y
function para(doc, text, x, y, maxW, lineH = 13, indent = 0) {
  const lines = doc.splitTextToSize(text, maxW - indent)
  doc.text(lines, x + indent, y)
  return y + lines.length * lineH
}

// Bullet point
function bullet(doc, text, x, y, maxW) {
  sf(doc, 'normal', 9)
  rgb(doc, ...BLACK)
  const lines = doc.splitTextToSize(text, maxW - 12)
  doc.text('•', x + 2, y)
  doc.text(lines, x + 12, y)
  return y + lines.length * 13 + 2
}

// Section heading
function heading(doc, text, x, y, maxW) {
  fill(doc, ...LBLUE)
  doc.rect(x, y - 9, maxW, 16, 'F')
  sf(doc, 'bold', 9.5)
  rgb(doc, ...BLUE)
  doc.text(text, x + 6, y + 2)
  return y + 14
}

// Divider
function divider(doc, x, y, w) {
  draw(doc, ...LGRAY)
  doc.setLineWidth(0.4)
  doc.line(x, y, x + w, y)
  return y + 8
}

// Page footer
function footer(doc, pageNum, totalPages, aNum) {
  const W = 595.5
  fill(doc, 245, 247, 252)
  doc.rect(0, 818, W, 24, 'F')
  sf(doc, 'normal', 7.5)
  rgb(doc, ...GRAY)
  doc.text('Scratchpad Labs Pvt Ltd  ·  Confidential', 40, 833)
  doc.text(`Ref: ${aNum}`, W / 2, 833, { align: 'center' })
  doc.text(`Page ${pageNum} of ${totalPages}`, W - 40, 833, { align: 'right' })
}

export function generateAgreementPDF(a) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W   = 595.5
  const M   = 48
  const CW  = W - M * 2

  // ── PAGE 1 ────────────────────────────────────────────────────────────────

  // Header bar
  fill(doc, ...BLUE)
  doc.rect(0, 0, W, 62, 'F')

  sf(doc, 'bold', 17)
  rgb(doc, ...WHITE)
  doc.text('ClarifiEd', M, 26)
  sf(doc, 'normal', 7.5)
  rgb(doc, 180, 205, 255)
  doc.text('By Scratchpad Labs', M, 38)

  sf(doc, 'bold', 10.5)
  rgb(doc, ...WHITE)
  doc.text('AGREEMENT FOR THE PROVISION OF HOLISTIC PROGRESS CARD SERVICES', W - M, 28, { align: 'right' })
  sf(doc, 'normal', 8)
  rgb(doc, 180, 205, 255)
  doc.text(`Ref: ${a.agreement_number}`, W - M, 42, { align: 'right' })

  let y = 84

  // Parties intro
  sf(doc, 'normal', 9)
  rgb(doc, ...BLACK)
  y = para(doc,
    `${COMPANY.name}, a company incorporated under the Companies Act, 2013 and having its principal place of business at ${COMPANY.address}, and registered office at ${COMPANY.regOffice} (hereinafter referred to as the "Company," which expression shall, unless repugnant to the context or meaning thereof, include its successors and assigns);`,
    M, y, CW)

  y += 8
  sf(doc, 'bold', 9)
  doc.text('And', M, y)
  y += 14

  sf(doc, 'normal', 9)
  y = para(doc,
    `${a.school_name}, an educational institution located at ${a.school_address || '[Address]'} and represented herein by its authorised signatory, ${a.signatory_name}${a.signatory_designation ? ', ' + a.signatory_designation : ''} (hereinafter referred to as the "School," which expression shall, unless repugnant to the context or meaning thereof, include its successors and permitted assigns).`,
    M, y, CW)

  y += 6
  sf(doc, 'normal', 8.5)
  rgb(doc, ...GRAY)
  y = para(doc, 'The Company and the School shall collectively be referred to as the "Parties" and individually as a "Party."', M, y, CW)

  y += 6
  rgb(doc, ...BLACK)
  sf(doc, 'normal', 9)
  y = para(doc, 'WHEREAS: The Company is engaged in the business of developing and delivering customised academic progress reporting systems, including Holistic Progress Cards (HPC);', M, y, CW)
  y += 4
  y = para(doc, 'AND WHEREAS: The School is desirous of availing the services of the Company for the development and provision of Holistic Progress Cards for its students;', M, y, CW)
  y += 4
  y = para(doc, 'NOW, THEREFORE, in consideration of the mutual promises and covenants contained herein, the Parties agree as follows:', M, y, CW)

  y += 10
  y = divider(doc, M, y, CW)

  // ── SCOPE OF SERVICES ─────────────────────────────────────────────────────
  y = heading(doc, '1.  SCOPE OF SERVICES', M, y, CW)
  y += 4

  sf(doc, 'bold', 9)
  rgb(doc, ...BLACK)
  doc.text('Service Delivery:', M, y)
  sf(doc, 'normal', 9)
  y = para(doc,
    'Subject to timely receipt of accurate and complete Supporting Data from the School, the Company shall generate and deliver the ' + (a.hpc_type || 'printed and digital') + ' HPC. The Company shall customise the HPCs to align with the specific requirements of the School.',
    M, y + 13, CW)

  y += 4
  sf(doc, 'bold', 9)
  doc.text('Deliverables:', M, y)
  y += 13
  sf(doc, 'normal', 9)
  y = bullet(doc, 'One HPC per student as per the selected package (' + (a.hpc_type || 'printed and digital') + ').', M, y, CW)
  y = bullet(doc, 'Standard package includes: SEW reports, academic rubrics, "All About Me" section, QR-linked digital access.', M, y, CW)

  y += 4
  sf(doc, 'bold', 9)
  doc.text('Sample Approval:', M, y)
  sf(doc, 'normal', 9)
  y = para(doc, 'Prior to mass printing, a sample copy shall be submitted to the School\'s Principal for written approval via email. No mass printing shall be initiated without such written approval.', M, y + 13, CW)

  y += 8
  y = divider(doc, M, y, CW)

  // ── COMMERCIAL TERMS ──────────────────────────────────────────────────────
  y = heading(doc, '2.  COMMERCIAL TERMS', M, y, CW)
  y += 6

  // Pricing box
  const totalAmt = a.fee_per_student * a.student_count
  const splits   = getInstallmentSplits(a.installment_plan)

  fill(doc, 244, 247, 255)
  draw(doc, 180, 195, 230)
  doc.setLineWidth(0.5)
  doc.roundedRect(M, y, CW, 60, 4, 4, 'FD')

  // Left: fee
  sf(doc, 'bold', 8.5)
  rgb(doc, ...BLUE)
  doc.text('Fee per Student', M + 12, y + 16)
  sf(doc, 'bold', 22)
  rgb(doc, ...BLACK)
  doc.text(`Rs. ${a.fee_per_student}/-`, M + 12, y + 40)
  sf(doc, 'normal', 7.5)
  rgb(doc, ...GRAY)
  doc.text('(inclusive of all taxes)', M + 12, y + 52)

  // Right: installments
  sf(doc, 'bold', 8.5)
  rgb(doc, ...BLUE)
  doc.text('Payment Schedule', M + 210, y + 16)
  sf(doc, 'normal', 8.5)
  rgb(doc, ...BLACK)
  splits.forEach((pct, i) => {
    const amt = Math.round(totalAmt * pct / 100)
    doc.text(
      `Installment ${i + 1}: ${pct}%  —  Rs. ${amt.toLocaleString('en-IN')}/-`,
      M + 210, y + 28 + i * 12
    )
  })

  y += 70

  sf(doc, 'normal', 9)
  rgb(doc, ...BLACK)
  y = bullet(doc, `The fee per student shall be Rs. ${a.fee_per_student}/- (inclusive of all taxes). The total fee is based on approximately ${a.student_count} students.`, M, y, CW)
  y = bullet(doc, 'All payments shall be due and payable within forty-five (45) working days of invoice and shall be non-refundable unless otherwise agreed.', M, y, CW)
  y = bullet(doc, 'Failure to make timely payments shall entitle the Company to suspend services without further notice. As a registered MSME under Udyam, compound interest at three times the RBI bank rate applies on delayed payments per Section 16 of the MSMED Act, 2006.', M, y, CW)
  y = bullet(doc, 'Students added post-contract shall be invoiced separately based on the agreed per-student rate.', M, y, CW)

  y += 6
  y = divider(doc, M, y, CW)

  // ── DATA RESPONSIBILITIES ─────────────────────────────────────────────────
  y = heading(doc, '3.  DATA RESPONSIBILITIES', M, y, CW)
  y += 4
  sf(doc, 'normal', 9)
  rgb(doc, ...BLACK)
  y = bullet(doc, 'The School warrants that all data provided shall be true, complete, and duly verified by its internal team.', M, y, CW)
  y = bullet(doc, 'The Company shall not be liable for errors or delays resulting from incorrect, incomplete, or inconsistent data supplied by the School.', M, y, CW)

  y += 6
  y = divider(doc, M, y, CW)

  // ── REPRINT & CORRECTION ──────────────────────────────────────────────────
  y = heading(doc, '4.  REPRINT & CORRECTION POLICY', M, y, CW)
  y += 4
  sf(doc, 'normal', 9)
  rgb(doc, ...BLACK)
  y = bullet(doc, 'If errors are made by the Company (despite correct data submitted), the Company shall bear full responsibility and reprint affected cards at no additional cost.', M, y, CW)
  y = bullet(doc, 'If errors are due to incorrect, incomplete, or delayed data from the School, or changes requested after final sample approval, reprints shall be chargeable at Rs. 100/- per copy minimum.', M, y, CW)
  y = bullet(doc, 'All correction requests must be submitted in writing within thirty (30) calendar days from the date of delivery.', M, y, CW)

  // ── PAGE 2 ────────────────────────────────────────────────────────────────
  doc.addPage()
  y = 48

  // ── POST-DELIVERY SUPPORT ─────────────────────────────────────────────────
  y = heading(doc, '5.  POST-DELIVERY SUPPORT', M, y, CW)
  y += 4
  sf(doc, 'normal', 9)
  rgb(doc, ...BLACK)
  y = bullet(doc, 'The Company shall offer full technical support for QR access, downloading, and basic troubleshooting through a dedicated helpline and Relationship Manager for thirty (30) days post-delivery.', M, y, CW)
  y = bullet(doc, 'No structural modifications to the HPC shall be permitted post-printing; only factual data corrections may be considered within the specified support period.', M, y, CW)

  y += 6
  y = divider(doc, M, y, CW)

  // ── IP & NON-COMPETE ──────────────────────────────────────────────────────
  y = heading(doc, '6.  INTELLECTUAL PROPERTY & NON-COMPETE', M, y, CW)
  y += 4
  sf(doc, 'normal', 9)
  rgb(doc, ...BLACK)
  y = bullet(doc, 'The Company retains exclusive intellectual property rights in all proprietary tools, formats, designs, methodologies, and systems under the Copyright Act, 1957.', M, y, CW)
  y = bullet(doc, 'The School shall not replicate, reverse-engineer, adapt, disclose, or share the Company\'s formats or designs with any third party, including LMS/ERP platforms.', M, y, CW)
  y = bullet(doc, 'Any unauthorised commercial use or duplication without prior written consent shall be deemed infringement and subject to legal recourse including injunctive relief and damages.', M, y, CW)

  y += 6
  y = divider(doc, M, y, CW)

  // ── CONFIDENTIALITY ───────────────────────────────────────────────────────
  y = heading(doc, '7.  CONFIDENTIALITY & DATA SECURITY', M, y, CW)
  y += 4
  sf(doc, 'normal', 9)
  rgb(doc, ...BLACK)
  y = bullet(doc, 'Each Party shall maintain confidentiality of all proprietary or student-related information and shall not disclose such information to third parties without written consent.', M, y, CW)
  y = bullet(doc, 'Student and parent data are strictly confidential and remain the sole property of the School. No student or parent data shall be used for commercial purposes.', M, y, CW)
  y = bullet(doc, 'The Company shall employ industry-standard safeguards and comply with the Information Technology Act, 2000.', M, y, CW)
  y = bullet(doc, 'Soft copies of HPCs shall be accessible to the School and parents for a lifetime. Upon termination or non-renewal, digital ownership shall irrevocably transfer to the School.', M, y, CW)

  y += 6
  y = divider(doc, M, y, CW)

  // ── PUBLICITY ─────────────────────────────────────────────────────────────
  y = heading(doc, '8.  PUBLICITY', M, y, CW)
  y += 4
  sf(doc, 'normal', 9)
  rgb(doc, ...BLACK)
  y = bullet(doc, 'The School authorises the Company to use its name and logo in marketing materials, social media, and case studies solely for showcasing HPC implementation success.', M, y, CW)
  y = bullet(doc, 'The Company shall not publish any student-specific or academic content without prior written approval.', M, y, CW)

  y += 6
  y = divider(doc, M, y, CW)

  // ── LEGAL ─────────────────────────────────────────────────────────────────
  y = heading(doc, '9.  LEGAL & DISPUTE RESOLUTION', M, y, CW)
  y += 4
  sf(doc, 'normal', 9)
  rgb(doc, ...BLACK)
  y = bullet(doc, 'This Agreement shall be governed and construed in accordance with the laws of India.', M, y, CW)
  y = bullet(doc, 'The Parties agree to submit to the exclusive jurisdiction of competent courts in Pune, Maharashtra.', M, y, CW)
  y = bullet(doc, 'Any unresolved dispute shall be referred to arbitration under the Arbitration and Conciliation Act, 1996. The seat and venue shall be Pune, Maharashtra. The arbitral award shall be final and binding.', M, y, CW)

  y += 6
  y = divider(doc, M, y, CW)

  // ── MISCELLANEOUS ─────────────────────────────────────────────────────────
  y = heading(doc, '10.  MISCELLANEOUS', M, y, CW)
  y += 4
  sf(doc, 'normal', 9)
  rgb(doc, ...BLACK)
  y = bullet(doc, 'Force Majeure: Neither Party shall be liable for delays or non-performance arising from causes beyond reasonable control.', M, y, CW)
  y = bullet(doc, 'Entire Agreement: This Agreement constitutes the entire agreement and supersedes all prior oral and written discussions.', M, y, CW)
  y = bullet(doc, 'Amendment: No modification shall be effective unless in writing and signed by authorised representatives of both Parties.', M, y, CW)
  y = bullet(doc, 'Severability: If any provision is held invalid, the remainder of the Agreement shall continue in full force.', M, y, CW)
  y = bullet(doc, 'Attribution: The HPC used under this Agreement is an adapted version of the HPC developed by PARAKH, NCERT. All copyrights remain with the respective original owners.', M, y, CW)
  y = bullet(doc, 'The General Terms for HPC Services form part of this Agreement and are binding on both Parties.', M, y, CW)

  // ── SIGNATURES ────────────────────────────────────────────────────────────
  y += 10
  divider(doc, M, y, CW)
  y += 10

  sf(doc, 'bold', 10)
  rgb(doc, ...BLACK)
  doc.text('SIGNATURES', M, y)
  y += 14

  sf(doc, 'normal', 8.5)
  rgb(doc, ...GRAY)
  y = para(doc, 'By signing below, the Parties agree to be bound by the terms and conditions set forth in this Agreement.', M, y, CW)
  y += 16

  // Signature boxes
  const bw = (CW - 24) / 2
  const bh = 90

  // Company box
  draw(doc, ...LGRAY)
  doc.setLineWidth(0.5)
  doc.rect(M, y, bw, bh, 'S')
  sf(doc, 'bold', 9)
  rgb(doc, ...BLACK)
  doc.text('For Scratchpad Labs Pvt Ltd :', M + 10, y + 16)
  sf(doc, 'normal', 8)
  rgb(doc, ...GRAY)
  doc.text('Name:', M + 10, y + 36)
  doc.text('Designation:', M + 10, y + 50)
  doc.text('Date:', M + 10, y + 64)
  doc.text('Signature:', M + 10, y + 78)

  // School box
  const sx = M + bw + 24
  doc.rect(sx, y, bw, bh, 'S')
  sf(doc, 'bold', 9)
  rgb(doc, ...BLACK)
  doc.text(`For ${a.school_name} :`, sx + 10, y + 16, { maxWidth: bw - 20 })
  sf(doc, 'normal', 8)
  rgb(doc, ...GRAY)
  doc.text('Name: ' + (a.signatory_name || ''), sx + 10, y + 36)
  doc.text('Designation: ' + (a.signatory_designation || ''), sx + 10, y + 50)
  doc.text('Date:', sx + 10, y + 64)
  doc.text('Signature:', sx + 10, y + 78)

  // ── FOOTERS ───────────────────────────────────────────────────────────────
  const total = doc.getNumberOfPages()
  for (let i = 1; i <= total; i++) {
    doc.setPage(i)
    footer(doc, i, total, a.agreement_number)
  }

  return doc
}

export function generateAgreementNumber(existingNumbers) {
  const now    = new Date()
  const yy     = String(now.getFullYear()).slice(-2)
  const mm     = String(now.getMonth() + 1).padStart(2, '0')
  const prefix = `AGR-${yy}${mm}-`
  const existing = (existingNumbers || [])
    .filter(n => n && n.startsWith(prefix))
    .map(n => parseInt(n.replace(prefix, '')) || 0)
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1
  return prefix + String(next).padStart(3, '0')
}

export function getInstallmentSplits(plan) {
  return plan === 'B' ? [25, 25, 25, 25] : [50, 25, 25]
}
