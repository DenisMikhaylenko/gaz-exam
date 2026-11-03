export const NOTIFICATION_DEPARTMENTS = Object.freeze({
  ovb1: 'ОВБ-1', ovb2: 'ОВБ-2', petl: 'ПЭТЛ',
})

export function notificationDepartmentLabel(department) {
  const label = NOTIFICATION_DEPARTMENTS[department]
  if (!label) throw new Error(`Unknown notification department: ${department}`)
  return label
}

function records(snapshot) {
  return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }))
}

function merge(legacy, scoped, department, newest = false) {
  // A scoped profile/device is authoritative, including an explicit revocation.
  const rows = new Map()
  const time = row => row?.updatedAt?.toMillis?.() ?? (Date.parse(row?.updatedAt) || 0)
  for (const row of [...records(legacy), ...records(scoped)]) {
    if ((row.department || 'ovb1') !== department || row.placeholder) continue
    if (!newest || !rows.has(row.id) || time(row) >= time(rows.get(row.id))) rows.set(row.id, row)
  }
  return [...rows.values()]
}

export async function loadDepartmentPpeData(db, department) {
  notificationDepartmentLabel(department)
  const root = db.collection('ppeDepartments').doc(department)
  const config = await root.get()
  const enabled = config.exists
    ? config.data().active === true && config.data().ppeEnabled === true
    : department === 'ovb1' // Existing OVB-1 APKs precede departmental migration.
  if (!enabled) return { enabled: false, items: [], users: [], devices: [], installations: [] }

  const empty = { docs: [] }
  const [legacyItems, items, legacyUsers, users, legacyDevices, devices] = await Promise.all([
    department === 'ovb1' ? db.collection('ppeItems').get() : empty,
    root.collection('items').get(),
    department === 'ovb1' ? db.collection('users').where('department', '==', department).get() : empty,
    root.collection('users').get(),
    department === 'ovb1' ? db.collection('ppePushDevices').get() : empty,
    root.collection('devices').get(),
  ])
  const ownDevices = merge(legacyDevices, devices, department)
  const installations = []
  // Read the binding by FID even when it now belongs to another department.
  for (let offset = 0; offset < ownDevices.length; offset += 500) {
    const refs = ownDevices.slice(offset, offset + 500)
      .map(device => db.collection('ppeInstallations').doc(device.id))
    const snapshots = await db.getAll(...refs)
    installations.push(...snapshots.filter(doc => doc.exists).map(doc => ({ ...doc.data(), id: doc.id })))
  }
  return {
    enabled: true,
    items: merge(legacyItems, items, department, true),
    users: merge(legacyUsers, users, department),
    devices: ownDevices,
    installations,
  }
}
// APKs advertising birthdays also include PushDepartmentPolicy. Send their
// work reminders as data-only so Android rechecks the recipient after delivery,
// including messages queued before the user switched departments. Legacy APKs
// keep the notification payload they already support.
export function departmentDeliveryBatches(fids, devices, installations, department) {
  const capable = new Set([...devices, ...installations]
    .filter(device => device.birthdayNotificationsVersion === 1)
    .map(device => device.installationId))
  const groups = [false, true].map(guarded => ({ guarded, fids: fids.filter(fid =>
    (department !== 'ovb1' || capable.has(fid)) === guarded) }))
  return groups.flatMap(group => {
    const batches = []
    for (let offset = 0; offset < group.fids.length; offset += 500) {
      batches.push({ guarded: group.guarded, fids: group.fids.slice(offset, offset + 500) })
    }
    return batches
  })
}

export function withDepartmentDelivery(message, guarded) {
  if (!guarded) return message
  const { notification: _notification, android, ...rest } = message
  const { notification: _androidNotification, ...androidData } = android || {}
  return { ...rest, android: androidData }
}
