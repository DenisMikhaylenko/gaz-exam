import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { cert, deleteApp, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getMessaging } from 'firebase-admin/messaging'
import { resolveNotificationDate } from './notificationDate.js'
import { isOperationalJournalDay } from './operationalJournalNotifications.js'
import { runOperationalJournalReminder } from './runOperationalJournalReminder.js'

const EXPECTED_PROJECT_ID = 'gazenergoexam'
const args = process.argv.slice(2)

function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? String(args[index + 1] ?? '').trim() : ''
}

async function serviceAccount() {
  const json = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim()
  if (json) return JSON.parse(json)
  const configuredPath = option('--service-account')
    || String(process.env.JOURNAL_SERVICE_ACCOUNT_FILE || '').trim()
  if (!configuredPath) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured.')
  return JSON.parse(await readFile(resolve(configuredPath), 'utf8'))
}

const delivery = option('--mode') || String(process.env.JOURNAL_MODE || 'preview').trim()
const requestedDate = option('--date') || String(process.env.JOURNAL_DATE || '').trim()
const employeeId = option('--employee') || String(process.env.JOURNAL_EMPLOYEE || '').trim()
const dateKey = resolveNotificationDate({ delivery, requestedDate })

if (!['preview', 'validate', 'test', 'scheduled'].includes(delivery)) {
  throw new Error('Mode must be preview, validate, test or scheduled.')
}

// If GitHub starts a delayed job after midnight, do not send "Today is the 2nd" on the 3rd.
if (['preview', 'scheduled'].includes(delivery) && !isOperationalJournalDay(dateKey)) {
  console.log(JSON.stringify({ status: delivery === 'preview' ? 'preview' : 'skipped', date: dateKey, mode: delivery, reason: 'not-the-second-day' }))
  process.exit(0)
}

let app = null
try {
  let db = null
  let messaging = null
  if (delivery !== 'preview') {
    const account = await serviceAccount()
    if (account.project_id !== EXPECTED_PROJECT_ID) {
      throw new Error(`Firebase key belongs to another project: ${account.project_id || 'unknown'}.`)
    }
    app = initializeApp({ credential: cert(account) }, 'operational-journal-cli')
    db = getFirestore(app)
    messaging = getMessaging(app)
  }
  const result = await runOperationalJournalReminder({
    db,
    messaging,
    dateKey,
    delivery,
    employeeId,
    source: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local-cli',
  })
  console.log(JSON.stringify({
    status: result.status,
    date: result.dateKey,
    mode: result.delivery,
    employee: result.employeeId || '',
    devices: result.deviceCount ?? '',
    topic: result.topic,
    title: result.notification?.title || '',
    body: result.notification?.body || '',
    messageId: result.messageId || '',
    successCount: result.successCount ?? '',
    failureCount: result.failureCount ?? '',
  }, null, 2))
  if (['partial', 'failed'].includes(result.status)) process.exitCode = 1
} finally {
  if (app) await deleteApp(app)
}
