import { FieldValue } from 'firebase-admin/firestore'
import { operationalJournalMessage, operationalJournalRunKey } from './operationalJournalNotifications.js'

// The backup starts one hour later. A killed 10-minute GitHub job must not block it.
const RUN_STALE_AFTER_MS = 30 * 60 * 1000

function testFids(snapshot, employeeId) {
  return [...new Set(snapshot.docs.flatMap((document) => {
    const device = document.data()
    const installationId = String(device?.installationId || '')
    return device?.active === true
      && device?.employeeId === employeeId
      && installationId
      && installationId === document.id
      ? [installationId]
      : []
  }))]
}

function testMessage(message, fids) {
  const { topic: _topic, ...payload } = message
  return { ...payload, fids }
}

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function acquireMonthlyRun(db, dateKey, source) {
  const runKey = operationalJournalRunKey(dateKey)
  const ref = db.collection('systemNotificationRuns').doc(runKey)
  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref)
    const existing = snapshot.exists ? snapshot.data() : null
    if (existing?.status === 'sent') return false
    const age = Date.now() - timestampMillis(existing?.startedAt)
    if (existing?.status === 'running' && age >= 0 && age < RUN_STALE_AFTER_MS) return false
    transaction.set(ref, {
      kind: 'operational-journal',
      dateKey,
      status: 'running',
      source,
      startedAt: FieldValue.serverTimestamp(),
      finishedAt: FieldValue.delete(),
      error: FieldValue.delete(),
      attemptCount: FieldValue.increment(1),
    }, { merge: true })
    return true
  })
  return { acquired: result, ref, runKey }
}

export async function runOperationalJournalReminder({
  db = null,
  messaging = null,
  dateKey,
  delivery = 'preview',
  employeeId = '',
  source = 'manual',
  logger = console,
} = {}) {
  if (!['preview', 'validate', 'test', 'scheduled'].includes(delivery)) {
    throw new Error(`Unknown operational journal delivery mode: ${delivery}`)
  }
  if (delivery === 'test' && !/^emp-\d{3}$/.test(employeeId)) {
    throw new Error('For an address test, specify one employee in the emp-001 format.')
  }
  const message = operationalJournalMessage(dateKey)
  const summary = {
    status: delivery === 'preview' ? 'preview' : 'ready',
    delivery,
    dateKey,
    topic: message.topic,
    notification: message.notification,
  }
  if (delivery === 'preview') return summary
  if (!messaging) throw new Error('Firebase Messaging is required outside preview mode.')

  if (delivery === 'validate') {
    const messageId = await messaging.send(message, true)
    return { ...summary, status: 'validated', messageId }
  }

  if (delivery === 'test') {
    if (!db) throw new Error('Firestore is required for an address test.')
    const devicesSnapshot = await db.collection('ppePushDevices')
      .where('employeeId', '==', employeeId)
      .get()
    const fids = testFids(devicesSnapshot, employeeId)
    if (fids.length === 0) {
      throw new Error(
        `${employeeId} has no active registered APK. Open the installed app and sign in with the employee PIN first.`,
      )
    }
    const response = await messaging.sendEachForMulticast(testMessage(message, fids))
    const status = response.failureCount === 0
      ? 'sent'
      : response.successCount > 0 ? 'partial' : 'failed'
    logger.info?.('Operational journal address test finished', {
      employeeId,
      deviceCount: fids.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
    })
    return {
      ...summary,
      status,
      employeeId,
      deviceCount: fids.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
    }
  }
  if (!db) throw new Error('Firestore is required for scheduled delivery.')

  const run = await acquireMonthlyRun(db, dateKey, source)
  if (!run.acquired) {
    logger.info?.('Operational journal reminder already sent or still running', {
      dateKey,
      runKey: run.runKey,
    })
    return { ...summary, status: 'duplicate' }
  }

  try {
    const messageId = await messaging.send(message)
    await run.ref.set({
      status: 'sent',
      messageId,
      finishedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    logger.info?.('Operational journal reminder sent', { dateKey, messageId })
    return { ...summary, status: 'sent', messageId }
  } catch (error) {
    await run.ref.set({
      status: 'failed',
      error: String(error?.message || error),
      finishedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    throw error
  }
}
