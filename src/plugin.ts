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
 * Signal K plugin: reads Quick PCS chain counter frames straight off a
 * SocketCAN interface.
 *
 * It publishes the deployed chain length as `navigation.anchor.rodeLength`,
 * and drives an anchor alarm from it: the anchor goes down when the chain goes
 * out, up when the chain comes in, and the watch zone grows as more chain is
 * let out. The alarm keeps the drag alarm, the zone and the session log; this
 * plugin only reports how much chain is over the side.
 *
 * This exists because Quick support in canboat/canboatjs has not been released
 * yet. It decodes the one frame we know about (0x6C1) itself, and depends on
 * nothing beyond what the server already has installed.
 */

import {
  AnchorAlarmBridge,
  DEFAULT_ANCHOR_ALARM_SOURCE,
  readAnchorAlarmState
} from './anchorAlarm'
import { CanFrame, CanReader, isChainCountFrame } from './canReader'
import {
  chainDeployedMetres,
  chainDeployedMetresFromLap,
  ChainUnitOverride,
  decodeChainConfig,
  decodeChainCount,
  QUICK_CHAIN_CONFIG_CAN_ID,
  QUICK_CHAIN_COUNT_CAN_ID,
  resolveChainUnits,
  RODE_LENGTH_PATH
} from './decode'
import {
  buildCanBusAlarmDelta,
  buildRodeLengthDelta,
  buildRodeLengthMetaDelta,
  readVesselPosition,
  RODE_LENGTH_META,
  SignalKDelta,
  SignalKMetaValue
} from './delta'

export const PLUGIN_ID = 'signalk-quick-chain-counter'
export const DEFAULT_CAN_INTERFACE = 'can0'

/** Watch zone radius as a multiple of the rode out: the swinging room. */
export const DEFAULT_RADIUS_SCOPE = 1

/** Alarm if no 0x6C1 frame arrives for this long while an engine is running. */
export const DEFAULT_CAN_TIMEOUT_SECONDS = 30

/** Revolutions (Hz) above which an engine counts as running. */
export const DEFAULT_ENGINE_REVOLUTIONS_HZ = 1

/** How often the CAN-bus watchdog checks the engine and frame age. */
const WATCHDOG_INTERVAL_MS = 5000

/** The slice of the server API this plugin uses. */
export interface PluginApp {
  debug(...args: unknown[]): void
  error(...args: unknown[]): void
  setPluginStatus(message: string): void
  setPluginError(message: string): void
  handleMessage(pluginId: string, message: unknown): void
  getSelfPath(path: string): unknown
  /**
   * Persist default metadata for a path. Older servers do not expose this, in
   * which case the plugin falls back to publishing a meta delta.
   */
  setDefaultMetadata?(
    path: string,
    value: SignalKMetaValue
  ): Promise<boolean>
  putPath(
    path: string,
    value: unknown,
    updateCb: (err?: Error) => void,
    source: string
  ): Promise<unknown>
}

export interface PluginConfig {
  canInterface?: string
  canboatjsPath?: string
  driveAnchorAlarm?: boolean
  radiusScope?: number
  chainUnits?: ChainUnitOverride
  requireDepthBeforeDrop?: boolean
  canTimeoutSeconds?: number
  engineRevolutionsThreshold?: number
  anchorAlarmSource?: string
}

export interface QuickChainCounterPlugin {
  id: string
  name: string
  description: string
  schema(): object
  start(config: PluginConfig): void
  stop(): void
}

export const CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    canInterface: {
      type: 'string',
      title: 'CAN interface',
      description:
        'The SocketCAN interface the Quick bus is on, for example can0 or can1.',
      default: DEFAULT_CAN_INTERFACE
    },
    driveAnchorAlarm: {
      type: 'boolean',
      title: 'Drive the anchor alarm',
      description:
        'Drop the anchor when the chain goes out, raise it when the chain comes in, and grow the watch zone as more chain is let out. Needs an anchor alarm that accepts navigation.anchor.position, such as Hoekens Anchor Alarm.',
      default: true
    },
    radiusScope: {
      type: 'number',
      title: 'Watch zone radius, as a multiple of the rode',
      description:
        'The alarm radius is the chain length times this. 1.0 gives the boat exactly its swinging room.',
      default: DEFAULT_RADIUS_SCOPE
    },
    chainUnits: {
      type: 'string',
      title: 'Chain counter units',
      enum: ['auto', 'meters', 'feet'],
      default: 'auto',
      description:
        'How the Quick counter reports chain length. Auto trusts the frame and treats a value larger than the total chain as feet; set feet if the counter displays feet but the frame reports metres.'
    },
    requireDepthBeforeDrop: {
      type: 'boolean',
      title: 'Wait for the anchor to reach the bottom',
      description:
        'Do not set the anchor position until at least the water depth plus bow roller height of chain is out. Without this the anchor position can be recorded while the anchor is still falling or dragging.',
      default: true
    },
    canTimeoutSeconds: {
      type: 'number',
      title: 'No-data alarm timeout (seconds)',
      description:
        'Raise an alarm when an engine is running but no Quick chain counter frame has arrived for this long. Set to 0 to disable the watchdog.',
      default: DEFAULT_CAN_TIMEOUT_SECONDS
    },
    engineRevolutionsThreshold: {
      type: 'number',
      title: 'Engine running threshold (Hz)',
      description:
        'A propulsion.revolutions value above this counts as an engine running. Signal K stores revolutions in Hz; 1 Hz is 60 RPM.',
      default: DEFAULT_ENGINE_REVOLUTIONS_HZ
    },
    anchorAlarmSource: {
      type: 'string',
      title: 'Anchor alarm plugin id',
      description:
        'The plugin whose navigation.anchor.position handler will be driven. Defaults to Hoekens Anchor Alarm; change it to use a different one.',
      default: DEFAULT_ANCHOR_ALARM_SOURCE
    },
    canboatjsPath: {
      type: 'string',
      title: 'canboatjs location (optional)',
      description:
        'Directory holding @canboat/canboatjs, if it cannot be found automatically. Leave blank in normal use.'
    }
  }
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Decode one raw frame into the delta for the deployed chain length.
 *
 * Returns undefined when the frame is not a chain count packet or is too short
 * to hold one, so a listener only has to ask once whether there is anything to
 * publish.
 */
export function frameToDelta(
  frame: CanFrame,
  timestamp?: string
): SignalKDelta | undefined {
  if (!isChainCountFrame(frame.id)) {
    return undefined
  }
  const chainCount = decodeChainCount(frame.data)
  if (chainCount === undefined) {
    return undefined
  }
  return buildRodeLengthDelta(chainCount, timestamp)
}

/**
 * True when any propulsion instance is turning above the threshold.
 *
 * Signal K stores `propulsion.<id>.revolutions` in Hz, so the default
 * threshold of 1 is 60 RPM.
 */
export function anyEngineRunning(
  propulsion: unknown,
  threshold: number
): boolean {
  if (typeof propulsion !== 'object' || propulsion === null) {
    return false
  }

  for (const engine of Object.values(propulsion as Record<string, unknown>)) {
    if (typeof engine !== 'object' || engine === null) {
      continue
    }
    const revolutions = (engine as Record<string, unknown>).revolutions
    const value =
      typeof revolutions === 'object' && revolutions !== null
        ? (revolutions as { value?: unknown }).value
        : revolutions
    if (typeof value === 'number' && Number.isFinite(value) && value > threshold) {
      return true
    }
  }
  return false
}

/**
 * True when an engine has been running and no frame has arrived for the
 * timeout. The clock starts at whichever is later: the last frame or the
 * moment the engine started, so starting an engine does not alarm on a stale
 * frame from the previous run.
 */
export function canBusDataOverdue(
  now: number,
  lastFrameAt: number | undefined,
  engineRunningSince: number | undefined,
  timeoutMs: number
): boolean {
  if (engineRunningSince === undefined) {
    return false
  }
  const reference = Math.max(lastFrameAt ?? 0, engineRunningSince)
  return now - reference > timeoutMs
}

export default function quickChainCounter(
  app: PluginApp
): QuickChainCounterPlugin {
  let reader: CanReader | undefined
  let bridge: AnchorAlarmBridge | undefined
  let chainUnits: ChainUnitOverride = 'auto'
  let requireDepthBeforeDrop = true
  let missingDepthWarned = false
  const lapTenthsBySource = new Map<number, number>()
  const missingLapWarned = new Set<number>()
  let watchdog: ReturnType<typeof setInterval> | undefined
  let lastChainFrameAt: number | undefined
  let engineRunningSince: number | undefined
  let canBusAlarm = false
  let canTimeoutMs = DEFAULT_CAN_TIMEOUT_SECONDS * 1000
  let engineRevolutionsThreshold = DEFAULT_ENGINE_REVOLUTIONS_HZ

  function setCanBusAlarm(active: boolean, message?: string): void {
    if (active === canBusAlarm) {
      return
    }
    canBusAlarm = active
    app.handleMessage(PLUGIN_ID, buildCanBusAlarmDelta(active, message))
  }

  function checkCanBus(): void {
    const running = anyEngineRunning(
      app.getSelfPath('propulsion'),
      engineRevolutionsThreshold
    )
    if (!running) {
      engineRunningSince = undefined
      setCanBusAlarm(false)
      return
    }

    if (engineRunningSince === undefined) {
      engineRunningSince = Date.now()
    }

    if (
      canBusDataOverdue(
        Date.now(),
        lastChainFrameAt,
        engineRunningSince,
        canTimeoutMs
      )
    ) {
      setCanBusAlarm(
        true,
        `No Quick chain counter data for ${Math.round(canTimeoutMs / 1000)} s while an engine is running`
      )
    } else {
      setCanBusAlarm(false)
    }
  }

  function stopWatchdog(): void {
    if (watchdog) {
      clearInterval(watchdog)
      watchdog = undefined
    }
    engineRunningSince = undefined
    lastChainFrameAt = undefined
    setCanBusAlarm(false)
  }

  function learnChainConfig(frame: CanFrame): void {
    const config = decodeChainConfig(frame.data)
    if (config === undefined) {
      app.debug(
        `ignoring unusable 0x${QUICK_CHAIN_CONFIG_CAN_ID.toString(16)} frame (${frame.data.length} bytes)`
      )
      return
    }
    lapTenthsBySource.set(config.sourceAddress, config.lapTenthsInch)
    missingLapWarned.delete(config.sourceAddress)
    app.debug(
      `chain config from ${config.sourceAddress}: lap ${config.lapTenthsInch / 10} in`
    )
  }

  function publish(frame: CanFrame): void {
    lastChainFrameAt = Date.now()
    const chainCount = decodeChainCount(frame.data)
    if (chainCount === undefined) {
      app.debug(
        `ignoring unusable 0x${QUICK_CHAIN_COUNT_CAN_ID.toString(16)} frame (${frame.data.length} bytes)`
      )
      return
    }

    let minimumDropMetres = 0
    if (requireDepthBeforeDrop) {
      const depth = readFiniteNumber(
        app.getSelfPath('environment.depth.belowSurface.value')
      )
      const rollerHeight =
        readFiniteNumber(
          app.getSelfPath('design.bowAnchorRollerHeight.value')
        ) ?? 0
      if (depth !== undefined && depth > 0) {
        minimumDropMetres = depth + rollerHeight
      } else {
        // Without a depth we cannot know when the anchor is on the bottom.
        // Keep waiting rather than recording a position too early.
        minimumDropMetres = Infinity
        if (!missingDepthWarned) {
          missingDepthWarned = true
          app.debug(
            'no environment.depth.belowSurface; not dropping until a depth is available'
          )
        }
      }
    }

    const lapTenthsInch = lapTenthsBySource.get(chainCount.sourceAddress)
    let metres: number
    if (lapTenthsInch !== undefined && lapTenthsInch > 0) {
      // 0x6C1 is a lap count; 0x6C0 says how long one lap is.
      metres = chainDeployedMetresFromLap(chainCount, lapTenthsInch)
    } else {
      if (!missingLapWarned.has(chainCount.sourceAddress)) {
        missingLapWarned.add(chainCount.sourceAddress)
        app.debug(
          `no 0x${QUICK_CHAIN_CONFIG_CAN_ID.toString(16)} gypsy lap for ${chainCount.sourceAddress}; falling back to the frame units`
        )
      }
      const totalChainMetres = readFiniteNumber(
        app.getSelfPath('design.totalAnchorChainLength.value')
      )
      const forceUnits = resolveChainUnits(
        chainCount,
        chainUnits,
        totalChainMetres
      )
      if (forceUnits === 'Feet' && chainCount.units !== 'Feet') {
        app.debug(
          `chain count ${chainCount.chainDeployed} exceeds ${totalChainMetres}m total chain; treating it as feet`
        )
      }
      metres = chainDeployedMetres(chainCount, forceUnits)
    }

    // Publish first: the reading is ours whatever the anchor alarm does with
    // it, and it should land even if the alarm is absent or unhappy.
    app.handleMessage(
      PLUGIN_ID,
      buildRodeLengthDelta(chainCount, undefined, metres)
    )

    if (bridge) {
      // Only read the position when it is about to be used: the alarm keeps
      // the anchor where it was dropped, so ours only matters at the drop.
      const position = readVesselPosition(
        app.getSelfPath('navigation.position.value')
      )
      bridge.update(metres, position, minimumDropMetres).catch((error: Error) => {
        app.debug(`anchor alarm update failed: ${error.message}`)
      })
    }
  }

  return {
    id: PLUGIN_ID,
    name: 'Quick Chain Counter',
    description:
      'Reads the Quick PCS chain count packet (0x6C1) directly from a SocketCAN interface, publishes the deployed chain length, and drives an anchor alarm from it.',

    schema: () => CONFIG_SCHEMA,

    start(config: PluginConfig = {}): void {
      const canInterface = config.canInterface || DEFAULT_CAN_INTERFACE
      chainUnits = config.chainUnits || 'auto'
      requireDepthBeforeDrop = config.requireDepthBeforeDrop !== false
      canTimeoutMs =
        (config.canTimeoutSeconds ?? DEFAULT_CAN_TIMEOUT_SECONDS) * 1000
      engineRevolutionsThreshold =
        config.engineRevolutionsThreshold ?? DEFAULT_ENGINE_REVOLUTIONS_HZ
      missingDepthWarned = false
      lapTenthsBySource.clear()
      missingLapWarned.clear()
      stopWatchdog()

      try {
        // Claim the path before the first reading so a steady chain length is
        // never mistaken for a dead sensor. The chain counter sends nothing
        // while the length is unchanged.
        //
        // setDefaultMetadata is where the server's staleness enforcer looks for
        // meta, so prefer it; older servers only understand a meta delta.
        if (typeof app.setDefaultMetadata === 'function') {
          app
            .setDefaultMetadata(RODE_LENGTH_PATH, RODE_LENGTH_META)
            .catch((error: Error) =>
              app.debug(
                `could not persist ${RODE_LENGTH_PATH} metadata: ${error.message}`
              )
            )
        } else {
          app.handleMessage(PLUGIN_ID, buildRodeLengthMetaDelta())
        }

        reader = new CanReader({
          canInterface,
          addonDir: config.canboatjsPath || undefined,
          onFrame: publish,
          onConfigFrame: learnChainConfig,
          onError: (error) =>
            app.error(`error reading ${canInterface}: ${error.message}`),
          debug: app.debug
        })
        reader.start()

        if (canTimeoutMs > 0) {
          watchdog = setInterval(checkCanBus, WATCHDOG_INTERVAL_MS)
          watchdog.unref?.()
        }

        bridge =
          config.driveAnchorAlarm === false
            ? undefined
            : new AnchorAlarmBridge(
                app,
                config.radiusScope || DEFAULT_RADIUS_SCOPE,
                config.anchorAlarmSource || DEFAULT_ANCHOR_ALARM_SOURCE,
                () => readAnchorAlarmState((path) => app.getSelfPath(path))
              )

        app.setPluginStatus(
          `Listening for Quick chain counter frames on ${canInterface}`
        )
      } catch (error) {
        reader = undefined
        bridge = undefined
        stopWatchdog()
        app.setPluginError(
          `Could not read ${canInterface}: ${(error as Error).message}`
        )
      }
    },

    stop(): void {
      stopWatchdog()
      if (reader) {
        reader.stop()
        reader = undefined
      }
      bridge?.reset()
      bridge = undefined
      app.setPluginStatus('Stopped')
    }
  }
}
