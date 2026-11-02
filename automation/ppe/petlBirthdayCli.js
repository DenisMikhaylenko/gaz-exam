import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { cert, deleteApp, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getMessaging } from 'firebase-admin/messaging'
import { runPetlBirthdayNotifications } from './runPetlBirthdayNotifications.js'

const args = process.argv.slice(2)
function option(name, fallback = '') {
  const index = args.indexOf(name)
  return index < 0 ? fallback : String(args[index + 1] || '').trim()
}
const delivery = option('--mode', process.env.BIRTHDAY_MODE || 'preview')
const dateKey = option('--date', process.env.BIRTHDAY_DATE || '')
const installationId = option('--installation', process.env.BIRTHDAY_INSTALLATION || '')
const accountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  || await readFile(resolve(option('--service-account', '.firebase-service-account.json')), 'utf8')
const account = JSON.parse(accountJson)
if (account.project_id !== 'gazenergoexam') throw new Error('Unexpected Firebase project.')
const app = initializeApp({ credential: cert(account), projectId: account.project_id }, 'petl-birthday-cli')
try {
  const result = await runPetlBirthdayNotifications({
    db: getFirestore(app), messaging: delivery === 'preview' ? null : getMessaging(app),
    dateKey, delivery, installationId,
    source: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local-cli',
  })
  // Public Actions logs must not contain employee names, birth dates or phone identifiers.
  if (process.env.GITHUB_ACTIONS === 'true') {
    const { title, body, ...counts } = result
    console.log(JSON.stringify(counts, null, 2))
  } else console.log(JSON.stringify(result, null, 2))
  if (['partial', 'failed'].includes(result.status)) process.exitCode = 1
} finally {
  await deleteApp(app)
}
