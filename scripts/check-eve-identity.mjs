// One-off: inspect Eve's (modalityId='friend') current ModalityIdentity row for
// leftover Sage-era text, before deciding whether mode=reset needs to also touch
// aboutUserFacet (the reseed endpoint only resets aboutSelf).
import { createClient } from '@libsql/client'
import 'dotenv/config'

const url = process.env.DATABASE_URL
const authToken = process.env.TURSO_AUTH_TOKEN

const db = createClient({ url, authToken })

const res = await db.execute({
  sql: `SELECT profileId, aboutSelf, aboutSelfUpdatedAt, aboutUserFacet, aboutUserFacetUpdatedAt
        FROM ModalityIdentity WHERE modalityId = 'friend'`,
  args: [],
})

if (res.rows.length === 0) {
  console.log('No ModalityIdentity row for friend/Eve yet.')
} else {
  for (const row of res.rows) {
    console.log(`\n=== profileId: ${row.profileId} ===`)
    console.log('--- aboutSelf ---')
    console.log(row.aboutSelf ?? '(null)')
    console.log(`updatedAt: ${row.aboutSelfUpdatedAt ?? '(null)'}`)
    console.log('\n--- aboutUserFacet ---')
    console.log(row.aboutUserFacet ?? '(null)')
    console.log(`updatedAt: ${row.aboutUserFacetUpdatedAt ?? '(null)'}`)

    const haystack = `${row.aboutSelf ?? ''} ${row.aboutUserFacet ?? ''}`
    console.log(`\nContains "Sage"? ${/sage/i.test(haystack)}`)
  }
}
