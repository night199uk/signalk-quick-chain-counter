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

import {
  ChainCount,
  chainDeployedMetres,
  QUICK_CHAIN_COUNT_CAN_ID,
  RODE_DEPLOYED_PATH
} from './decode'

export interface SignalKSource {
  label: string
  type: string
  pgn: number
  src: string
}

export interface SignalKDelta {
  updates: Array<{
    source: SignalKSource
    timestamp: string
    values: Array<{ path: string; value: number }>
  }>
}

/**
 * Turn a decoded chain count into a Signal K delta.
 *
 * The source shape matches what the Quick PCS mapper emits, so a value from
 * this plugin is indistinguishable downstream from one that arrived through
 * canboatjs.
 */
export function buildChainCountDelta(
  chainCount: ChainCount,
  timestamp: string = new Date().toISOString()
): SignalKDelta {
  return {
    updates: [
      {
        source: {
          label: 'Quick PCS',
          type: 'QuickPCS',
          pgn: QUICK_CHAIN_COUNT_CAN_ID,
          // The talker identifier is payload, not a CAN source address, but it
          // is the closest thing to a device reference Quick frames carry.
          src: String(chainCount.sourceAddress)
        },
        timestamp,
        values: [
          {
            path: RODE_DEPLOYED_PATH,
            value: chainDeployedMetres(chainCount)
          }
        ]
      }
    ]
  }
}
