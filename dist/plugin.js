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
exports.CONFIG_SCHEMA = exports.DEFAULT_RADIUS_SCOPE = exports.DEFAULT_CAN_INTERFACE = exports.PLUGIN_ID = void 0;
exports.frameToDelta = frameToDelta;
exports.default = quickChainCounter;
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
const anchorAlarm_1 = require("./anchorAlarm");
const canReader_1 = require("./canReader");
const decode_1 = require("./decode");
const delta_1 = require("./delta");
exports.PLUGIN_ID = 'signalk-quick-chain-counter';
exports.DEFAULT_CAN_INTERFACE = 'can0';
/** Watch zone radius as a multiple of the rode out: the swinging room. */
exports.DEFAULT_RADIUS_SCOPE = 1;
exports.CONFIG_SCHEMA = {
    type: 'object',
    properties: {
        canInterface: {
            type: 'string',
            title: 'CAN interface',
            description: 'The SocketCAN interface the Quick bus is on, for example can0 or can1.',
            default: exports.DEFAULT_CAN_INTERFACE
        },
        driveAnchorAlarm: {
            type: 'boolean',
            title: 'Drive the anchor alarm',
            description: 'Drop the anchor when the chain goes out, raise it when the chain comes in, and grow the watch zone as more chain is let out. Needs an anchor alarm that accepts navigation.anchor.position, such as Hoekens Anchor Alarm.',
            default: true
        },
        radiusScope: {
            type: 'number',
            title: 'Watch zone radius, as a multiple of the rode',
            description: 'The alarm radius is the chain length times this. 1.0 gives the boat exactly its swinging room.',
            default: exports.DEFAULT_RADIUS_SCOPE
        },
        anchorAlarmSource: {
            type: 'string',
            title: 'Anchor alarm plugin id',
            description: 'The plugin whose navigation.anchor.position handler will be driven. Defaults to Hoekens Anchor Alarm; change it to use a different one.',
            default: anchorAlarm_1.DEFAULT_ANCHOR_ALARM_SOURCE
        },
        canboatjsPath: {
            type: 'string',
            title: 'canboatjs location (optional)',
            description: 'Directory holding @canboat/canboatjs, if it cannot be found automatically. Leave blank in normal use.'
        }
    }
};
/**
 * Decode one raw frame into the delta for the deployed chain length.
 *
 * Returns undefined when the frame is not a chain count packet or is too short
 * to hold one, so a listener only has to ask once whether there is anything to
 * publish.
 */
function frameToDelta(frame, timestamp) {
    if (!(0, canReader_1.isChainCountFrame)(frame.id)) {
        return undefined;
    }
    const chainCount = (0, decode_1.decodeChainCount)(frame.data);
    if (chainCount === undefined) {
        return undefined;
    }
    return (0, delta_1.buildRodeLengthDelta)(chainCount, timestamp);
}
function quickChainCounter(app) {
    let reader;
    let bridge;
    function publish(frame) {
        const chainCount = (0, decode_1.decodeChainCount)(frame.data);
        if (chainCount === undefined) {
            app.debug(`ignoring unusable 0x${decode_1.QUICK_CHAIN_COUNT_CAN_ID.toString(16)} frame (${frame.data.length} bytes)`);
            return;
        }
        const metres = (0, decode_1.chainDeployedMetres)(chainCount);
        // Publish first: the reading is ours whatever the anchor alarm does with
        // it, and it should land even if the alarm is absent or unhappy.
        app.handleMessage(exports.PLUGIN_ID, (0, delta_1.buildRodeLengthDelta)(chainCount));
        if (bridge) {
            // Only read the position when it is about to be used: the alarm keeps
            // the anchor where it was dropped, so ours only matters at the drop.
            const position = (0, delta_1.readVesselPosition)(app.getSelfPath('navigation.position.value'));
            bridge.update(metres, position).catch((error) => {
                app.debug(`anchor alarm update failed: ${error.message}`);
            });
        }
    }
    return {
        id: exports.PLUGIN_ID,
        name: 'Quick Chain Counter',
        description: 'Reads the Quick PCS chain count packet (0x6C1) directly from a SocketCAN interface, publishes the deployed chain length, and drives an anchor alarm from it.',
        schema: () => exports.CONFIG_SCHEMA,
        start(config = {}) {
            const canInterface = config.canInterface || exports.DEFAULT_CAN_INTERFACE;
            try {
                reader = new canReader_1.CanReader({
                    canInterface,
                    addonDir: config.canboatjsPath || undefined,
                    onFrame: publish,
                    onError: (error) => app.error(`error reading ${canInterface}: ${error.message}`),
                    debug: app.debug
                });
                reader.start();
                bridge =
                    config.driveAnchorAlarm === false
                        ? undefined
                        : new anchorAlarm_1.AnchorAlarmBridge(app, config.radiusScope || exports.DEFAULT_RADIUS_SCOPE, config.anchorAlarmSource || anchorAlarm_1.DEFAULT_ANCHOR_ALARM_SOURCE);
                app.setPluginStatus(`Listening for Quick chain counter frames on ${canInterface}`);
            }
            catch (error) {
                reader = undefined;
                bridge = undefined;
                app.setPluginError(`Could not read ${canInterface}: ${error.message}`);
            }
        },
        stop() {
            if (reader) {
                reader.stop();
                reader = undefined;
            }
            bridge?.reset();
            bridge = undefined;
            app.setPluginStatus('Stopped');
        }
    };
}
