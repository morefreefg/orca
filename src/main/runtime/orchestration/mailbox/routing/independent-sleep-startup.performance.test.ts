import { expect, it, vi } from 'vitest'
import SyncDatabase from '../../../../sqlite/sync-database'
import { performance } from 'node:perf_hooks'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../../db/orchestration-db'

it.each([10000, 100000])('cold sleep-mail schema on %i historical messages', (n) => {
  const directory = mkdtempSync(join(tmpdir(), 'sleep-mail-perf-'))
  const path = join(directory, 'orchestration.db')
  let db: OrchestrationDb | undefined
  try {
    db = new OrchestrationDb(path)
    // Prior-head shape: current schema without the newly added table/index; mostly read history.
    db.db.exec(`DROP INDEX IF EXISTS idx_messages_mail_wake_candidate;
      DROP TABLE IF EXISTS mail_wake_attempts;
      WITH RECURSIVE rows(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM rows WHERE i < ${n})
      INSERT INTO messages(id, from_handle, to_handle, subject, body, read, delivery_contract)
      SELECT 'historic-' || i, 'worker', 'dispatch:history-' || (i % 1000), 'history',
        replace(hex(zeroblob(512)), '0', 'x'), CASE WHEN i % 100 = 0 THEN 0 ELSE 1 END,
        CASE WHEN i % 2 = 0 THEN 'current_delivery' ELSE 'legacy_direct' END FROM rows;`)
    db.close(); db = undefined
    const bytes = statSync(path).size
    const indexDdl: number[] = []
    const realExec = SyncDatabase.prototype.exec
    const indexProbe = vi.spyOn(SyncDatabase.prototype, 'exec').mockImplementation(function(this: SyncDatabase, sql: string) {
      if (!sql.includes('CREATE INDEX IF NOT EXISTS idx_messages_mail_wake_candidate')) return realExec.call(this, sql)
      const start = performance.now()
      try { return realExec.call(this, sql) } finally { indexDdl.push(performance.now() - start) }
    })
    const start = performance.now()
    db = new OrchestrationDb(path)
    const coldOpenMs = performance.now() - start
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(n)
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM mail_wake_attempts').get()?.n).toBe(0)
    const plan = db.db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM messages INDEXED BY idx_messages_mail_wake_candidate
      WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL AND pointer_enter_pending = 0
      AND delivery_contract = 'current_delivery'`).all('dispatch:history-0')
    expect(plan.some((row) => String(row.detail).includes('idx_messages_mail_wake_candidate'))).toBe(true)
    const newIndexDdlMs = indexDdl.reduce((sum, value) => sum + value, 0)
    const newIndexDdlCalls = indexDdl.length
    db.close(); db = undefined
    indexDdl.length = 0
    const warmStart = performance.now()
    db = new OrchestrationDb(path)
    const existingSchemaOpenMs = performance.now() - warmStart
    const existingIndexDdlMs = indexDdl.reduce((sum, value) => sum + value, 0)
    indexProbe.mockRestore()
    console.log('BENCH cold-schema', JSON.stringify({ head: 'd1eb8c9d8b9bbf06803f667085d2c942b8c26a32', messages: n, bytes, coldOpenMs, newIndexDdlMs, newIndexDdlCalls, existingSchemaOpenMs, existingIndexDdlMs, plan }))
  } finally { vi.restoreAllMocks(); db?.close(); rmSync(directory, { recursive: true, force: true }) }
}, 120000)
