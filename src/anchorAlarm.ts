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

  constructor(
    private readonly app: PutApp,
    private readonly scope: number,
    private readonly source: string = DEFAULT_ANCHOR_ALARM_SOURCE
  ) {}

  isDisabled(): boolean {
    return this.disabled
  }

  async update(
    metres: number,
    position: VesselPosition | undefined
  ): Promise<void> {
    if (this.disabled) {
      return
    }

    if (!(metres > 0)) {
      // Chain fully in. Whatever the alarm made of our raise, the anchor is up
      // and the next deployment is a fresh one, so reset rather than trusting
      // an acknowledgement we may never get.
      const wasDeployed = this.state.deployed
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
  }
}
