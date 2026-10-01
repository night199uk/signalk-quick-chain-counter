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
 * SocketCAN interface and publishes the deployed chain length.
 *
 * This exists because Quick support in canboat/canboatjs has not been released
 * yet. It decodes the one frame we know about (0x6C1) itself, and depends on
 * nothing beyond what the server already has installed.
 */

import { CanFrame, CanReader, isChainCountFrame } from './canReader'
import { decodeChainCount, QUICK_CHAIN_COUNT_CAN_ID } from './decode'
import { buildChainCountDelta, SignalKDelta } from './delta'

export const PLUGIN_ID = 'signalk-quick-chain-counter'
export const DEFAULT_CAN_INTERFACE = 'can0'

/** The slice of the server API this plugin uses. */
export interface PluginApp {
  debug(...args: unknown[]): void
  error(...args: unknown[]): void
  setPluginStatus(message: string): void
  setPluginError(message: string): void
  handleMessage(pluginId: string, message: unknown): void
}

export interface PluginConfig {
  canInterface?: string
  canboatjsPath?: string
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
    canboatjsPath: {
      type: 'string',
      title: 'canboatjs location (optional)',
      description:
        'Directory holding @canboat/canboatjs, if it cannot be found automatically. Leave blank in normal use.'
    }
  }
}

/**
 * Decode one raw frame into a Signal K delta.
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
  return buildChainCountDelta(chainCount, timestamp)
}

export default function quickChainCounter(
  app: PluginApp
): QuickChainCounterPlugin {
  let reader: CanReader | undefined

  return {
    id: PLUGIN_ID,
    name: 'Quick Chain Counter',
    description:
      'Reads the Quick PCS chain count packet (0x6C1) directly from a SocketCAN interface and publishes the deployed chain length.',

    schema: () => CONFIG_SCHEMA,

    start(config: PluginConfig = {}): void {
      const canInterface = config.canInterface || DEFAULT_CAN_INTERFACE

      try {
        reader = new CanReader({
          canInterface,
          addonDir: config.canboatjsPath || undefined,
          onFrame: (frame) => {
            const delta = frameToDelta(frame)
            if (delta === undefined) {
              app.debug(
                `ignoring unusable 0x${QUICK_CHAIN_COUNT_CAN_ID.toString(16)} frame (${frame.data.length} bytes)`
              )
              return
            }
            app.handleMessage(PLUGIN_ID, delta)
          },
          onError: (error) =>
            app.error(`error reading ${canInterface}: ${error.message}`),
          debug: app.debug
        })
        reader.start()
        app.setPluginStatus(
          `Listening for Quick chain counter frames on ${canInterface}`
        )
      } catch (error) {
        reader = undefined
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
      app.setPluginStatus('Stopped')
    }
  }
}
