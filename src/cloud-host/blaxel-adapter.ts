import { createHash } from 'node:crypto'
import { bootCloudHost, cloudRequest, waitForCloudHost } from '../cloud/bootstrap.js'
import type { CloudBinding } from '../session-runtime/binding-store.js'
import { BlaxelSessionRuntime } from '../session-runtime/service.js'
import { divergenceReader } from '../web/divergence.js'
import {
  toCloudHostState,
  type BaselineRead,
  type BoundCloudHost,
  type CloudAgentSeed,
  type CloudHostProvider,
  type CloudHostState,
  type CloudSessionHandle,
  type PreparedCloudHost,
} from './provider.js'

type PreparedSandbox = Awaited<ReturnType<BlaxelSessionRuntime['prepare']>>
type SessionRuntime = Awaited<ReturnType<BlaxelSessionRuntime['bind']>>['runtime']

/**
 * Blaxel 0.1.4 host adapter.
 *
 * Delegates create, attach, bind, and delete to `BlaxelSessionRuntime`,
 * sandbox access to `BlaxelRuntime`, and boot / preview / freeze to the
 * existing 0.1.4 helpers. `@blaxel/core` stays in those modules.
 * Tool-only filesystem attachment is not this provider.
 */
class BlaxelPreparedHost implements PreparedCloudHost {
  readonly kind = 'prepared' as const
  constructor(readonly inner: PreparedSandbox) {}

  get snapshot(): PreparedCloudHost['snapshot'] {
    return this.inner.snapshot
  }

  get workspaceRoot(): string {
    return this.inner.runtime.workspaceRoot
  }
}

class BlaxelConnectedHost implements CloudSessionHandle {
  constructor(readonly sessionId: string, readonly runtime: SessionRuntime) {}
}

class BlaxelBoundHost extends BlaxelConnectedHost implements BoundCloudHost {
  constructor(sessionId: string, runtime: SessionRuntime, readonly workspace: string) {
    super(sessionId, runtime)
  }

  get name(): string {
    return this.runtime.name
  }

  get cwd(): string {
    return this.runtime.cwd
  }
}

export class BlaxelCloudHostProvider implements CloudHostProvider {
  constructor(private readonly sessions: BlaxelSessionRuntime) {}

  async createHost(cwd: string): Promise<PreparedCloudHost> {
    // `true` opens the private DSH port. This is a full remote host, not a tool-only attachment.
    return new BlaxelPreparedHost(await this.sessions.prepare(cwd, 'move', true))
  }

  async discardPrepared(prepared: PreparedCloudHost): Promise<void> {
    await this.sessions.discard(this.prepared(prepared))
  }

  async bindHost(prepared: PreparedCloudHost, sessionId: string, title: string | undefined, cloud: CloudBinding): Promise<BoundCloudHost> {
    const session = await this.sessions.bind(this.prepared(prepared), sessionId, title, cloud)
    return new BlaxelBoundHost(sessionId, session.runtime, session.workspace)
  }

  async attachHost(sessionId: string): Promise<{ attachment: 'ready' | 'missing'; state: CloudHostState }> {
    const attachment = await this.sessions.reconnect(sessionId)
    if (attachment === 'missing') return { attachment, state: 'gone' }
    const phase = this.sessions.get(sessionId)?.runtime.phase ?? 'failed'
    return { attachment, state: toCloudHostState(phase) }
  }

  connect(sessionId: string, missing: string): CloudSessionHandle {
    const remote = this.sessions.get(sessionId)
    if (remote === undefined) throw new Error(missing)
    return new BlaxelConnectedHost(sessionId, remote.runtime)
  }

  async bootAgent(host: CloudSessionHandle, seed: CloudAgentSeed, settings: Record<string, unknown>, env: Record<string, string>): Promise<void> {
    await bootCloudHost(await this.sandbox(host), seed, settings, env)
  }

  async agentRunning(host: CloudSessionHandle): Promise<boolean> {
    const sandbox = await this.sandbox(host)
    try {
      return (await sandbox.process.get('dsh-cloud-host')).status === 'running'
    } catch (error) {
      if (!(error instanceof Error) || !/status 404: process not found/.test(error.message)) throw error
      return false
    }
  }

  async waitReady(host: CloudSessionHandle): Promise<void> {
    await waitForCloudHost(await this.sandbox(host), this.controlToken(host))
  }

  async startAgent(host: CloudSessionHandle): Promise<void> {
    await cloudRequest(await this.sandbox(host), this.controlToken(host), 'start')
  }

  async openPreview(host: CloudSessionHandle): Promise<{ url: string }> {
    const result = await cloudRequest(await this.sandbox(host), this.controlToken(host), 'open')
    if (typeof result.url !== 'string') throw new Error('The cloud session did not provide its browser address')
    return { url: result.url }
  }

  async review(sessionId: string): Promise<Record<string, unknown>> {
    const read = await this.readBaseline(this.connect(sessionId, 'Reconnect the sandbox before reviewing its changes'))
    if (!read.available) throw new Error(read.reason)
    if (read.patch.truncated) throw new Error('The changes exceed the automatic 1 MiB patch limit')
    return {
      divergence: read.divergence,
      patch: read.patch.text,
      reviewHash: createHash('sha256').update(read.patch.text).digest('hex'),
    }
  }

  async readBaseline(host: CloudSessionHandle): Promise<BaselineRead> {
    const reader = divergenceReader(this.connected(host).runtime)
    const report = await reader.read()
    if (!report.available) return report
    return { available: true, divergence: report.divergence, patch: await reader.patch() }
  }

  async freeze(host: CloudSessionHandle): Promise<Record<string, unknown>> {
    return await cloudRequest(await this.sandbox(host), this.controlToken(host), 'freeze')
  }

  async releaseFreeze(host: CloudSessionHandle): Promise<void> {
    await cloudRequest(await this.sandbox(host), this.controlToken(host), 'release')
  }

  async deleteHost(sessionId: string): Promise<void> {
    await this.sessions.close(sessionId)
  }

  updateBinding(sessionId: string, cloud: CloudBinding): void {
    this.sessions.updateCloud(sessionId, cloud)
  }

  reportProgress(step: 'host' | 'ready', error?: string): void {
    this.sessions.cloudProgress(step, error)
  }

  private prepared(host: PreparedCloudHost): PreparedSandbox {
    if (!(host instanceof BlaxelPreparedHost)) throw new Error('This prepared host belongs to a different cloud provider')
    return host.inner
  }

  private connected(host: CloudSessionHandle): BlaxelConnectedHost {
    if (!(host instanceof BlaxelConnectedHost)) throw new Error('This cloud host belongs to a different provider')
    return host
  }

  private controlToken(host: CloudSessionHandle): string {
    const cloud = this.sessions.binding(this.connected(host).sessionId)?.cloud
    if (cloud === undefined) throw new Error('Reconnect the cloud sandbox before opening the session')
    return cloud.controlToken
  }

  private async sandbox(host: CloudSessionHandle) {
    return await this.connected(host).runtime.getSandbox()
  }
}

export function cloudHostProvider(ctx: { blaxelSessions: BlaxelSessionRuntime }): CloudHostProvider {
  return new BlaxelCloudHostProvider(ctx.blaxelSessions)
}
