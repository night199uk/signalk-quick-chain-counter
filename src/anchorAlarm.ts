/*
 * Copyright 2026 Signal K contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Drives an anchor alarm from the chain counter.
 *
 * Rather than reimplement anchor watch, this hands the chain length to an
 * anchor alarm that owns the drag alarm, the watch zone and the session log.
 * Hoeken's Anchor Alarm is the one this is built against; it registers the two
 * legacy action handlers used here:
 *
 *   navigation.anchor.position   PUT { latitude, longitude, radius } to drop
 *                                the anchor, or null to raise it
 *   navigation.anchor.maxRadius  PUT a number to resize the circle zone
 *
 * Calling them through the server rather than over HTTP means no port to
 * discover, no JWT to obtain and no dependency on the plugin being installed:
 * the server dispatches to whatever registered the handler, and answers 405
 * when nothing did.
 *
 * The source has to be named. The server records each handler under the
 * registering plugin's id, and a PUT with no source is rejected as ambiguous
 * once more than one anchor alarm is installed.
 */

import {
  ANCHOR_MAX_RADIUS_PATH,
  ANCHOR_POSITION_PATH
} from './decode'
import { VesselPosition } from './delta'

/** The plugin id the anchor alarm handlers are registered under by default. */
export const DEFAULT_ANCHOR_ALARM_SOURCE = 'hoekens-anchor-alarm'

/** Action handlers are registered against a context-qualified path. */
const SELF_CONTEXT = 'vessels.self'

export type AnchorAction =
  | { kind: 'drop'; position: VesselPosition; radius: number }
  | { kind: 'setRadius'; radius: number }
  | { kind: 'raise' }
  | { kind: 'none' }

export interface AnchorAlarmState {
  deployed: boolean
  radius?: number
}

export const IDLE: AnchorAlarmState = { deployed: false }

/** How many chain readings to wait for the alarm to publish its state. */
const INITIAL_STATE_ATTEMPTS = 5

function finiteRadius(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

/**
 * Read the anchor alarm's current state from the Signal K tree.
 *
 * Returns undefined until the alarm has published anything, so a plugin that
 * starts before the alarm can wait a frame instead of mistaking "not started
 * yet" for "no anchor down".
 */
export function readAnchorAlarmState(
  getSelfPath: (path: string) => unknown
): AnchorAlarmState | undefined {
  const state = getSelfPath('navigation.anchor.state.value')
  const position = getSelfPath('navigation.anchor.position.value')
  const maxRadius = getSelfPath('navigation.anchor.maxRadius.value')
  const watchZone = getSelfPath('navigation.anchor.watchZone.value')

  if (
    state === undefined &&
    position === undefined &&
    maxRadius === undefined &&
    watchZone === undefined
  ) {
    return undefined
  }

  const deployed =
    state === 'on' ||
    (state !== 'off' && typeof position === 'object' && position !== null)

  if (!deployed) {
    return { deployed: false }
  }

  const radius =
    finiteRadius(maxRadius) ??
    finiteRadius(
      typeof watchZone === 'object' && watchZone !== null
        ? (watchZone as { radius?: unknown }).radius
        : undefined
    )

  return radius === undefined ? { deployed: true } : { deployed: true, radius }
}

/**
 * Decide what the anchor alarm should do about one chain counter reading.
 *
 * As the chain spools out the watch zone grows with it, so the alarm tracks the
 * swinging room the boat actually has. Only the drop is an edge: once the
 * anchor is down, an operator raising it by hand is left alone until the chain
 * comes all the way in and goes out again.
 */
export function planAnchorAction(
  state: AnchorAlarmState,
  metres: number,
  position: VesselPosition | undefined,
  scope: number
): { action: AnchorAction; state: AnchorAlarmState } {
  if (!(metres > 0)) {
    return state.deployed
      ? { action: { kind: 'raise' }, state: { deployed: false } }
      : { action: { kind: 'none' }, state }
  }

  const radius = Math.round(metres * scope)

  if (!state.deployed) {
    // Cannot drop without knowing where the boat is; stay undeployed and try
    // again on the next frame rather than inventing a position.
    return position
      ? {
          action: { kind: 'drop', position, radius },
          state: { deployed: true, radius }
        }
      : { action: { kind: 'none' }, state }
  }

  if (radius !== state.radius) {
    return {
      action: { kind: 'setRadius', radius },
      state: { deployed: true, radius }
    }
  }

  return { action: { kind: 'none' }, state }
}

/** The slice of the server API needed to drive another plugin. */
export interface PutApp {
  putPath(
    path: string,
    value: unknown,
    updateCb: (err?: Error) => void,
    source: string
  ): Promise<unknown>
  debug(...args: unknown[]): void
  error(...args: unknown[]): void
}

interface Reply {
  statusCode?: number
  message?: string
}

/**
 * What came back from trying to drive the anchor alarm.
 *
 * - `ok`          the alarm accepted it
 * - `refused`     an alarm answered but would not (502) — worth retrying, the
 *                 boat may simply have no GPS fix yet
 * - `unavailable` nothing is listening (405), or the call threw — stop trying
 */
export type ApplyResult = 'ok' | 'refused' | 'unavailable'

export async function applyAnchorAction(
  app: PutApp,
  action: AnchorAction,
  source: string = DEFAULT_ANCHOR_ALARM_SOURCE
): Promise<ApplyResult> {
  if (action.kind === 'none') {
    return 'ok'
  }

  const path =
    action.kind === 'setRadius' ? ANCHOR_MAX_RADIUS_PATH : ANCHOR_POSITION_PATH

  const value =
    action.kind === 'drop'
      ? {
          latitude: action.position.latitude,
          longitude: action.position.longitude,
          // Hoeken's handler builds a circle zone out of this, so it has to be
          // present even though the anchor position itself does not need it.
          radius: action.radius
        }
      : action.kind === 'setRadius'
        ? action.radius
        : null

  try {
    const reply = (await app.putPath(
      `${SELF_CONTEXT}.${path}`,
      value,
      () => undefined,
      source
    )) as Reply
    const statusCode = reply?.statusCode
    if (statusCode === undefined || statusCode === 200) {
      app.debug(`anchor alarm: ${action.kind} on ${path}`)
      return 'ok'
    }
    if (statusCode === 405) {
      app.debug(`nothing handles ${path} for ${source}`)
      return 'unavailable'
    }
    app.debug(
      `anchor alarm refused ${action.kind} on ${path}: ${statusCode} ${reply.message ?? ''}`.trim()
    )
    return 'refused'
  } catch (error) {
    app.debug(
      `anchor alarm ${action.kind} on ${path} failed: ${(error as Error).message}`
    )
    return 'unavailable'
  }
}

/**
 * Reads the alarm's current state so the bridge can adopt an anchor that
 * survived a plugin or server restart instead of dropping a new one over it.
 * Omit it to keep the old "first positive reading is a drop" behaviour.
 */
export type InitialStateReader = () => AnchorAlarmState | undefined

/**
 * Tracks the anchor alarm's state and keeps it in step with the chain counter.
 *
 * Once nothing is listening the bridge stops trying, so a boat without an
 * anchor alarm is not making a doomed PUT on every frame.
 */
export class AnchorAlarmBridge {
  private state: AnchorAlarmState = IDLE
  private disabled = false
  /**
   * Set when the alarm says it has no anchor down even though we think one is.
   * That means somebody raised it by hand, so we stop nudging until the chain
   * comes all the way in and a new deployment is genuinely ours to make.
   */
  private paused = false
  private initialized = false
  private initAttempts = 0
  /**
   * False until the chain has been seen fully in. A plugin restart while the
   * counter holds a stale positive value must not look like a fresh drop.
   */
  private armed: boolean

  constructor(
    private readonly app: PutApp,
    private readonly scope: number,
    private readonly source: string = DEFAULT_ANCHOR_ALARM_SOURCE,
    private readonly readInitialState?: InitialStateReader
  ) {
    this.armed = readInitialState === undefined
  }

  isDisabled(): boolean {
    return this.disabled
  }

  private initialize(): boolean {
    if (this.initialized) {
      return true
    }

    if (!this.readInitialState) {
      this.initialized = true
      return true
    }

    const initial = this.readInitialState()
    if (initial === undefined) {
      // The alarm has not published its state yet (it may start after us), so
      // wait a few frames rather than treating silence as "no anchor down".
      this.initAttempts += 1
      if (this.initAttempts < INITIAL_STATE_ATTEMPTS) {
        return false
      }
    }

    this.initialized = true
    if (initial?.deployed) {
      this.state = initial
      this.paused = false
    } else {
      // Starting with no anchor: only a genuine 0 -> positive edge may drop.
      this.armed = false
    }
    return true
  }

  async update(
    metres: number,
    position: VesselPosition | undefined
  ): Promise<void> {
    if (this.disabled) {
      return
    }

    if (!this.initialize()) {
      return
    }

    if (!(metres > 0)) {
      // Chain fully in. Whatever the alarm made of our raise, the anchor is up
      // and the next deployment is a fresh one, so reset rather than trusting
      // an acknowledgement we may never get.
      const wasDeployed = this.state.deployed
      this.armed = true
      this.paused = false
      this.state = IDLE
      if (wasDeployed) {
        await applyAnchorAction(this.app, { kind: 'raise' }, this.source)
      }
      return
    }

    if (this.paused) {
      return
    }

    // A positive reading at startup is not proof that anything went out: the
    // counter may be holding the previous deployment's value. Wait for it to
    // pass through zero unless the alarm already has an anchor we adopted.
    if (!this.state.deployed && !this.armed) {
      return
    }

    const { action, state } = planAnchorAction(
      this.state,
      metres,
      position,
      this.scope
    )
    if (action.kind === 'none') {
      this.state = state
      return
    }

    switch (await applyAnchorAction(this.app, action, this.source)) {
      case 'ok':
        this.state = state
        return
      case 'unavailable':
        this.disabled = true
        this.app.debug(
          `no anchor alarm is listening as ${this.source}; not driving one any further`
        )
        return
      case 'refused':
        // A refused drop is worth retrying — the boat may have no GPS fix yet,
        // and Hoeken's refuses to drop outside the requested zone. A refused
        // resize is not: it means there is no anchor down to resize.
        if (action.kind === 'setRadius') {
          this.paused = true
          this.app.debug(
            'anchor alarm has no anchor down; leaving it alone until the chain comes in'
          )
        }
        return
    }
  }

  reset(): void {
    this.state = IDLE
    this.disabled = false
    this.paused = false
    this.initialized = false
    this.initAttempts = 0
    this.armed = this.readInitialState === undefined
  }
}
