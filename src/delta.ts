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
  RODE_LENGTH_PATH
} from './decode'

export interface SignalKSource {
  label: string
  type: string
  pgn: number
  src: string
}

export interface SignalKUpdate {
  source?: SignalKSource
  timestamp: string
  values: Array<{ path: string; value: unknown }>
}

export interface SignalKDelta {
  updates: SignalKUpdate[]
}

/** A vessel position, as `navigation.position` carries it. */
export interface VesselPosition {
  latitude: number
  longitude: number
}

/**
 * The source for anything this plugin publishes about the chain.
 *
 * The talker identifier is payload rather than a CAN source address, but it is
 * the closest thing to a device reference a Quick frame carries.
 */
export function quickSource(chainCount: ChainCount): SignalKSource {
  return {
    label: 'Quick PCS',
    type: 'QuickPCS',
    pgn: QUICK_CHAIN_COUNT_CAN_ID,
    src: String(chainCount.sourceAddress)
  }
}

/**
 * The deployed chain length, in metres.
 *
 * The anchor position, state and watch zone are the anchor alarm's to publish,
 * not ours; this is only the reading straight off the bus.
 */
export function buildRodeLengthDelta(
  chainCount: ChainCount,
  timestamp: string = new Date().toISOString()
): SignalKDelta {
  return {
    updates: [
      {
        source: quickSource(chainCount),
        timestamp,
        values: [
          {
            path: RODE_LENGTH_PATH,
            value: chainDeployedMetres(chainCount)
          }
        ]
      }
    ]
  }
}

/**
 * Read a `navigation.position` value, rejecting anything that is not a usable
 * latitude/longitude pair. Returns undefined rather than a partial position, so
 * a bad fix cannot become an anchor location.
 */
export function readVesselPosition(value: unknown): VesselPosition | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const { latitude, longitude } = value as {
    latitude?: unknown
    longitude?: unknown
  }
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return undefined
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return undefined
  }
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return undefined
  }
  return { latitude, longitude }
}
