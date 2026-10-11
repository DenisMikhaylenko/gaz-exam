import { dateKeyInTimeZone, daysUntilDate } from './ppeNotifications.js'

// Test dates must never consume today's/future month's production run marker.
export function resolveNotificationDate({ delivery, requestedDate = '', now = new Date() }) {
  const today = dateKeyInTimeZone(now, 'Asia/Yekaterinburg')
  const dateKey = String(requestedDate || today).trim()
  if (daysUntilDate(dateKey, dateKey) !== 0) throw new Error('Date must be a real calendar date in YYYY-MM-DD format.')
  if (delivery === 'scheduled' && dateKey !== today) {
    throw new Error('Scheduled delivery can only use today in Asia/Yekaterinburg. Use preview/validate/test for another date.')
  }
  return dateKey
}

// Yekaterinburg is UTC+5. Do not queue a reminder saying "today" into tomorrow.
export function notificationTtlForDate(dateKey, maximumTtlMs, now = Date.now()) {
  if (daysUntilDate(dateKey, dateKey) !== 0) throw new Error('Invalid notification date.')
  const midnightAfter = Date.parse(`${dateKey}T00:00:00+05:00`) + 24 * 60 * 60 * 1000
  return Math.max(0, Math.min(maximumTtlMs, midnightAfter - Number(now)))
}
