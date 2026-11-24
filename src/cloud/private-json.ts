import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Windows refuses directory fsync, and this machine also refuses some file fsyncs. The bytes are already written. */
export function isOptionalDurabilityError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EINVAL' || code === 'ENOTSUP'
}

/** Publish a flushed private checkpoint atomically; never expose a torn JSON file. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID()
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(value))
      try {
        await file.sync()
      } catch (error) {
        if (!isOptionalDurabilityError(error)) throw error
      }
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    if (process.platform === 'win32') return
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } catch (error) {
      if (!isOptionalDurabilityError(error)) throw error
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temporary, { force: true })
  }
}
