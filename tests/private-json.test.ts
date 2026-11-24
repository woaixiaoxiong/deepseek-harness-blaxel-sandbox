import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writePrivateJson } from '../src/cloud/private-json.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('private json checkpoints', () => {
  it('publishes the checkpoint when Windows refuses directory fsync', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-blaxel-private-json-'))
    directories.push(directory)
    const path = join(directory, 'draft.json')
    await writePrivateJson(path, { ok: true })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ok: true })
  })
})
