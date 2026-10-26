"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ANCHOR_MAX_RADIUS_PATH = exports.ANCHOR_POSITION_PATH = exports.RODE_LENGTH_PATH = exports.TENTH_INCH_TO_METRES = exports.FEET_TO_METRES = exports.CHAIN_CONFIG_PAYLOAD_BYTES = exports.CHAIN_COUNT_PAYLOAD_BYTES = exports.QUICK_CHAIN_CONFIG_CAN_ID = exports.QUICK_CHAIN_COUNT_CAN_ID = void 0;
exports.decodeChainCount = decodeChainCount;
exports.decodeChainConfig = decodeChainConfig;
exports.gypsyLapMetres = gypsyLapMetres;
exports.chainDeployedMetresFromLap = chainDeployedMetresFromLap;
exports.resolveChainUnits = resolveChainUnits;
exports.chainDeployedMetres = chainDeployedMetres;
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
exports.QUICK_CHAIN_COUNT_CAN_ID = 0x6c1;
exports.QUICK_CHAIN_CONFIG_CAN_ID = 0x6c0;
/** Talker (2) + count (4) + trailing field (2). */
exports.CHAIN_COUNT_PAYLOAD_BYTES = 8;
/** Talker (2) + lap (2) + two trailing fields (4). */
exports.CHAIN_CONFIG_PAYLOAD_BYTES = 8;
/** International feet to metres. Signal K stores every length in metres. */
exports.FEET_TO_METRES = 0.3048;
/** One tenth of an inch, the resolution of the gypsy lap setting. */
exports.TENTH_INCH_TO_METRES = 0.0254 / 10;
/**
 * Where the deployed chain length belongs in the Signal K data model.
 *
 * `rodeLength` is what the anchor alarm plugin publishes and accepts, and what
 * freeboard's anchor watch reads; it is the established anchor-rode path even
 * though the specification's schema does not list it yet.
 */
exports.RODE_LENGTH_PATH = 'navigation.anchor.rodeLength';
/** Where the anchor itself is, once it is down. Owned by the anchor alarm. */
exports.ANCHOR_POSITION_PATH = 'navigation.anchor.position';
/** The circle zone around the anchor; the alarm's PUT handler resizes it. */
exports.ANCHOR_MAX_RADIUS_PATH = 'navigation.anchor.maxRadius';
const UNITS_BY_VALUE = {
    1: 'Meters',
    2: 'Feet'
};
/**
 * Decode a Quick chain count payload.
 *
 * Returns undefined for anything too short to hold the three fields; a frame
 * that is merely truncated is not decoded on a guess.
 */
function decodeChainCount(data) {
    if (!Buffer.isBuffer(data) || data.length < exports.CHAIN_COUNT_PAYLOAD_BYTES) {
        return undefined;
    }
    const status = data.readUInt16LE(6);
    return {
        sourceAddress: data.readUInt16LE(0),
        chainDeployed: data.readUInt32LE(2),
        units: UNITS_BY_VALUE[status] ?? status
    };
}
/**
 * Decode a Quick 0x6C0 chain configuration payload.
 *
 * Returns undefined for anything too short to hold the lap length.
 */
function decodeChainConfig(data) {
    if (!Buffer.isBuffer(data) || data.length < exports.CHAIN_CONFIG_PAYLOAD_BYTES) {
        return undefined;
    }
    return {
        sourceAddress: data.readUInt16LE(0),
        lapTenthsInch: data.readUInt16LE(2),
        flags: [data.readUInt16LE(4), data.readUInt16LE(6)]
    };
}
/** Metres of chain per gypsy lap. */
function gypsyLapMetres(lapTenthsInch) {
    return lapTenthsInch * exports.TENTH_INCH_TO_METRES;
}
/**
 * Deployed chain length in metres from the 0x6C1 lap count and the 0x6C0
 * gypsy-lap length. This is the authoritative decode; `chainDeployedMetres`
 * below is the fallback for a device that has not sent 0x6C0.
 */
function chainDeployedMetresFromLap(chainCount, lapTenthsInch) {
    return chainCount.chainDeployed * gypsyLapMetres(lapTenthsInch);
}
/**
 * Resolve the units to use for one frame.
 *
 * An explicit override wins. In `auto`, the frame's own label wins unless the
 * value is larger than the total chain on board: that cannot be metres, so it
 * is the feet-as-metres failure and is treated as feet. Returns undefined when
 * the frame's own label should be used.
 */
function resolveChainUnits(chainCount, override = 'auto', totalChainMetres) {
    if (override === 'feet') {
        return 'Feet';
    }
    if (override === 'meters') {
        return 'Meters';
    }
    if (chainCount.units !== 'Feet' &&
        typeof totalChainMetres === 'number' &&
        Number.isFinite(totalChainMetres) &&
        totalChainMetres > 0 &&
        chainCount.chainDeployed > totalChainMetres) {
        return 'Feet';
    }
    return undefined;
}
/**
 * The deployed chain length in metres.
 *
 * `forceUnits` overrides the frame's own label; without it, only `Feet` is
 * converted. `Meters`, and any unit label we do not recognise, pass through
 * unchanged: the value is already in metres in the first case, and in the
 * second case guessing would be worse than relaying what the device said.
 */
function chainDeployedMetres(chainCount, forceUnits) {
    const units = forceUnits ?? chainCount.units;
    return units === 'Feet'
        ? chainCount.chainDeployed * exports.FEET_TO_METRES
        : chainCount.chainDeployed;
}
