const DAY_MS = 24 * 60 * 60 * 1000
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const CONTROL_CONFIG = Object.freeze({
  test: {
    requiredField: 'testRequired',
    dateField: 'nextTestDate',
    acknowledgedField: 'testAlertAcknowledgedDate',
    noun: 'испытания',
    overdue: 'испытание просрочено',
  },
  inspection: {
    requiredField: 'inspectionRequired',
    dateField: 'nextInspectionDate',
    acknowledgedField: 'inspectionAlertAcknowledgedDate',
    noun: 'осмотра',
    overdue: 'осмотр просрочен',
  },
})

function dateNumber(value) {
  if (!DATE_PATTERN.test(String(value ?? ''))) return null
  const [year, month, day] = value.split('-').map(Number)
  const result = Date.UTC(year, month - 1, day)
  const date = new Date(result)
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? result
    : null
}

export function daysUntilDate(date, today) {
  const target = dateNumber(date)
  const base = dateNumber(today)
  return target === null || base === null ? null : Math.round((target - base) / DAY_MS)
}

export function dateKeyInTimeZone(now = new Date(), timeZone = 'Asia/Yekaterinburg') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function notificationStage(days) {
  if (days === 14) return 'info'
  if (days === 7) return 'warning'
  if (days <= 3) return days < 0 ? 'overdue' : 'urgent'
  return null
}

function dayWord(value) {
  const absolute = Math.abs(value)
  const mod10 = absolute % 10
  const mod100 = absolute % 100
  if (mod10 === 1 && mod100 !== 11) return 'день'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня'
  return 'дней'
}

function itemSubject(item) {
  const name = String(item.typeName || 'СИЗ').trim()
  const inventoryNumber = String(item.inventoryNumber || '').trim()
  const location = String(item.location || '').trim()
  const quantity = Math.max(1, Number.parseInt(item.quantity, 10) || 1)
  const identity = inventoryNumber
    ? `инв. № ${inventoryNumber}`
    : item.trackingMode === 'group' ? `${quantity} шт.` : ''
  return [name, identity, location].filter(Boolean).join(' · ')
}

function alertMessage(alert) {
  const { controlKind, days, subject } = alert
  const noun = CONTROL_CONFIG[controlKind].noun
  if (days === 14) return `${subject}: до ${noun} осталось 14 дней.`
  if (days === 7) return `${subject}: до ${noun} осталось 7 дней.`
  if (days > 0) {
    const action = controlKind === 'test' ? 'Пора готовить к сдаче' : 'Пора записать на осмотр'
    return `${action}: ${subject}. Осталось ${days} ${dayWord(days)}.`
  }
  if (days === 0) return `${subject}: срок ${noun} сегодня.`
  return `${subject}: ${CONTROL_CONFIG[controlKind].overdue} на ${Math.abs(days)} ${dayWord(days)}.`
}

export function collectPpeAlerts(items, today) {
  if (dateNumber(today) === null || !Array.isArray(items)) return []
  const alerts = []

  for (const item of items) {
    if (!item || item.status === 'decommissioned') continue
    // Старые документы без department относятся к ОВБ-1. Документы других
    // подразделений никогда не должны попадать в рассылку ОВБ-1.
    if (item.department && item.department !== 'ovb1') continue
    for (const [controlKind, config] of Object.entries(CONTROL_CONFIG)) {
      if (item[config.requiredField] !== true) continue
      const dueDate = String(item[config.dateField] || '')
      if (item[config.acknowledgedField] === dueDate && dueDate) continue
      const days = daysUntilDate(dueDate, today)
      const stage = days === null ? null : notificationStage(days)
      if (!stage) continue
      const alert = {
        key: `${item.id || 'unknown'}:${controlKind}:${dueDate}`,
        itemId: String(item.id || ''),
        controlKind,
        dueDate,
        days,
        stage,
        subject: itemSubject(item),
      }
      alerts.push({ ...alert, message: alertMessage(alert) })
    }
  }

  const rank = { overdue: 0, urgent: 1, warning: 2, info: 3 }
  return alerts.sort((left, right) =>
    rank[left.stage] - rank[right.stage]
    || left.days - right.days
    || left.subject.localeCompare(right.subject, 'ru'),
  )
}

export function collectPpeMenuAlertDueDates(items, department = 'ovb1') {
  if (!Array.isArray(items)) return []
  const dueDates = []

  for (const item of items) {
    if (!item || item.status === 'decommissioned') continue
    if ((item.department || 'ovb1') !== department) continue

    const itemDates = []
    for (const config of Object.values(CONTROL_CONFIG)) {
      if (item[config.requiredField] !== true) continue
      const dueDate = String(item[config.dateField] || '')
      if (dateNumber(dueDate) === null) continue
      if (item[config.acknowledgedField] === dueDate) continue
      itemDates.push(dueDate)
    }
    itemDates.sort()
    if (itemDates[0]) dueDates.push(itemDates[0])
  }

  return dueDates.sort()
}

function shorten(value, maxLength) {
  const text = String(value || '').trim()
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`
}

function ppeSuffix(count) {
  if (count <= 0) return ''
  return ` Ещё ${count} СИЗ ${count === 1 ? 'требует' : 'требуют'} внимания.`
}

export function countPpeItemsInAlerts(alerts) {
  if (!Array.isArray(alerts)) return 0
  return new Set(alerts.map((alert, index) => {
    const itemId = String(alert?.itemId || '').trim()
    if (itemId) return `id:${itemId}`
    const subject = String(alert?.subject || '').trim()
    return subject ? `subject:${subject}` : `alert:${index}`
  })).size
}

export function buildPpeNotification(alerts, today) {
  if (!Array.isArray(alerts) || alerts.length === 0) return null
  const primary = alerts[0]
  const title = 'СИЗ ОВБ-1'
  const itemCount = countPpeItemsInAlerts(alerts)
  const suffix = ppeSuffix(itemCount - 1)
  const body = shorten(`${primary.message}${suffix}`, 260)
  return {
    title,
    body,
    data: {
      kind: 'ppe',
      route: 'ppe',
      title,
      body,
      date: today,
      alertCount: String(alerts.length),
      itemCount: String(itemCount),
    },
  }
}

export function collectEligiblePpeFids(devices, users, employeeId = '') {
  if (!Array.isArray(devices) || !Array.isArray(users)) return []
  const requiredEmployeeId = String(employeeId || '').trim()
  const allowedUids = new Set(users.flatMap((user) =>
    user?.id
      && user.department === 'ovb1'
      && user.active === true
      && user.canUsePpe === true
      ? [String(user.id)]
      : [],
  ))
  return [...new Set(devices.flatMap((device) => {
    const installationId = String(device?.installationId || '')
    const documentId = String(device?.id || '')
    if (requiredEmployeeId && device?.employeeId !== requiredEmployeeId) return []
    return device?.active === true
      && device?.department === 'ovb1'
      && allowedUids.has(String(device?.ownerUid || ''))
      && installationId
      && installationId === documentId
      ? [installationId]
      : []
  }))]
}
