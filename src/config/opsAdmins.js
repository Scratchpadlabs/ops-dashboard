export const OPS_ADMIN_EMAILS = ['sid@ops.clarified.in', 'angel@ops.clarified.in']

export const isOpsAdmin = (email) =>
  !!email && OPS_ADMIN_EMAILS.includes(String(email).trim().toLowerCase())
