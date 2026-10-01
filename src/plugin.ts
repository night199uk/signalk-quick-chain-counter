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
  DEFAULT_ANCHOR_ALARM_SOURCE
} from './anchorAlarm'
import { CanFrame, CanReader, isChainCountFrame } from './canReader'
import {
  chainDeployedMetres,
  decodeChainCount,
  QUICK_CHAIN_COUNT_CAN_ID
} from './decode'
import { buildRodeLengthDelta, readVesselPosition, SignalKDelta } from './delta'

export const PLUGIN_ID = 'signalk-quick-chain-counter'
export const DEFAULT_CAN_INTERFACE = 'can0'

/** Watch zone radius as a multiple of the rode out: the swinging room. */
export const DEFAULT_RADIUS_SCOPE = 1

/** The slice of the server API this plugin uses. */
export interface PluginApp {
  debug(...args: unknown[]): void
  error(...args: unknown[]): void
  setPluginStatus(message: string): void
  setPluginError(message: string): void
  handleMessage(pluginId: string, message: unknown): void
  getSelfPath(path: string): unknown
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

export default function quickChainCounter(
  app: PluginApp
): QuickChainCounterPlugin {
  let reader: CanReader | undefined
  let bridge: AnchorAlarmBridge | undefined

  function publish(frame: CanFrame): void {
    const chainCount = decodeChainCount(frame.data)
    if (chainCount === undefined) {
      app.debug(
        `ignoring unusable 0x${QUICK_CHAIN_COUNT_CAN_ID.toString(16)} frame (${frame.data.length} bytes)`
      )
      return
    }

    const metres = chainDeployedMetres(chainCount)

    // Publish first: the reading is ours whatever the anchor alarm does with
    // it, and it should land even if the alarm is absent or unhappy.
    app.handleMessage(PLUGIN_ID, buildRodeLengthDelta(chainCount))

    if (bridge) {
      // Only read the position when it is about to be used: the alarm keeps
      // the anchor where it was dropped, so ours only matters at the drop.
      const position = readVesselPosition(
        app.getSelfPath('navigation.position.value')
      )
      bridge.update(metres, position).catch((error: Error) => {
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

      try {
        reader = new CanReader({
          canInterface,
          addonDir: config.canboatjsPath || undefined,
          onFrame: publish,
          onError: (error) =>
            app.error(`error reading ${canInterface}: ${error.message}`),
          debug: app.debug
        })
        reader.start()

        bridge =
          config.driveAnchorAlarm === false
            ? undefined
            : new AnchorAlarmBridge(
                app,
                config.radiusScope || DEFAULT_RADIUS_SCOPE,
                config.anchorAlarmSource || DEFAULT_ANCHOR_ALARM_SOURCE
              )

        app.setPluginStatus(
          `Listening for Quick chain counter frames on ${canInterface}`
        )
      } catch (error) {
        reader = undefined
        bridge = undefined
        app.setPluginError(
          `Could not read ${canInterface}: ${(error as Error).message}`
        )
      }
    },

    stop(): void {
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
