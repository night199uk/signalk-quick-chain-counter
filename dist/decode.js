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
exports.ANCHOR_MAX_RADIUS_PATH = exports.ANCHOR_POSITION_PATH = exports.RODE_LENGTH_PATH = exports.FEET_TO_METRES = exports.CHAIN_COUNT_PAYLOAD_BYTES = exports.QUICK_CHAIN_COUNT_CAN_ID = void 0;
exports.decodeChainCount = decodeChainCount;
exports.chainDeployedMetres = chainDeployedMetres;
/**
 * Quick PCS chain count packet.
 *
 * Quick uses standard 11-bit CAN identifiers, where the identifier *is* the
 * message type rather than an encoded PGN, so 0x6C1 doubles as the PGN. Every
 * multi-byte field is little-endian and every message starts with a 16-bit
 * talker identifier.
 *
 * Layout, all little-endian:
 *
 *   offset  size  field
 *   0       2     sourceAddress  talker identifier of the sending device
 *   2       4     chainDeployed  length of chain, in the units below
 *   6       2     units          1 = Meters, 2 = Feet
 */
exports.QUICK_CHAIN_COUNT_CAN_ID = 0x6c1;
/** Talker (2) + chain (4) + units (2). Anything shorter cannot be decoded. */
exports.CHAIN_COUNT_PAYLOAD_BYTES = 8;
/** International feet to metres. Signal K stores every length in metres. */
exports.FEET_TO_METRES = 0.3048;
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
    const unitsValue = data.readUInt16LE(6);
    return {
        sourceAddress: data.readUInt16LE(0),
        chainDeployed: data.readUInt32LE(2),
        units: UNITS_BY_VALUE[unitsValue] ?? unitsValue
    };
}
/**
 * The deployed chain length in metres.
 *
 * Only `Feet` is converted. `Meters`, and any unit label we do not recognise,
 * pass through unchanged: the value is already in metres in the first case,
 * and in the second case guessing would be worse than relaying what the device
 * actually said.
 */
function chainDeployedMetres(chainCount) {
    return chainCount.units === 'Feet'
        ? chainCount.chainDeployed * exports.FEET_TO_METRES
        : chainCount.chainDeployed;
}
