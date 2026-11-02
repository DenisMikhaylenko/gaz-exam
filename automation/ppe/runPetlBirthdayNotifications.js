import { FieldValue } from 'firebase-admin/firestore'
import { collectEligiblePpeFids } from './ppeNotifications.js'
import { loadDepartmentPpeData } from './notificationDepartments.js'
import { resolveNotificationDate } from './notificationDate.js'
import { collectPetlBirthdays, petlBirthdayMessage } from './petlBirthdayNotifications.js'

const INVALID_FID = new Set(['messaging/installation-id-not-registered',
  'messaging/invalid-registration-token', 'messaging/registration-token-not-registered'])
const STALE_MS = 30 * 60 * 1000

async function acquireRun(db, dateKey, source, now) {
  const ref = db.collection('ppeDepartments').doc('petl').collection('notificationRuns').doc(`birthday-${dateKey}`)
  const result = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref)
    const existing = snapshot.exists ? snapshot.data() : null
    const completedFids = existing?.completedFids || []
    const startedAt = existing?.startedAt?.toMillis?.() ?? Date.parse(existing?.startedAt)
    if (existing?.status === 'sent' || (existing?.status === 'running' && now - startedAt >= 0 && now - startedAt < STALE_MS)) {
      return { acquired: false, completedFids }
    }
    transaction.set(ref, {
      kind: 'petl-birthday', department: 'petl', dateKey, status: 'running', source,
      startedAt: FieldValue.serverTimestamp(), attemptCount: FieldValue.increment(1),
      finishedAt: FieldValue.delete(), error: FieldValue.delete(),
    }, { merge: true })
    return { acquired: true, completedFids }
  })
  return { ...result, ref }
}

export async function runPetlBirthdayNotifications({
  db, messaging, dateKey = '', delivery = 'preview', installationId = '',
  source = 'local-cli', now = new Date(),
} = {}) {
  if (!['preview', 'validate', 'test', 'scheduled'].includes(delivery)) throw new Error('Unknown birthday delivery mode.')
  dateKey = resolveNotificationDate({ delivery, requestedDate: dateKey, now })
  if (['test', 'validate'].includes(delivery) && !/^[A-Za-z0-9_-]{10,128}$/.test(installationId)) {
    throw new Error('Specify exactly one phone with --installation for test/validate.')
  }
  const summary = { status: 'preview', department: 'petl', delivery, dateKey }
  const root = db.collection('ppeDepartments').doc('petl')
  const config = await root.get()
  if (!config.exists || config.data().active !== true || config.data().birthdayNotificationsEnabled !== true) {
    return { ...summary, status: 'disabled' }
  }
  // A delayed scheduler must not deliver an early morning reminder during the night.
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Yekaterinburg', hour: '2-digit', hourCycle: 'h23' }).format(now))
  if (delivery === 'scheduled' && (hour < 9 || hour >= 19)) return { ...summary, status: 'outside-delivery-window' }
  const birthdayDocs = await root.collection('birthdays').get()
  const reminders = collectPetlBirthdays(birthdayDocs.docs.map(doc => ({ ...doc.data(), id: doc.id })), dateKey)
  if (!reminders.length) return { ...summary, status: 'no-birthdays', deviceCount: 0 }
  const message = petlBirthdayMessage(reminders, dateKey, { test: delivery === 'test', now: now.getTime() })
  const data = await loadDepartmentPpeData(db, 'petl')
  const capableDevices = data.devices.filter(device => device.birthdayNotificationsVersion === 1)
  const capableBindings = data.installations.filter(device => device.birthdayNotificationsVersion === 1)
  const eligible = collectEligiblePpeFids(capableDevices, data.users, '', 'petl', capableBindings)
  // Scheduled delivery always uses all eligible PETL phones. Test never broadens its target.
  const fids = ['test', 'validate'].includes(delivery) ? eligible.filter(fid => fid === installationId) : eligible
  Object.assign(summary, { deviceCount: fids.length, title: message.data.title, body: message.data.body, birthdayCount: reminders.length })
  if (delivery === 'preview') return summary
  if (['test', 'validate'].includes(delivery) && fids.length !== 1) {
    throw new Error('The selected phone must have a current PETL login and an APK supporting birthday notifications.')
  }
  if (!messaging) throw new Error('Firebase Messaging is required for delivery.')
  if (!fids.length) return { ...summary, status: 'waiting-for-devices' }
  const run = delivery === 'scheduled' ? await acquireRun(db, dateKey, source, now.getTime()) : null
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
    const status = delivery === 'validate' ? (failureCount ? 'failed' : 'validated')
      : retryableFailureCount ? 'partial' : 'sent'
    if (run) await run.ref.set({ status, completedFids: [...completed], successCount, failureCount,
      finishedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { ...summary, status, successCount, failureCount }
  } catch (error) {
    if (run) await run.ref.set({ status: 'failed', error: String(error?.message || error),
      finishedAt: FieldValue.serverTimestamp() }, { merge: true })
    throw error
  }
}
