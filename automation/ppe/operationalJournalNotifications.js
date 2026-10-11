import { notificationTtlForDate } from './notificationDate.js'

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// APK 0.8.6 already subscribes to app_updates, but not to operational_journal_reminders.
// Use exactly one common topic (not both) so old APKs receive this reminder too.
export const OPERATIONAL_JOURNAL_TOPIC = 'app_updates'
export const OPERATIONAL_JOURNAL_TITLE = 'Оперативный журнал'
export const OPERATIONAL_JOURNAL_BODY =
  'Сегодня 2-е число. Выполните ежемесячный осмотр, зафиксируйте количество переключений устройств РПН и сделайте запись в оперативном журнале.'
export const OPERATIONAL_JOURNAL_TTL_MS = 20 * 60 * 60 * 1000

export function validDateKey(dateKey) {
  const match = DATE_RE.exec(String(dateKey || ''))
  if (!match) return false
  const [, year, month, day] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day)
}

export function isOperationalJournalDay(dateKey) {
  return validDateKey(dateKey) && dateKey.endsWith('-02')
}

export function operationalJournalRunKey(dateKey) {
  if (!isOperationalJournalDay(dateKey)) {
    throw new Error('Operational journal reminder date must be the 2nd day of a real month.')
  }
  return `operational-journal-${dateKey.slice(0, 7)}`
}

export function operationalJournalMessage(dateKey) {
  const runKey = operationalJournalRunKey(dateKey)
  return {
    topic: OPERATIONAL_JOURNAL_TOPIC,
    notification: {
      title: OPERATIONAL_JOURNAL_TITLE,
      body: OPERATIONAL_JOURNAL_BODY,
    },
    data: {
      kind: 'operational-journal',
      date: dateKey,
      title: OPERATIONAL_JOURNAL_TITLE,
      body: OPERATIONAL_JOURNAL_BODY,
    },
    android: {
      priority: 'high',
      collapseKey: runKey,
      ttl: notificationTtlForDate(dateKey, OPERATIONAL_JOURNAL_TTL_MS),
      notification: {
        // This channel exists in 0.8.6; the separate journal channel requires a newer APK.
        channelId: 'app_updates',
        icon: 'ic_notification_update',
        color: '#278EE7',
        sound: 'default',
        tag: runKey,
      },
    },
  }
}
