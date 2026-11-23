import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudBinding } from '../src/session-runtime/binding-store.js'

const calls = vi.hoisted(() => ({
  boot: vi.fn(async () => undefined),
  request: vi.fn(async (_sandbox: unknown, _token: string, command: string) => (
    command === 'open' ? { url: 'https://preview.example/session' } : { ok: true, command }
  )),
  wait: vi.fn(async () => undefined),
  reader: vi.fn(),
}))

vi.mock('../src/cloud/bootstrap.js', () => ({
  bootCloudHost: calls.boot,
  cloudRequest: calls.request,
  waitForCloudHost: calls.wait,
}))
vi.mock('../src/web/divergence.js', () => ({ divergenceReader: calls.reader }))

import { BlaxelCloudHostProvider } from '../src/cloud-host/blaxel-adapter.js'
import { toCloudHostState } from '../src/cloud-host/provider.js'

const binding: CloudBinding = {
  phase: 'preparing',
  controlToken: 'token-1',
  initialSeq: 1,
  initialHash: 'hash',
  localOrigin: 'http://127.0.0.1:3000',
  continueTask: false,
}

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

function provider() {
  const sandbox = { process: { get: vi.fn(async () => ({ status: 'running' })) } }
  const runtime = {
    name: 'dsh-abc',
    cwd: '/workspace/app',
    workspaceRoot: '/workspace',
    phase: 'ready' as 'creating' | 'restoring' | 'ready' | 'failed',
    getSandbox: vi.fn(async () => sandbox),
  }
  const prepared = { snapshot: { repoRoot: '/repo' }, runtime }
  const sessions = {
    prepare: vi.fn(async () => prepared),
    discard: vi.fn(async () => undefined),
    bind: vi.fn(async () => ({ runtime, workspace: 'ws' })),
    reconnect: vi.fn(async (): Promise<'ready' | 'missing'> => 'ready'),
    get: vi.fn((): { runtime: { phase: 'creating' | 'restoring' | 'ready' | 'failed' } } | undefined => ({ runtime })),
    binding: vi.fn((): { cloud: CloudBinding; sessionId: string; sandboxName: string; sourceRoot: string } | undefined => ({ cloud: binding, sessionId: 'session-1', sandboxName: 'dsh-abc', sourceRoot: '/repo' })),
    cloudOwner: vi.fn((id: string) => id === 'child-1' ? 'session-1' : undefined),
    status: vi.fn(async () => ({ sandboxes: [{ sessionId: 'session-1', state: 'ready', cloud: { phase: 'remote' as const } }] })),
    close: vi.fn(async () => undefined),
    updateCloud: vi.fn(),
    cloudProgress: vi.fn(),
  }
  return { host: new BlaxelCloudHostProvider(sessions as never), sessions, runtime, sandbox, prepared }
}

describe('CloudHostProvider', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('keeps the vendor SDK out of the contract and the handoff orchestrator', () => {
    const contract = source('../src/cloud-host/provider.ts')
    const handoff = source('../src/cloud.ts')
    const adapter = source('../src/cloud-host/blaxel-adapter.ts')
    expect(contract).not.toContain('@blaxel/core')
    expect(contract).not.toContain('SandboxInstance')
    expect(handoff).not.toContain('@blaxel/core')
    expect(handoff).not.toContain('SandboxInstance')
    expect(handoff).not.toContain('cloud/bootstrap')
    expect(handoff).not.toContain('getSandbox')
    expect(handoff).not.toMatch(/this\.ctx\.blaxelSessions\./)
    const web = source('../src/web.ts')
    expect(web).not.toContain('blaxelSessions.status')
    expect(web).toContain('cloudHostProvider')
    expect(web).toContain('attachHost')
    expect(web).toContain('.status()')
    expect(web).toContain('settingsStatus')
    expect(web).toContain('blaxelSessions.reconnect')
    expect(adapter).not.toContain("from '@blaxel/core'")
    expect(adapter).toContain('bootCloudHost')
    expect(adapter).toContain('sessions.prepare')
    expect(adapter).toContain('sessions.reconnect')
    expect(adapter).toContain('sessions.close')
    expect(adapter).toContain('sessions.binding')
    expect(adapter).toContain('sessions.cloudOwner')
    expect(adapter).toContain('sessions.status')
  })

  it('maps runtime phases onto host state', () => {
    expect(toCloudHostState('creating')).toBe('preparing')
    expect(toCloudHostState('restoring')).toBe('preparing')
    expect(toCloudHostState('ready')).toBe('ready')
    expect(toCloudHostState('failed')).toBe('failed')
    expect(toCloudHostState('missing')).toBe('gone')
  })

  it('creates a full remote host and binds it without changing the session id', async () => {
    const { host, sessions, prepared, sandbox } = provider()
    const created = await host.createHost('/work')
    expect(sessions.prepare).toHaveBeenCalledWith('/work', 'move', true)
    expect(created.snapshot.repoRoot).toBe('/repo')
    expect(created.workspaceRoot).toBe('/workspace')
    const bound = await host.bindHost(created, 'session-1', 'Title', binding)
    expect(sessions.bind).toHaveBeenCalledWith(prepared, 'session-1', 'Title', binding)
    expect(bound.sessionId).toBe('session-1')
    expect(bound.name).toBe('dsh-abc')
    await host.bootAgent(bound, { session: { meta: { cwd: bound.cwd } } } as never, { model: 'm' }, { DSH_BLAXEL_CONTROL_TOKEN: 'token-1' })
    expect(calls.boot).toHaveBeenCalledWith(sandbox, expect.anything(), { model: 'm' }, { DSH_BLAXEL_CONTROL_TOKEN: 'token-1' })
    await host.waitReady(bound)
    await host.startAgent(bound)
    const opened = await host.openPreview(bound)
    expect(opened.url).toBe('https://preview.example/session')
    expect(calls.request.mock.calls.map(call => call[2])).toEqual(['start', 'open'])
    expect(calls.request.mock.calls.every(call => call[1] === 'token-1')).toBe(true)
    expect(sessions.prepare).toHaveBeenCalledOnce()
  })

  it('attaches an existing host without snapshotting', async () => {
    const { host, sessions } = provider()
    await expect(host.attachHost('session-1')).resolves.toEqual({ attachment: 'ready', state: 'ready' })
    sessions.get.mockReturnValueOnce({ runtime: { phase: 'creating' } })
    await expect(host.attachHost('session-1')).resolves.toEqual({ attachment: 'ready', state: 'preparing' })
    sessions.get.mockReturnValueOnce({ runtime: { phase: 'failed' } })
    await expect(host.attachHost('session-1')).resolves.toEqual({ attachment: 'ready', state: 'failed' })
    sessions.get.mockReturnValueOnce(undefined)
    await expect(host.attachHost('session-1')).resolves.toEqual({ attachment: 'ready', state: 'failed' })
    sessions.reconnect.mockResolvedValueOnce('missing')
    await expect(host.attachHost('session-1')).resolves.toEqual({ attachment: 'missing', state: 'gone' })
    expect(sessions.prepare).not.toHaveBeenCalled()
  })

  it('reads bindings and ownership without calling the sandbox', async () => {
    const { host, sessions } = provider()
    expect(host.binding('session-1')).toMatchObject({ sandboxName: 'dsh-abc', cloud: { phase: 'preparing' } })
    expect(host.cloudOwner('child-1')).toBe('session-1')
    expect(host.cloudOwner('session-1')).toBeUndefined()
    sessions.binding.mockReturnValueOnce(undefined)
    expect(host.binding('local')).toBeUndefined()
    expect(sessions.prepare).not.toHaveBeenCalled()
    expect(sessions.reconnect).not.toHaveBeenCalled()
  })

  it('probes host status without snapshotting or reading settings', async () => {
    const { host, sessions } = provider()
    const report = { sandboxes: [{ sessionId: 'session-1', state: 'ready' as const, cloud: { phase: 'remote' as const } }] }
    sessions.status.mockResolvedValueOnce(report)
    await expect(host.status()).resolves.toBe(report)
    expect(sessions.prepare).not.toHaveBeenCalled()
    expect(sessions.reconnect).not.toHaveBeenCalled()
  })

  it('treats a missing remote process as not running and other lookup failures as errors', async () => {
    const { host, sessions, sandbox } = provider()
    const connected = host.connect('session-1', 'missing')
    await expect(host.agentRunning(connected)).resolves.toBe(true)
    sandbox.process.get.mockRejectedValueOnce(new Error('status 404: process not found'))
    await expect(host.agentRunning(connected)).resolves.toBe(false)
    sandbox.process.get.mockRejectedValueOnce(new Error('status 500'))
    await expect(host.agentRunning(connected)).rejects.toThrow('status 500')
    expect(sessions.prepare).not.toHaveBeenCalled()
  })

  it('refuses an oversize review patch and hashes the baseline text', async () => {
    const { host } = provider()
    calls.reader.mockReturnValue({
      read: async () => ({ available: true, divergence: { changed: 1, files: [], truncated: false, checkedAt: 't' } }),
      patch: async () => ({ text: 'patch', truncated: false }),
    })
    const review = await host.review('session-1')
    expect(review.reviewHash).toBe(createHash('sha256').update('patch').digest('hex'))
    expect(review.patch).toBe('patch')
    calls.reader.mockReturnValue({
      read: async () => ({ available: true, divergence: { changed: 1, files: [], truncated: true, checkedAt: 't' } }),
      patch: async () => ({ text: 'too-big', truncated: true }),
    })
    await expect(host.review('session-1')).rejects.toThrow('The changes exceed the automatic 1 MiB patch limit')
    calls.reader.mockReturnValue({ read: async () => ({ available: false, reason: 'baseline missing' }) })
    await expect(host.review('session-1')).rejects.toThrow('baseline missing')
  })

  it('freezes and releases through the same host handle', async () => {
    const { host, runtime, sandbox } = provider()
    const connected = host.connect('session-1', 'Reconnect the cloud session before returning it')
    await host.freeze(connected)
    await host.releaseFreeze(connected)
    expect(runtime.getSandbox).toHaveBeenCalledTimes(2)
    expect(calls.request.mock.calls.map(call => [call[0], call[1], call[2]])).toEqual([
      [sandbox, 'token-1', 'freeze'],
      [sandbox, 'token-1', 'release'],
    ])
  })

  it('deletes and records phase through the session runtime', async () => {
    const { host, sessions } = provider()
    await host.deleteHost('session-1')
    host.updateBinding('session-1', { ...binding, phase: 'returning' })
    host.reportProgress('host', 'Cloud setup failed')
    expect(sessions.close).toHaveBeenCalledWith('session-1')
    expect(sessions.updateCloud).toHaveBeenCalledWith('session-1', { ...binding, phase: 'returning' })
    expect(sessions.cloudProgress).toHaveBeenCalledWith('host', 'Cloud setup failed')
  })
})
