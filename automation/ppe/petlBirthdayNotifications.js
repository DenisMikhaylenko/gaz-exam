import { daysUntilDate } from './ppeNotifications.js'
import { notificationTtlForDate } from './notificationDate.js'

export function collectPetlBirthdays(people, dateKey) {
  if (daysUntilDate(dateKey, dateKey) !== 0) throw new Error('Invalid birthday reminder date.')
  const tomorrow = new Date(Date.parse(`${dateKey}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  return people.flatMap(person => {
    if (person.department !== 'petl' || person.active !== true
      || !String(person.displayName || '').trim()
      || daysUntilDate(person.birthDate, person.birthDate) !== 0) return []
    const monthDay = person.birthDate.slice(5)
    const birthdayDate = monthDay === dateKey.slice(5) ? dateKey
      : monthDay === tomorrow.slice(5) ? tomorrow : ''
    return birthdayDate ? [{
      id: person.id, displayName: person.displayName.trim(), birthdayDate,
      daysBefore: birthdayDate === dateKey ? 0 : 1,
    }] : []
  }).sort((a, b) => a.daysBefore - b.daysBefore || a.displayName.localeCompare(b.displayName, 'ru'))
}

export function petlBirthdayMessage(reminders, dateKey, { test = false, now = Date.now() } = {}) {
  if (!reminders.length) return null
  const lines = [0, 1].flatMap(days => {
    const names = reminders.filter(person => person.daysBefore === days).map(person => person.displayName)
    const subject = names.join(', ')
    return names.length ? [`${days ? 'Завтра' : 'Сегодня'} день рождения: ${subject}${/[.!?]$/.test(subject) ? '' : '.'}`] : []
  })
  const title = `${test ? 'Тест · ' : ''}Дни рождения ПЭТЛ`
  const body = `${test ? 'Проверка уведомлений. ' : ''}${lines.join(' ')}`
  const tag = `${test ? 'test-' : ''}petl-birthday-${dateKey}`
  return {
    // Data-only: the APK checks its current department before displaying anything,
    // including when the application is in the background.
    data: { kind: 'petl-birthday', department: 'petl', route: 'birthdays', date: dateKey, title, body },
    android: {
      priority: 'high', collapseKey: tag,
      ttl: test ? 5 * 60 * 1000 : notificationTtlForDate(dateKey, 15 * 60 * 60 * 1000, now),
    },
  }
}
