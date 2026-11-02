import { FieldValue } from 'firebase-admin/firestore'
import { notificationTtlForDate } from './notificationDate.js'
import {
  buildPpeNotification,
  collectEligiblePpeFids,
  collectPpeAlerts,
  collectPpeMenuAlertDueDates,
  daysUntilDate,
} from './ppeNotifications.js'

import { loadDepartmentPpeData, notificationDepartmentLabel } from './notificationDepartments.js'
const MAX_MULTICAST_SIZE = 500
const RUN_STALE_AFTER_MS = 30 * 60 * 1000
export const PPE_NOTIFICATION_TTL_MS = 18 * 60 * 60 * 1000
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

async function acquireDailyRun(db, dateKey, source, department) {
  const legacyRef = department === 'ovb1' ? db.collection('ppeNotificationRuns').doc(dateKey) : null
  const ref = db.collection('ppeDepartments').doc(department)
    .collection('notificationRuns').doc(dateKey)
  const result = await db.runTransaction(async (transaction) => {
    const [snapshot, legacySnapshot] = await Promise.all([
      transaction.get(ref),
      legacyRef ? transaction.get(legacyRef) : { exists: false },
    ])
    const existing = [snapshot, legacySnapshot]
      .filter((entry) => entry.exists)
      .map((entry) => entry.data())
    const completedFids = [...new Set(existing.flatMap((entry) =>
      Array.isArray(entry?.completedFids) ? entry.completedFids : [],
    ))]
    if (existing.some((entry) => ['sent', 'skipped'].includes(entry?.status))) {
      return { acquired: false, completedFids }
    }

    const activeRun = existing.find((entry) => entry?.status === 'running')
    const activeRunAge = Date.now() - timestampMillis(activeRun?.startedAt)
    if (activeRun && activeRunAge >= 0 && activeRunAge < RUN_STALE_AFTER_MS) {
      return { acquired: false, completedFids }
    }

    const data = {
      status: 'running',
      source,
      department: department,
      dateKey,
      startedAt: FieldValue.serverTimestamp(),
      finishedAt: FieldValue.delete(),
      error: FieldValue.delete(),
      attemptCount: FieldValue.increment(1),
    }
    transaction.set(ref, data, { merge: true })
    if (legacyRef) transaction.set(legacyRef, data, { merge: true })
    return { acquired: true, completedFids }
  })
  return { ...result, ref, legacyRef }
}

async function updateDailyRun(db, run, data) {
  if (!run) return
  const batch = db.batch()
  batch.set(run.ref, data, { merge: true })
  if (run.legacyRef) batch.set(run.legacyRef, data, { merge: true })
  await batch.commit()
}

export function pendingPpeFids(fids, completedFids = []) {
  const completed = new Set(completedFids)
  return fids.filter((fid) => !completed.has(fid))
}

export function ppeDeliveryStatus({
  delivery,
  hasNotification,
  eligibleDeviceCount,
  retryableFailureCount,
}) {
  if (delivery === 'validate') return retryableFailureCount > 0 ? 'failed' : 'validated'
  if (delivery !== 'scheduled') return retryableFailureCount > 0 ? 'partial' : 'sent'
  if (!hasNotification) return 'skipped'
  if (eligibleDeviceCount === 0) return 'waiting-for-devices'
  return retryableFailureCount > 0 ? 'partial' : 'sent'
}

export function messageFor(notification, fids, dateKey, department = notification.data?.department || 'ovb1') {
  const dailyKey = `ppe-${department}-${dateKey}`
  // ПЭТЛ принимает сообщение через onMessageReceived и повторно проверяет
  // подразделение на телефоне. notification-payload обходил бы эту проверку
  // в фоне, если сотрудник сменил подразделение, пока сообщение было в очереди.
  const checkedOnDevice = department === 'petl'
  return {
    fids,
    ...(!checkedOnDevice && { notification: {
      title: notification.title,
      body: notification.body,
    } }),
    data: notification.data,
    android: {
      priority: 'high',
      collapseKey: dailyKey,
      ttl: notificationTtlForDate(dateKey, PPE_NOTIFICATION_TTL_MS),
      ...(!checkedOnDevice && { notification: {
        channelId: 'ppe_alerts',
        icon: 'ic_notification_update',
        color: '#0BA77B',
        sound: 'default',
        tag: dailyKey,
      } }),
    },
  }
}

/**
 * Runs one department’s PPE notification job.
 *
 * delivery:
 * - preview: calculate only;
 * - validate: ask Firebase to validate one employee payload without delivery;
 * - test: deliver to one employee without creating the daily run marker;
 * - scheduled: deliver to every eligible installation of this department once per date.
 */
export async function runPpeNotifications({
  db,
  messaging,
  dateKey,
  department = 'ovb1',
  delivery = 'preview',
  employeeId = '',
  source = 'manual',
  logger = console,
}) {
  if (!db || !messaging) throw new Error('Firestore and Firebase Messaging are required.')
  if (daysUntilDate(dateKey, dateKey) !== 0) throw new Error('Invalid PPE notification date.')
  if (!['preview', 'validate', 'test', 'scheduled'].includes(delivery)) {
    throw new Error(`Unknown PPE notification delivery mode: ${delivery}`)
  }
  if (['validate', 'test'].includes(delivery) && !/^emp-\d{3}$/.test(employeeId)) {
    throw new Error('For an address test, specify one employee in the emp-001 format.')
  }

  notificationDepartmentLabel(department)
  const records = await loadDepartmentPpeData(db, department)
  if (!records.enabled) return { status: 'disabled', dateKey, department, delivery }

  const tracksDailyRun = delivery === 'scheduled'
  // A department-wide daily marker must never be consumed by an employee test filter.
  // workflow_dispatch can supply its default employee even when the caller sends ''.
  const recipientEmployeeId = tracksDailyRun ? '' : employeeId
  const run = tracksDailyRun ? await acquireDailyRun(db, dateKey, source, department) : null
  if (run && !run.acquired) {
    logger.info?.('PPE notification run already completed or is still running', { dateKey })
    return { status: 'duplicate', dateKey }
  }

  try {
    const departmentRef = db.collection('ppeDepartments').doc(department)
    const { items, users, devices, installations } = records
    const alerts = collectPpeAlerts(items, dateKey, department)
    const notification = buildPpeNotification(alerts, dateKey, department)
    const menuAlertDueDates = collectPpeMenuAlertDueDates(items, department)
    const eligibleFids = collectEligiblePpeFids(devices, users, recipientEmployeeId, department, installations)
    const completedFids = new Set(run?.completedFids || [])
    const fids = tracksDailyRun
      ? pendingPpeFids(eligibleFids, completedFids)
      : eligibleFids

    const summary = {
      status: delivery === 'preview' ? 'preview' : 'ready',
      department,
      dateKey,
      delivery,
      itemCount: items.length,
      alertCount: alerts.length,
      deviceCount: eligibleFids.length,
      pendingDeviceCount: fids.length,
      notification,
    }
    if (delivery === 'preview') return summary

    if (tracksDailyRun) {
      await db.collection('ppePublicAlerts').doc(department).set({
        schemaVersion: 1,
        department: department,
        dueDates: menuAlertDueDates,
        updatedAt: FieldValue.serverTimestamp(),
      })
    }

    if (!notification || eligibleFids.length === 0 || fids.length === 0) {
      if (['validate', 'test'].includes(delivery) && eligibleFids.length === 0) {
        throw new Error(
          `${employeeId} is not an active ${department} PPE recipient: `
          + 'an enabled profile and a registered APK bound to this department are required.',
        )
      }
      const status = ppeDeliveryStatus({
        delivery,
        hasNotification: Boolean(notification),
        eligibleDeviceCount: eligibleFids.length,
        retryableFailureCount: 0,
      })
      await updateDailyRun(db, run, {
        status,
        alertCount: alerts.length,
        deviceCount: eligibleFids.length,
        completedDeviceCount: completedFids.size,
        completedFids: [...completedFids],
        finishedAt: FieldValue.serverTimestamp(),
      })
      return { ...summary, status }
    }

    let successCount = 0
    let failureCount = 0
    const invalidFids = []
    for (const batchFids of chunks(fids, MAX_MULTICAST_SIZE)) {
      const response = await messaging.sendEachForMulticast(
        messageFor(notification, batchFids, dateKey),
        delivery === 'validate',
      )
      successCount += response.successCount
      failureCount += response.failureCount
      response.responses.forEach((result, index) => {
        if (result.success) {
          completedFids.add(batchFids[index])
        } else if (INVALID_INSTALLATION_ERRORS.has(result.error?.code)) {
          invalidFids.push(batchFids[index])
          completedFids.add(batchFids[index])
        }
      })
      if (tracksDailyRun) {
        await updateDailyRun(db, run, {
          status: 'running',
          completedDeviceCount: completedFids.size,
          completedFids: [...completedFids],
          lastProgressAt: FieldValue.serverTimestamp(),
        })
      }
    }

    if (delivery !== 'validate' && invalidFids.length) {
      // Две записи на установку: подразделение и переходное зеркало.
      for (const cleanupFids of chunks(invalidFids, MAX_MULTICAST_SIZE / 2)) {
        const cleanup = db.batch()
        for (const fid of cleanupFids) {
          const data = {
            active: false,
            disabledAt: FieldValue.serverTimestamp(),
            disabledReason: 'firebase-installation-not-registered',
          }
          if (department === 'ovb1') cleanup.set(db.collection('ppePushDevices').doc(fid), data, { merge: true })
          cleanup.set(departmentRef.collection('devices').doc(fid), data, { merge: true })
        }
        await cleanup.commit()
      }
    }

    const retryableFailureCount = tracksDailyRun
      ? Math.max(0, failureCount - invalidFids.length)
      : failureCount
    const status = ppeDeliveryStatus({
      delivery,
      hasNotification: true,
      eligibleDeviceCount: eligibleFids.length,
      retryableFailureCount,
    })
    await updateDailyRun(db, run, {
      status,
      alertCount: alerts.length,
      deviceCount: eligibleFids.length,
      attemptedDeviceCount: fids.length,
      completedDeviceCount: completedFids.size,
      completedFids: [...completedFids],
      successCount,
      failureCount,
      retryableFailureCount,
      invalidDeviceCount: invalidFids.length,
      finishedAt: FieldValue.serverTimestamp(),
    })
    logger.info?.('PPE notification job finished', {
      dateKey,
      delivery,
      alertCount: alerts.length,
      deviceCount: eligibleFids.length,
      attemptedDeviceCount: fids.length,
      successCount,
      failureCount,
      retryableFailureCount,
    })
    return {
      ...summary,
      status,
      successCount,
      failureCount,
      retryableFailureCount,
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
