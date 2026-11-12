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
exports.CONFIG_SCHEMA = exports.DEFAULT_ENGINE_REVOLUTIONS_HZ = exports.DEFAULT_CAN_TIMEOUT_SECONDS = exports.DEFAULT_RADIUS_SCOPE = exports.DEFAULT_CAN_INTERFACE = exports.PLUGIN_ID = void 0;
exports.frameToDelta = frameToDelta;
exports.anyEngineRunning = anyEngineRunning;
exports.canBusDataOverdue = canBusDataOverdue;
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
/** Alarm if no 0x6C1 frame arrives for this long while an engine is running. */
exports.DEFAULT_CAN_TIMEOUT_SECONDS = 30;
/** Revolutions (Hz) above which an engine counts as running. */
exports.DEFAULT_ENGINE_REVOLUTIONS_HZ = 1;
/** How often the CAN-bus watchdog checks the engine and frame age. */
const WATCHDOG_INTERVAL_MS = 5000;
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
        chainUnits: {
            type: 'string',
            title: 'Chain counter units',
            enum: ['auto', 'meters', 'feet'],
            default: 'auto',
            description: 'How the Quick counter reports chain length. Auto trusts the frame and treats a value larger than the total chain as feet; set feet if the counter displays feet but the frame reports metres.'
        },
        requireDepthBeforeDrop: {
            type: 'boolean',
            title: 'Wait for the anchor to reach the bottom',
            description: 'Do not set the anchor position until at least the water depth plus bow roller height of chain is out. Without this the anchor position can be recorded while the anchor is still falling or dragging.',
            default: true
        },
        canTimeoutSeconds: {
            type: 'number',
            title: 'No-data alarm timeout (seconds)',
            description: 'Raise an alarm when an engine is running but no Quick chain counter frame has arrived for this long. Set to 0 to disable the watchdog.',
            default: exports.DEFAULT_CAN_TIMEOUT_SECONDS
        },
        engineRevolutionsThreshold: {
            type: 'number',
            title: 'Engine running threshold (Hz)',
            description: 'A propulsion.revolutions value above this counts as an engine running. Signal K stores revolutions in Hz; 1 Hz is 60 RPM.',
            default: exports.DEFAULT_ENGINE_REVOLUTIONS_HZ
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
function readFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
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
/**
 * True when any propulsion instance is turning above the threshold.
 *
 * Signal K stores `propulsion.<id>.revolutions` in Hz, so the default
 * threshold of 1 is 60 RPM.
 */
function anyEngineRunning(propulsion, threshold) {
    if (typeof propulsion !== 'object' || propulsion === null) {
        return false;
    }
    for (const engine of Object.values(propulsion)) {
        if (typeof engine !== 'object' || engine === null) {
            continue;
        }
        const revolutions = engine.revolutions;
        const value = typeof revolutions === 'object' && revolutions !== null
            ? revolutions.value
            : revolutions;
        if (typeof value === 'number' && Number.isFinite(value) && value > threshold) {
            return true;
        }
    }
    return false;
}
/**
 * True when an engine has been running and no frame has arrived for the
 * timeout. The clock starts at whichever is later: the last frame or the
 * moment the engine started, so starting an engine does not alarm on a stale
 * frame from the previous run.
 */
function canBusDataOverdue(now, lastFrameAt, engineRunningSince, timeoutMs) {
    if (engineRunningSince === undefined) {
        return false;
    }
    const reference = Math.max(lastFrameAt ?? 0, engineRunningSince);
    return now - reference > timeoutMs;
}
function quickChainCounter(app) {
    let reader;
    let bridge;
    let chainUnits = 'auto';
    let requireDepthBeforeDrop = true;
    let missingDepthWarned = false;
    const lapTenthsBySource = new Map();
    const missingLapWarned = new Set();
    let watchdog;
    let lastChainFrameAt;
    let engineRunningSince;
    let canBusAlarm = false;
    let canTimeoutMs = exports.DEFAULT_CAN_TIMEOUT_SECONDS * 1000;
    let engineRevolutionsThreshold = exports.DEFAULT_ENGINE_REVOLUTIONS_HZ;
    function setCanBusAlarm(active, message) {
        if (active === canBusAlarm) {
            return;
        }
        canBusAlarm = active;
        app.handleMessage(exports.PLUGIN_ID, (0, delta_1.buildCanBusAlarmDelta)(active, message));
    }
    function checkCanBus() {
        const running = anyEngineRunning(app.getSelfPath('propulsion'), engineRevolutionsThreshold);
        if (!running) {
            engineRunningSince = undefined;
            setCanBusAlarm(false);
            return;
        }
        if (engineRunningSince === undefined) {
            engineRunningSince = Date.now();
        }
        if (canBusDataOverdue(Date.now(), lastChainFrameAt, engineRunningSince, canTimeoutMs)) {
            setCanBusAlarm(true, `No Quick chain counter data for ${Math.round(canTimeoutMs / 1000)} s while an engine is running`);
        }
        else {
            setCanBusAlarm(false);
        }
    }
    function stopWatchdog() {
        if (watchdog) {
            clearInterval(watchdog);
            watchdog = undefined;
        }
        engineRunningSince = undefined;
        lastChainFrameAt = undefined;
        setCanBusAlarm(false);
    }
    function learnChainConfig(frame) {
        const config = (0, decode_1.decodeChainConfig)(frame.data);
        if (config === undefined) {
            app.debug(`ignoring unusable 0x${decode_1.QUICK_CHAIN_CONFIG_CAN_ID.toString(16)} frame (${frame.data.length} bytes)`);
            return;
        }
        lapTenthsBySource.set(config.sourceAddress, config.lapTenthsInch);
        missingLapWarned.delete(config.sourceAddress);
        app.debug(`chain config from ${config.sourceAddress}: lap ${config.lapTenthsInch / 10} in`);
    }
    function publish(frame) {
        lastChainFrameAt = Date.now();
        const chainCount = (0, decode_1.decodeChainCount)(frame.data);
        if (chainCount === undefined) {
            app.debug(`ignoring unusable 0x${decode_1.QUICK_CHAIN_COUNT_CAN_ID.toString(16)} frame (${frame.data.length} bytes)`);
            return;
        }
        let minimumDropMetres = 0;
        if (requireDepthBeforeDrop) {
            const depth = readFiniteNumber(app.getSelfPath('environment.depth.belowSurface.value'));
            const rollerHeight = readFiniteNumber(app.getSelfPath('design.bowAnchorRollerHeight.value')) ?? 0;
            if (depth !== undefined && depth > 0) {
                minimumDropMetres = depth + rollerHeight;
            }
            else {
                // Without a depth we cannot know when the anchor is on the bottom.
                // Keep waiting rather than recording a position too early.
                minimumDropMetres = Infinity;
                if (!missingDepthWarned) {
                    missingDepthWarned = true;
                    app.debug('no environment.depth.belowSurface; not dropping until a depth is available');
                }
            }
        }
        const lapTenthsInch = lapTenthsBySource.get(chainCount.sourceAddress);
        let metres;
        if (lapTenthsInch !== undefined && lapTenthsInch > 0) {
            // 0x6C1 is a lap count; 0x6C0 says how long one lap is.
            metres = (0, decode_1.chainDeployedMetresFromLap)(chainCount, lapTenthsInch);
        }
        else {
            if (!missingLapWarned.has(chainCount.sourceAddress)) {
                missingLapWarned.add(chainCount.sourceAddress);
                app.debug(`no 0x${decode_1.QUICK_CHAIN_CONFIG_CAN_ID.toString(16)} gypsy lap for ${chainCount.sourceAddress}; falling back to the frame units`);
            }
            const totalChainMetres = readFiniteNumber(app.getSelfPath('design.totalAnchorChainLength.value'));
            const forceUnits = (0, decode_1.resolveChainUnits)(chainCount, chainUnits, totalChainMetres);
            if (forceUnits === 'Feet' && chainCount.units !== 'Feet') {
                app.debug(`chain count ${chainCount.chainDeployed} exceeds ${totalChainMetres}m total chain; treating it as feet`);
            }
            metres = (0, decode_1.chainDeployedMetres)(chainCount, forceUnits);
        }
        // Publish first: the reading is ours whatever the anchor alarm does with
        // it, and it should land even if the alarm is absent or unhappy.
        app.handleMessage(exports.PLUGIN_ID, (0, delta_1.buildRodeLengthDelta)(chainCount, undefined, metres));
        if (bridge) {
            // Only read the position when it is about to be used: the alarm keeps
            // the anchor where it was dropped, so ours only matters at the drop.
            const position = (0, delta_1.readVesselPosition)(app.getSelfPath('navigation.position.value'));
            bridge.update(metres, position, minimumDropMetres).catch((error) => {
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
            chainUnits = config.chainUnits || 'auto';
            requireDepthBeforeDrop = config.requireDepthBeforeDrop !== false;
            canTimeoutMs =
                (config.canTimeoutSeconds ?? exports.DEFAULT_CAN_TIMEOUT_SECONDS) * 1000;
            engineRevolutionsThreshold =
                config.engineRevolutionsThreshold ?? exports.DEFAULT_ENGINE_REVOLUTIONS_HZ;
            missingDepthWarned = false;
            lapTenthsBySource.clear();
            missingLapWarned.clear();
            stopWatchdog();
            try {
                // Claim the path before the first reading so a steady chain length is
                // never mistaken for a dead sensor. The chain counter sends nothing
                // while the length is unchanged.
                //
                // setDefaultMetadata is where the server's staleness enforcer looks for
                // meta, so prefer it; older servers only understand a meta delta.
                if (typeof app.setDefaultMetadata === 'function') {
                    app
                        .setDefaultMetadata(decode_1.RODE_LENGTH_PATH, delta_1.RODE_LENGTH_META)
                        .catch((error) => app.debug(`could not persist ${decode_1.RODE_LENGTH_PATH} metadata: ${error.message}`));
                }
                else {
                    app.handleMessage(exports.PLUGIN_ID, (0, delta_1.buildRodeLengthMetaDelta)());
                }
                reader = new canReader_1.CanReader({
                    canInterface,
                    addonDir: config.canboatjsPath || undefined,
                    onFrame: publish,
                    onConfigFrame: learnChainConfig,
                    onError: (error) => app.error(`error reading ${canInterface}: ${error.message}`),
                    debug: app.debug
                });
                reader.start();
                if (canTimeoutMs > 0) {
                    watchdog = setInterval(checkCanBus, WATCHDOG_INTERVAL_MS);
                    watchdog.unref?.();
                }
                bridge =
                    config.driveAnchorAlarm === false
                        ? undefined
                        : new anchorAlarm_1.AnchorAlarmBridge(app, config.radiusScope || exports.DEFAULT_RADIUS_SCOPE, config.anchorAlarmSource || anchorAlarm_1.DEFAULT_ANCHOR_ALARM_SOURCE, () => (0, anchorAlarm_1.readAnchorAlarmState)((path) => app.getSelfPath(path)));
                app.setPluginStatus(`Listening for Quick chain counter frames on ${canInterface}`);
            }
            catch (error) {
                reader = undefined;
                bridge = undefined;
                stopWatchdog();
                app.setPluginError(`Could not read ${canInterface}: ${error.message}`);
            }
        },
        stop() {
            stopWatchdog();
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
