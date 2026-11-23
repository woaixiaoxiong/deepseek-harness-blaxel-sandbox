import type { CloudBinding, PersistedSandboxBinding } from '../session-runtime/binding-store.js'
import type { CloudSeed } from '../cloud-guest.js'
import type { DivergencePatch, DivergenceSummary } from '../web/divergence.js'
import type { LaunchProgress } from '../web/launch-progress.js'
import type { SnapshotMeta } from '../web/workspace-snapshot.js'

/**
 * Host seam for a swappable cloud machine. Handoff orchestration calls this
 * surface and does not import a vendor SDK.
 *
 * The first implementation is the Blaxel 0.1.4 adapter. It delegates to the
 * existing session runtime, sandbox runtime, and boot path. Move's transfer
 * transaction stays in `BlaxelCloudHandoff`.
 *
 * Host state (`preparing | ready | gone | failed`) is separate from the
 * binding phase (`preparing | remote | returning`).
 */

export type CloudHostState = 'preparing' | 'ready' | 'gone' | 'failed'

export type CloudBindingPhase = 'preparing' | 'remote' | 'returning'

/** Phases a 0.1.4 runtime reports, plus a lookup that found no host. */
export type ReportedHostPhase = 'creating' | 'restoring' | 'ready' | 'failed' | 'missing'

export function toCloudHostState(phase: ReportedHostPhase): CloudHostState {
  if (phase === 'missing') return 'gone'
  if (phase === 'creating' || phase === 'restoring') return 'preparing'
  if (phase === 'ready') return 'ready'
  return 'failed'
}

/** Payload the remote DSH process is booted with. The adapter adds the preview origin. */
export type CloudAgentSeed = Omit<CloudSeed, 'previewOrigin'>

/** Worktree snapshot already uploaded. Only the adapter that created it can bind or discard it. */
export interface PreparedCloudHost {
  readonly kind: 'prepared'
  readonly snapshot: { repoRoot: string }
  readonly workspaceRoot: string
}

/** One session's live host. Opaque to orchestration. */
export interface CloudSessionHandle {
  readonly sessionId: string
}

export interface BoundCloudHost extends CloudSessionHandle {
  readonly name: string
  readonly workspace: string
  readonly cwd: string
}

export interface AvailableBaseline {
  available: true
  divergence: DivergenceSummary
  patch: DivergencePatch
}

export type BaselineRead = AvailableBaseline | { available: false; reason: string }

/** One host row in the local status poll. Auth and settings are not part of this report. */
export interface CloudHostSessionStatus {
  sessionId: string
  title?: string
  workspace: string
  environment: 'production' | 'development'
  state: ReportedHostPhase
  sandbox: {
    name: string
    cwd: string
    workspaceRoot: string
    sourceCwd: string
    startedAt: string
    uptimeMs: number
    status?: string
    image?: string
    memory?: number
    region?: string
    ttl?: string
    createdAt?: string
    lastUsedAt?: string
    expiresIn?: number
  }
  provenance: SnapshotMeta
  live: { processes: number }
  error?: string
  cloud?: { phase: CloudBindingPhase }
}

export interface CloudHostReport {
  sandboxes: CloudHostSessionStatus[]
  progress?: LaunchProgress
}

export interface CloudHostProvider {
  /** Create a remote DSH host and snapshot the current worktree onto it. One launch at a time. */
  createHost(cwd: string): Promise<PreparedCloudHost>

  /** Delete a host that was created but not bound to a session. */
  discardPrepared(prepared: PreparedCloudHost): Promise<void>

  /** Persist session id → host name, workspace, paths, snapshot provenance, and phase. Session id is unchanged. */
  bindHost(prepared: PreparedCloudHost, sessionId: string, title: string | undefined, cloud: CloudBinding): Promise<BoundCloudHost>

  /** Attach an existing host. Does not upload a new snapshot. */
  attachHost(sessionId: string): Promise<{ attachment: 'ready' | 'missing'; state: CloudHostState }>

  /** Persisted binding for one session. Undefined when the session has no host. */
  binding(sessionId: string): PersistedSandboxBinding | undefined

  /** Cloud host that owns this session id, including a related child session. */
  cloudOwner(sessionId: string): string | undefined

  /** Probe known hosts. Does not upload a snapshot and does not extend host TTL. */
  status(): Promise<CloudHostReport>

  /** Resolve the in-memory host for a session. Fails closed when it is absent. */
  connect(sessionId: string, missing: string): CloudSessionHandle

  /** Boot the full remote DSH for this same session id. */
  bootAgent(host: CloudSessionHandle, seed: CloudAgentSeed, settings: Record<string, unknown>, env: Record<string, string>): Promise<void>

  /** Whether the remote DSH process is running. A missing process is not a host failure. */
  agentRunning(host: CloudSessionHandle): Promise<boolean>

  /** Wait until the remote DSH answers health. A remote failure is an error. */
  waitReady(host: CloudSessionHandle): Promise<void>

  /** Continue the transferred task on the remote host. */
  startAgent(host: CloudSessionHandle): Promise<void>

  /** Private preview URL. Opening does not extend host TTL and does not upload files. */
  openPreview(host: CloudSessionHandle): Promise<{ url: string }>

  /** Review surface against the immutable baseline. An oversize patch is refused. */
  review(sessionId: string): Promise<Record<string, unknown>>

  /** Re-read the baseline patch. The caller compares the hash before writing locally. */
  readBaseline(host: CloudSessionHandle): Promise<BaselineRead>

  /** Checkpoint the remote conversation before write-back. */
  freeze(host: CloudSessionHandle): Promise<Record<string, unknown>>

  /** Undo a freeze when local write-back did not apply. */
  releaseFreeze(host: CloudSessionHandle): Promise<void>

  /** Delete the remote host and clear its binding. Already-gone hosts are ignored. */
  deleteHost(sessionId: string): Promise<void>

  /** Record the binding phase. The binding stays until the local receipt is durable. */
  updateBinding(sessionId: string, cloud: CloudBinding): void

  /** Local launch progress for the originating window. */
  reportProgress(step: 'host' | 'ready', error?: string): void
}
