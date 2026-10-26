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
 * Quick PCS chain count and chain configuration packets.
 *
 * Quick uses standard 11-bit CAN identifiers, where the identifier *is* the
 * message type rather than an encoded PGN, so 0x6C1 doubles as the PGN. Every
 * multi-byte field is little-endian and every message starts with a 16-bit
 * talker identifier.
 *
 * 0x6C1 reports a *gypsy lap count*, not a length. The length of one lap is
 * carried in 0x6C0, in tenths of an inch. For example, 148 laps with a 130
 * (13.0 in) lap is 160.3 ft, not 148 ft. The trailing field in 0x6C1 is not a
 * measurement unit; only the 0x6C0 lap scales the count.
 *
 * 0x6C1 layout, all little-endian:
 *
 *   offset  size  field
 *   0       2     sourceAddress  talker identifier of the sending device
 *   2       4     lapCount       number of gypsy laps
 *   6       2     status         not a length unit
 *
 * 0x6C0 layout, all little-endian:
 *
 *   offset  size  field
 *   0       2     sourceAddress  talker identifier of the sending device
 *   2       2     lapTenthsInch  gypsy lap length in tenths of an inch
 *   4       2     flags          device status/config
 *   6       2     flags          device status/config
 */

export const QUICK_CHAIN_COUNT_CAN_ID = 0x6c1
export const QUICK_CHAIN_CONFIG_CAN_ID = 0x6c0

/** Talker (2) + count (4) + trailing field (2). */
export const CHAIN_COUNT_PAYLOAD_BYTES = 8

/** Talker (2) + lap (2) + two trailing fields (4). */
export const CHAIN_CONFIG_PAYLOAD_BYTES = 8

/** International feet to metres. Signal K stores every length in metres. */
export const FEET_TO_METRES = 0.3048

/** One tenth of an inch, the resolution of the gypsy lap setting. */
export const TENTH_INCH_TO_METRES = 0.0254 / 10

/**
 * Where the deployed chain length belongs in the Signal K data model.
 *
 * `rodeLength` is what the anchor alarm plugin publishes and accepts, and what
 * freeboard's anchor watch reads; it is the established anchor-rode path even
 * though the specification's schema does not list it yet.
 */
export const RODE_LENGTH_PATH = 'navigation.anchor.rodeLength'

/** Where the anchor itself is, once it is down. Owned by the anchor alarm. */
export const ANCHOR_POSITION_PATH = 'navigation.anchor.position'

/** The circle zone around the anchor; the alarm's PUT handler resizes it. */
export const ANCHOR_MAX_RADIUS_PATH = 'navigation.anchor.maxRadius'

/** The two unit labels Quick defines, spelled as canboat spells them. */
export type QuickUnits = 'Meters' | 'Feet'

/**
 * How the chain counter's units are interpreted.
 *
 * `auto` trusts the frame, with a guard for a value that cannot be metres.
 * `feet` is the escape hatch for units/firmware that display feet but put
 * `Meters` (or an unknown value) in the frame.
 */
export type ChainUnitOverride = 'auto' | 'meters' | 'feet'

export interface ChainCount {
  /** Talker identifier, decoded from the payload. Not a CAN source address. */
  sourceAddress: number
  /** Number of gypsy laps from 0x6C1. Not a length. */
  chainDeployed: number
  /**
   * Trailing 0x6C1 field. Historically misread as a length unit; it is not
   * used when the 0x6C0 gypsy lap is available.
   */
  units: QuickUnits | number
}

export interface ChainConfig {
  /** Talker identifier, decoded from the payload. Not a CAN source address. */
  sourceAddress: number
  /** Gypsy lap length in tenths of an inch (130 = 13.0 in). */
  lapTenthsInch: number
  /** The two trailing 0x6C0 fields; kept for diagnostics. */
  flags: [number, number]
}

const UNITS_BY_VALUE: { [value: number]: QuickUnits } = {
  1: 'Meters',
  2: 'Feet'
}

/**
 * Decode a Quick chain count payload.
 *
 * Returns undefined for anything too short to hold the three fields; a frame
 * that is merely truncated is not decoded on a guess.
 */
export function decodeChainCount(data: Buffer): ChainCount | undefined {
  if (!Buffer.isBuffer(data) || data.length < CHAIN_COUNT_PAYLOAD_BYTES) {
    return undefined
  }

  const status = data.readUInt16LE(6)

  return {
    sourceAddress: data.readUInt16LE(0),
    chainDeployed: data.readUInt32LE(2),
    units: UNITS_BY_VALUE[status] ?? status
  }
}

/**
 * Decode a Quick 0x6C0 chain configuration payload.
 *
 * Returns undefined for anything too short to hold the lap length.
 */
export function decodeChainConfig(data: Buffer): ChainConfig | undefined {
  if (!Buffer.isBuffer(data) || data.length < CHAIN_CONFIG_PAYLOAD_BYTES) {
    return undefined
  }

  return {
    sourceAddress: data.readUInt16LE(0),
    lapTenthsInch: data.readUInt16LE(2),
    flags: [data.readUInt16LE(4), data.readUInt16LE(6)]
  }
}

/** Metres of chain per gypsy lap. */
export function gypsyLapMetres(lapTenthsInch: number): number {
  return lapTenthsInch * TENTH_INCH_TO_METRES
}

/**
 * Deployed chain length in metres from the 0x6C1 lap count and the 0x6C0
 * gypsy-lap length. This is the authoritative decode; `chainDeployedMetres`
 * below is the fallback for a device that has not sent 0x6C0.
 */
export function chainDeployedMetresFromLap(
  chainCount: ChainCount,
  lapTenthsInch: number
): number {
  return chainCount.chainDeployed * gypsyLapMetres(lapTenthsInch)
}

/**
 * Resolve the units to use for one frame.
 *
 * An explicit override wins. In `auto`, the frame's own label wins unless the
 * value is larger than the total chain on board: that cannot be metres, so it
 * is the feet-as-metres failure and is treated as feet. Returns undefined when
 * the frame's own label should be used.
 */
export function resolveChainUnits(
  chainCount: ChainCount,
  override: ChainUnitOverride = 'auto',
  totalChainMetres?: number
): QuickUnits | undefined {
  if (override === 'feet') {
    return 'Feet'
  }
  if (override === 'meters') {
    return 'Meters'
  }
  if (
    chainCount.units !== 'Feet' &&
    typeof totalChainMetres === 'number' &&
    Number.isFinite(totalChainMetres) &&
    totalChainMetres > 0 &&
    chainCount.chainDeployed > totalChainMetres
  ) {
    return 'Feet'
  }
  return undefined
}

/**
 * The deployed chain length in metres.
 *
 * `forceUnits` overrides the frame's own label; without it, only `Feet` is
 * converted. `Meters`, and any unit label we do not recognise, pass through
 * unchanged: the value is already in metres in the first case, and in the
 * second case guessing would be worse than relaying what the device said.
 */
export function chainDeployedMetres(
  chainCount: ChainCount,
  forceUnits?: QuickUnits
): number {
  const units = forceUnits ?? chainCount.units
  return units === 'Feet'
    ? chainCount.chainDeployed * FEET_TO_METRES
    : chainCount.chainDeployed
}
