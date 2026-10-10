import { FieldValue } from 'firebase-admin/firestore'
import {
  buildPpeNotification,
  collectEligiblePpeFids,
  collectPpeAlerts,
  collectPpeMenuAlertDueDates,
} from './ppeNotifications.js'

const DEPARTMENT = 'ovb1'
const MAX_MULTICAST_SIZE = 500
const RUN_STALE_AFTER_MS = 30 * 60 * 1000
const INVALID_INSTALLATION_ERRORS = new Set([
  'messaging/installation-id-not-registered',
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
])

function chunks(values, size) {
  const result = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function recordTime(record) {
  return timestampMillis(record?.updatedAt)
}

function mergeSnapshots(snapshots) {
  const records = new Map()
  for (const snapshot of snapshots) {
    for (const document of snapshot.docs) {
      if (document.data()?.placeholder === true) continue
      const record = { id: document.id, ...document.data() }
      const previous = records.get(document.id)
      if (!previous || recordTime(record) >= recordTime(previous)) {
        records.set(document.id, record)
      }
    }
  }
  return [...records.values()]
}

async function acquireDailyRun(db, dateKey, source) {
  const legacyRef = db.collection('ppeNotificationRuns').doc(dateKey)
  const ref = db.collection('ppeDepartments').doc(DEPARTMENT)
    .collection('notificationRuns').doc(dateKey)
  const acquired = await db.runTransaction(async (transaction) => {
    const [snapshot, legacySnapshot] = await Promise.all([
      transaction.get(ref),
      transaction.get(legacyRef),
    ])
    const existing = [snapshot, legacySnapshot]
      .filter((entry) => entry.exists)
      .map((entry) => entry.data())
    if (existing.some((entry) => ['sent', 'skipped'].includes(entry?.status))) return false

    const activeRun = existing.find((entry) => entry?.status === 'running')
    const activeRunAge = Date.now() - timestampMillis(activeRun?.startedAt)
    if (activeRun && activeRunAge >= 0 && activeRunAge < RUN_STALE_AFTER_MS) return false

    const data = {
      status: 'running',
      source,
      department: DEPARTMENT,
      dateKey,
      startedAt: FieldValue.serverTimestamp(),
      finishedAt: FieldValue.delete(),
      attemptCount: FieldValue.increment(1),
    }
    transaction.set(ref, data, { merge: true })
    transaction.set(legacyRef, data, { merge: true })
    return true
  })
  return { acquired, ref, legacyRef }
}

async function updateDailyRun(db, run, data) {
  if (!run) return
  const batch = db.batch()
  batch.set(run.ref, data, { merge: true })
  batch.set(run.legacyRef, data, { merge: true })
  await batch.commit()
}

function messageFor(notification, fids) {
  return {
    fids,
    notification: {
      title: notification.title,
      body: notification.body,
    },
    data: notification.data,
    android: {
      priority: 'high',
      notification: {
        channelId: 'ppe_alerts',
        icon: 'ic_notification_update',
        color: '#0BA77B',
        sound: 'default',
      },
    },
  }
}

/**
 * Runs the OVB-1 PPE notification job.
 *
 * delivery:
 * - preview: calculate only;
 * - validate: ask Firebase to validate one employee payload without delivery;
 * - test: deliver to one employee without creating the daily run marker;
 * - scheduled: deliver to every eligible OVB-1 installation once per date.
 */
export async function runPpeNotifications({
  db,
  messaging,
  dateKey,
  delivery = 'preview',
  employeeId = '',
  source = 'manual',
  logger = console,
}) {
  if (!db || !messaging) throw new Error('Firestore and Firebase Messaging are required.')
  if (!['preview', 'validate', 'test', 'scheduled'].includes(delivery)) {
    throw new Error(`Unknown PPE notification delivery mode: ${delivery}`)
  }
  if (['validate', 'test'].includes(delivery) && !/^emp-\d{3}$/.test(employeeId)) {
    throw new Error('For an address test, specify one employee in the emp-001 format.')
  }

  const tracksDailyRun = delivery === 'scheduled'
  const run = tracksDailyRun ? await acquireDailyRun(db, dateKey, source) : null
  if (run && !run.acquired) {
    logger.info?.('PPE notification run already completed or is still running', { dateKey })
    return { status: 'duplicate', dateKey }
  }

  try {
    const departmentRef = db.collection('ppeDepartments').doc(DEPARTMENT)
    const [
      legacyItemsSnapshot,
      itemsSnapshot,
      legacyUsersSnapshot,
      usersSnapshot,
      legacyDevicesSnapshot,
      devicesSnapshot,
    ] = await Promise.all([
      db.collection('ppeItems').get(),
      departmentRef.collection('items').get(),
      db.collection('users').where('department', '==', DEPARTMENT).get(),
      departmentRef.collection('users').get(),
      db.collection('ppePushDevices').where('active', '==', true).get(),
      departmentRef.collection('devices').where('active', '==', true).get(),
    ])
    const items = mergeSnapshots([legacyItemsSnapshot, itemsSnapshot])
      .filter((item) => (item.department || DEPARTMENT) === DEPARTMENT)
    const users = mergeSnapshots([legacyUsersSnapshot, usersSnapshot])
      .filter((user) => user.department === DEPARTMENT)
    const devices = mergeSnapshots([legacyDevicesSnapshot, devicesSnapshot])
      .filter((device) => device.department === DEPARTMENT && device.active === true)
    const alerts = collectPpeAlerts(items, dateKey)
    const notification = buildPpeNotification(alerts, dateKey)
    const menuAlertDueDates = collectPpeMenuAlertDueDates(items, DEPARTMENT)
    const fids = collectEligiblePpeFids(devices, users, employeeId)

    const summary = {
      status: delivery === 'preview' ? 'preview' : 'ready',
      dateKey,
      delivery,
      itemCount: items.length,
      alertCount: alerts.length,
      deviceCount: fids.length,
      notification,
    }
    if (delivery === 'preview') return summary

    if (tracksDailyRun) {
      await db.collection('ppePublicAlerts').doc(DEPARTMENT).set({
        schemaVersion: 1,
        department: DEPARTMENT,
        dueDates: menuAlertDueDates,
        updatedAt: FieldValue.serverTimestamp(),
      })
    }

    if (!notification || fids.length === 0) {
      if (['validate', 'test'].includes(delivery) && fids.length === 0) {
        throw new Error(
          `${employeeId} is not an active OVB-1 PPE recipient: `
          + 'department=ovb1, active=true, canUsePpe=true and a registered APK are required.',
        )
      }
      await updateDailyRun(db, run, {
        status: 'skipped',
        alertCount: alerts.length,
        deviceCount: fids.length,
        finishedAt: FieldValue.serverTimestamp(),
      })
      return { ...summary, status: 'skipped' }
    }

    let successCount = 0
    let failureCount = 0
    const invalidFids = []
    for (const batchFids of chunks(fids, MAX_MULTICAST_SIZE)) {
      const response = await messaging.sendEachForMulticast(
        messageFor(notification, batchFids),
        delivery === 'validate',
      )
      successCount += response.successCount
      failureCount += response.failureCount
      response.responses.forEach((result, index) => {
        if (!result.success && INVALID_INSTALLATION_ERRORS.has(result.error?.code)) {
          invalidFids.push(batchFids[index])
        }
      })
    }

    if (delivery !== 'validate' && invalidFids.length) {
      const cleanup = db.batch()
      for (const fid of invalidFids) {
        const data = {
          active: false,
          disabledAt: FieldValue.serverTimestamp(),
          disabledReason: 'firebase-installation-not-registered',
        }
        cleanup.set(db.collection('ppePushDevices').doc(fid), data, { merge: true })
        cleanup.set(departmentRef.collection('devices').doc(fid), data, { merge: true })
      }
      await cleanup.commit()
    }

    const status = delivery === 'validate' ? 'validated' : 'sent'
    await updateDailyRun(db, run, {
      status,
      alertCount: alerts.length,
      deviceCount: fids.length,
      successCount,
      failureCount,
      invalidDeviceCount: invalidFids.length,
      finishedAt: FieldValue.serverTimestamp(),
    })
    logger.info?.('PPE notification job finished', {
      dateKey,
      delivery,
      alertCount: alerts.length,
      deviceCount: fids.length,
      successCount,
      failureCount,
    })
    return {
      ...summary,
      status,
      successCount,
      failureCount,
      invalidDeviceCount: invalidFids.length,
    }
  } catch (error) {
    await updateDailyRun(db, run, {
      status: 'failed',
      error: String(error?.message || error),
      finishedAt: FieldValue.serverTimestamp(),
    })
    throw error
  }
}
