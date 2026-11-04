export const isContactId = value => typeof value === 'string' && /^1[3-9]\d{9}$/.test(value)
export const contactError = (code, message) => Object.assign(new Error(message), { status: 409, code })
export function validateContactId(value) {
  if (value !== undefined && !isContactId(value)) throw Object.assign(new Error('Contact ID must be an 11-digit mobile number'), { status: 400 })
}
