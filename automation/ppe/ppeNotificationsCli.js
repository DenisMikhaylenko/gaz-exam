import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { cert, deleteApp, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getMessaging } from 'firebase-admin/messaging'
import { dateKeyInTimeZone } from './ppeNotifications.js'
import { runPpeNotifications } from './runPpeNotifications.js'

const EXPECTED_PROJECT_ID = 'gazenergoexam'
const TIME_ZONE = 'Asia/Yekaterinburg'
const args = process.argv.slice(2)

function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? String(args[index + 1] ?? '').trim() : ''
}

async function serviceAccount() {
  const json = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim()
  if (json) return JSON.parse(json)

  const configuredPath = option('--service-account')
    || String(process.env.PPE_SERVICE_ACCOUNT_FILE || '').trim()
  if (!configuredPath) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured.')
  }
  return JSON.parse(await readFile(resolve(configuredPath), 'utf8'))
}

const delivery = option('--mode') || String(process.env.PPE_MODE || 'preview').trim()
const employeeId = option('--employee') || String(process.env.PPE_EMPLOYEE || '').trim()
const requestedDate = option('--date') || String(process.env.PPE_DATE || '').trim()
const dateKey = requestedDate || dateKeyInTimeZone(new Date(), TIME_ZONE)

if (!['preview', 'validate', 'test', 'scheduled'].includes(delivery)) {
  throw new Error('Mode must be preview, validate, test or scheduled.')
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
  throw new Error('Date must use the YYYY-MM-DD format.')
}

const account = await serviceAccount()
if (account.project_id !== EXPECTED_PROJECT_ID) {
  throw new Error(`Firebase key belongs to another project: ${account.project_id || 'unknown'}.`)
}

const app = initializeApp({ credential: cert(account) }, 'ppe-notifications-cli')
try {
  const result = await runPpeNotifications({
    db: getFirestore(app),
    messaging: getMessaging(app),
    dateKey,
    delivery,
    employeeId,
    source: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local-cli',
  })
  console.log(JSON.stringify({
    status: result.status,
    date: result.dateKey,
    mode: result.delivery || delivery,
    items: result.itemCount ?? 0,
    alerts: result.alertCount ?? 0,
    devices: result.deviceCount ?? 0,
    success: result.successCount ?? 0,
    failures: result.failureCount ?? 0,
    title: result.notification?.title || '',
    body: result.notification?.body || '',
  }, null, 2))
} finally {
  await deleteApp(app)
}
