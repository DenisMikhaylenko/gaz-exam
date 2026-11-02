import { FieldValue } from 'firebase-admin/firestore'
import { operationalJournalMessage, operationalJournalRunKey } from './operationalJournalNotifications.js'
import { loadDepartmentPpeData } from './notificationDepartments.js'
import { collectEligiblePpeFids } from './ppeNotifications.js'

const RUN_STALE_AFTER_MS = 30 * 60 * 1000
const INVALID_FID = new Set(['messaging/installation-id-not-registered',
  'messaging/invalid-registration-token', 'messaging/registration-token-not-registered'])

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function acquireMonthlyRun(db, dateKey, source) {
  // Preserve the OVB-1 marker to prevent repeating already sent legacy reminders.
  const ref = db.collection('systemNotificationRuns').doc(operationalJournalRunKey(dateKey))
  const result = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref)
    const existing = snapshot.exists ? snapshot.data() : null
    const completedFids = existing?.completedFids || []
    const age = Date.now() - timestampMillis(existing?.startedAt)
    if (existing?.status === 'sent' || (existing?.status === 'running' && age >= 0 && age < RUN_STALE_AFTER_MS)) {
      return { acquired: false, completedFids }
    }
    transaction.set(ref, {
      kind: 'operational-journal', department: 'ovb1', dateKey, status: 'running', source,
      startedAt: FieldValue.serverTimestamp(), finishedAt: FieldValue.delete(),
      error: FieldValue.delete(), attemptCount: FieldValue.increment(1),
    }, { merge: true })
    return { acquired: true, completedFids }
  })
  return { ...result, ref }
}

export async function runOperationalJournalReminder({
  db = null, messaging = null, dateKey, delivery = 'preview', employeeId = '',
  department = 'ovb1', source = 'manual', logger = console,
} = {}) {
  // This text describes OVB-1 work; other departments need their own reminder.
  if (department !== 'ovb1') throw new Error('Operational journal reminder is configured only for ovb1.')
  if (!['preview', 'validate', 'test', 'scheduled'].includes(delivery)) {
    throw new Error(`Unknown operational journal delivery mode: ${delivery}`)
  }
  if (delivery === 'test' && !/^emp-\d{3}$/.test(employeeId)) {
    throw new Error('For an address test, specify one employee in the emp-001 format.')
  }
  const message = operationalJournalMessage(dateKey)
  const summary = { status: 'preview', department, delivery, dateKey, notification: message.notification }
  if (delivery === 'preview') return summary
  if (!db || !messaging) throw new Error('Firestore and Firebase Messaging are required outside preview mode.')
  const data = await loadDepartmentPpeData(db, department)
  if (!data.enabled) return { ...summary, status: 'disabled' }
  const fids = collectEligiblePpeFids(data.devices, data.users,
    delivery === 'scheduled' ? '' : employeeId, department, data.installations)
  if (delivery !== 'scheduled' && !fids.length) throw new Error('No active registered APK for the selected OVB-1 employee.')
  const run = delivery === 'scheduled' ? await acquireMonthlyRun(db, dateKey, source) : null
  if (run && !run.acquired) return { ...summary, status: 'duplicate' }
  const completed = new Set(run?.completedFids || [])
  const pending = fids.filter(fid => !completed.has(fid))
  let successCount = 0, failureCount = 0, retryableFailureCount = 0
  try {
    for (let offset = 0; offset < pending.length; offset += 500) {
      const batch = pending.slice(offset, offset + 500)
      const response = await messaging.sendEachForMulticast({ ...message, fids: batch }, delivery === 'validate')
      successCount += response.successCount
      failureCount += response.failureCount
      response.responses.forEach((result, index) => {
        if (result.success || INVALID_FID.has(result.error?.code)) completed.add(batch[index])
        else retryableFailureCount++
      })
      if (run) await run.ref.set({ completedFids: [...completed] }, { merge: true })
    }
    const status = !fids.length ? 'waiting-for-devices'
      : delivery === 'validate' ? (failureCount ? 'failed' : 'validated')
        : retryableFailureCount ? 'partial' : 'sent'
    if (run) await run.ref.set({ status, completedFids: [...completed], successCount, failureCount,
      finishedAt: FieldValue.serverTimestamp() }, { merge: true })
    logger.info?.('Operational journal reminder finished', { department, dateKey, status, successCount, failureCount })
    return { ...summary, status, employeeId, deviceCount: fids.length, successCount, failureCount }
  } catch (error) {
    if (run) await run.ref.set({ status: 'failed', error: String(error?.message || error),
      finishedAt: FieldValue.serverTimestamp() }, { merge: true })
    throw error
  }
}
