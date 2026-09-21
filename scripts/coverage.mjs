import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Keep coverage reports and Node's temporary coverage files inside the repository.
const directory = path.resolve('coverage')
mkdirSync(directory, { recursive: true })
const tests = readdirSync('test')
  .filter((file) => file.endsWith('.test.cjs'))
  .map((file) => path.join('test', file))

// Collect source-mapped coverage once, with console, text, and LCOV outputs.
const result = spawnSync(
  process.execPath,
  [
    '--enable-source-maps',
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-include=src/**',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    '--test-reporter-destination=coverage/lcov.info',
    ...tests,
  ],
  {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
  },
)
// Reuse console output for the text artifact without attaching a third test reporter.
writeFileSync(path.join(directory, 'summary.txt'), result.stdout ?? '')
process.stdout.write(result.stdout ?? '')
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

// Fail rather than publish a misleading report if source maps omit a source file.
const report = readFileSync(path.join(directory, 'lcov.info'), 'utf8')
const coveredFiles = new Set()
for (const record of report.split('end_of_record')) {
  const source = /^SF:(.+)$/m.exec(record)?.[1]
  if (!source) continue
  const filename = path.resolve(source)
  coveredFiles.add(filename)
  const lineCount = readFileSync(filename, 'utf8').split('\n').length
  for (const match of record.matchAll(/^DA:(\d+),/gm)) {
    assert.ok(
      Number(match[1]) <= lineCount,
      `Coverage exceeds source lines: ${source}`,
    )
  }
}
for (const file of readdirSync('src')) {
  if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
    assert.ok(
      coveredFiles.has(path.resolve('src', file)),
      `Missing source coverage: ${file}`,
    )
  }
}
console.log('Coverage source mapping verified; reports are in coverage/.')
