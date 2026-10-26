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
exports.RODE_LENGTH_META = void 0;
exports.quickSource = quickSource;
exports.buildRodeLengthDelta = buildRodeLengthDelta;
exports.buildRodeLengthMetaDelta = buildRodeLengthMetaDelta;
exports.readVesselPosition = readVesselPosition;
const decode_1 = require("./decode");
/**
 * The source for anything this plugin publishes about the chain.
 *
 * The talker identifier is payload rather than a CAN source address, but it is
 * the closest thing to a device reference a Quick frame carries.
 */
function quickSource(chainCount) {
    return {
        label: 'Quick PCS',
        type: 'QuickPCS',
        pgn: decode_1.QUICK_CHAIN_COUNT_CAN_ID,
        src: String(chainCount.sourceAddress)
    };
}
/**
 * The deployed chain length, in metres.
 *
 * The anchor position, state and watch zone are the anchor alarm's to publish,
 * not ours; this is only the reading straight off the bus.
 */
function buildRodeLengthDelta(chainCount, timestamp = new Date().toISOString(), metres = (0, decode_1.chainDeployedMetres)(chainCount)) {
    return {
        updates: [
            {
                source: quickSource(chainCount),
                timestamp,
                values: [
                    {
                        path: decode_1.RODE_LENGTH_PATH,
                        value: (0, decode_1.chainDeployedMetres)(chainCount)
                    }
                ]
            }
        ]
    };
}
/**
 * Metadata for the deployed chain length.
 *
 * The chain counter only sends a frame when the count changes, and Signal K's
 * staleness enforcer would otherwise turn a long pause at a steady length into
 * a null. `timeout: 0` is the explicit "never expire" setting; `updateContract:
 * 'event'` says the same thing in the vocabulary newer servers use, where a
 * silent path is unchanged state rather than a failed sensor. The reading is a
 * latched value, not a periodic measurement.
 */
exports.RODE_LENGTH_META = {
    units: 'm',
    description: 'Deployed anchor chain length',
    timeout: 0,
    updateContract: 'event'
};
/**
 * The metadata delta for `navigation.anchor.rodeLength`.
 *
 * Published once when the plugin starts, rather than attached to every reading:
 * metadata is per path, and the chain counter can send several frames a second.
 */
function buildRodeLengthMetaDelta(timestamp = new Date().toISOString()) {
    return {
        updates: [
            {
                timestamp,
                meta: [{ path: decode_1.RODE_LENGTH_PATH, value: exports.RODE_LENGTH_META }]
            }
        ]
    };
}
/**
 * Read a `navigation.position` value, rejecting anything that is not a usable
 * latitude/longitude pair. Returns undefined rather than a partial position, so
 * a bad fix cannot become an anchor location.
 */
function readVesselPosition(value) {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const { latitude, longitude } = value;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        return undefined;
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return undefined;
    }
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        return undefined;
    }
    return { latitude, longitude };
}
