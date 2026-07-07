export function useSanityCheck() {
  function checkQuotation(form) {
    const warnings = []
    if (!form.school_name?.trim()) warnings.push({ level: 'error', field: 'school_name', msg: 'School name is required' })
    if (!form.student_count || form.student_count < 1) warnings.push({ level: 'error', field: 'student_count', msg: 'Student count is required' })
    if (form.student_count > 10000) warnings.push({ level: 'warn', field: 'student_count', msg: `Student count ${form.student_count} seems very high — please verify` })
    if (form.student_count > 0 && form.student_count < 50) warnings.push({ level: 'warn', field: 'student_count', msg: `Student count ${form.student_count} seems low — please verify` })
    return warnings
  }

  function checkAgreement(form) {
    const warnings = []
    if (!form.school_name?.trim()) warnings.push({ level: 'error', field: 'school_name', msg: 'School name is required' })
    if (!form.school_address?.trim()) warnings.push({ level: 'error', field: 'school_address', msg: 'School address is required — it will appear in the agreement' })
    if (!form.fee_per_student || form.fee_per_student < 1) warnings.push({ level: 'error', field: 'fee_per_student', msg: 'Fee per student is required' })
    if (!form.student_count || form.student_count < 1) warnings.push({ level: 'error', field: 'student_count', msg: 'Student count is required' })
    if (form.fee_per_student > 500) warnings.push({ level: 'warn', field: 'fee_per_student', msg: `Fee per student is ₹${form.fee_per_student} — this seems high, please verify` })
    if (form.fee_per_student > 0 && form.fee_per_student < 50) warnings.push({ level: 'warn', field: 'fee_per_student', msg: `Fee per student is ₹${form.fee_per_student} — this seems very low, please verify` })
    if (form.student_count > 10000) warnings.push({ level: 'warn', field: 'student_count', msg: `Student count ${form.student_count} seems very high — please verify` })
    if (form.student_count > 0 && form.student_count < 50) warnings.push({ level: 'warn', field: 'student_count', msg: `Student count ${form.student_count} seems low — please verify` })
    if (!form.installment_plan) warnings.push({ level: 'error', field: 'installment_plan', msg: 'Installment plan is required' })
    if (!form.hpc_type) warnings.push({ level: 'warn', field: 'hpc_type', msg: 'HPC type not selected — defaulting to printed and digital' })
    const total = (form.fee_per_student || 0) * (form.student_count || 0)
    if (total > 5000000) warnings.push({ level: 'warn', msg: `Total contract value is ₹${total.toLocaleString('en-IN')} — please double-check` })
    return warnings
  }

  function checkInvoice(form) {
    const warnings = []
    if (!form.school_name?.trim()) warnings.push({ level: 'error', field: 'school_name', msg: 'School name is required' })
    if (!form.school_address?.trim()) warnings.push({ level: 'warn', field: 'school_address', msg: 'School address is missing — it will appear blank on the invoice' })
    if (!form.school_phone?.trim()) warnings.push({ level: 'warn', field: 'school_phone', msg: 'School phone is missing — it will appear blank on the invoice' })
    if (!form.description?.trim()) warnings.push({ level: 'error', field: 'description', msg: 'Invoice description is required' })
    if (!form.price_per_student || form.price_per_student < 1) warnings.push({ level: 'error', field: 'price_per_student', msg: 'Price per student is required' })
    if (!form.quantity || form.quantity < 1) warnings.push({ level: 'error', field: 'quantity', msg: 'Student count is required' })
    if (form.price_per_student > 500) warnings.push({ level: 'warn', field: 'price_per_student', msg: `Price per student ₹${form.price_per_student} seems high — please verify` })
    if (form.price_per_student > 0 && form.price_per_student < 50) warnings.push({ level: 'warn', field: 'price_per_student', msg: `Price per student ₹${form.price_per_student} seems very low — please verify` })
    if (form.quantity > 10000) warnings.push({ level: 'warn', field: 'quantity', msg: `Student count ${form.quantity} seems very high — please verify` })
    const total = (form.price_per_student || 0) * (form.quantity || 0)
    if (total > 2000000) warnings.push({ level: 'warn', msg: `Invoice total ₹${total.toLocaleString('en-IN')} is very large — please double-check` })
    return warnings
  }

  function checkOnboarding(school) {
    const warnings = []
    if (!school.name?.trim()) warnings.push({ level: 'error', field: 'name', msg: 'School name is required' })
    if (!school.city?.trim()) warnings.push({ level: 'warn', field: 'city', msg: 'City is missing — it will appear blank on the document' })
    if (!school.pocs?.length) warnings.push({ level: 'warn', field: 'pocs', msg: 'No Points of Contact added — POC name/phone will be blank' })
    if (school.pocs?.length && !school.pocs[0].phone) warnings.push({ level: 'warn', field: 'pocs', msg: 'Primary POC phone number is missing' })
    if (!school.student_count) warnings.push({ level: 'warn', field: 'student_count', msg: 'Student count not set for this school' })
    return warnings
  }

  return { checkQuotation, checkAgreement, checkInvoice, checkOnboarding }
}
