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
exports.AnchorAlarmBridge = exports.IDLE = exports.DEFAULT_ANCHOR_ALARM_SOURCE = void 0;
exports.readAnchorAlarmState = readAnchorAlarmState;
exports.planAnchorAction = planAnchorAction;
exports.applyAnchorAction = applyAnchorAction;
/**
 * Drives an anchor alarm from the chain counter.
 *
 * Rather than reimplement anchor watch, this hands the chain length to an
 * anchor alarm that owns the drag alarm, the watch zone and the session log.
 * Hoeken's Anchor Alarm is the one this is built against; it registers the two
 * legacy action handlers used here:
 *
 *   navigation.anchor.position   PUT { latitude, longitude, radius } to drop
 *                                the anchor, or null to raise it
 *   navigation.anchor.maxRadius  PUT a number to resize the circle zone
 *
 * Calling them through the server rather than over HTTP means no port to
 * discover, no JWT to obtain and no dependency on the plugin being installed:
 * the server dispatches to whatever registered the handler, and answers 405
 * when nothing did.
 *
 * The source has to be named. The server records each handler under the
 * registering plugin's id, and a PUT with no source is rejected as ambiguous
 * once more than one anchor alarm is installed.
 */
const decode_1 = require("./decode");
/** The plugin id the anchor alarm handlers are registered under by default. */
exports.DEFAULT_ANCHOR_ALARM_SOURCE = 'hoekens-anchor-alarm';
/** Action handlers are registered against a context-qualified path. */
const SELF_CONTEXT = 'vessels.self';
exports.IDLE = { deployed: false };
/** How many chain readings to wait for the alarm to publish its state. */
const INITIAL_STATE_ATTEMPTS = 5;
function finiteRadius(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : undefined;
}
/**
 * Read the anchor alarm's current state from the Signal K tree.
 *
 * Returns undefined until the alarm has published anything, so a plugin that
 * starts before the alarm can wait a frame instead of mistaking "not started
 * yet" for "no anchor down".
 */
function readAnchorAlarmState(getSelfPath) {
    const state = getSelfPath('navigation.anchor.state.value');
    const position = getSelfPath('navigation.anchor.position.value');
    const maxRadius = getSelfPath('navigation.anchor.maxRadius.value');
    const watchZone = getSelfPath('navigation.anchor.watchZone.value');
    if (state === undefined &&
        position === undefined &&
        maxRadius === undefined &&
        watchZone === undefined) {
        return undefined;
    }
    const deployed = state === 'on' ||
        (state !== 'off' && typeof position === 'object' && position !== null);
    if (!deployed) {
        return { deployed: false };
    }
    const radius = finiteRadius(maxRadius) ??
        finiteRadius(typeof watchZone === 'object' && watchZone !== null
            ? watchZone.radius
            : undefined);
    return radius === undefined ? { deployed: true } : { deployed: true, radius };
}
/**
 * Decide what the anchor alarm should do about one chain counter reading.
 *
 * As the chain spools out the watch zone grows with it, so the alarm tracks the
 * swinging room the boat actually has. Only the drop is an edge: once the
 * anchor is down, an operator raising it by hand is left alone until the chain
 * comes all the way in and goes out again.
 */
function planAnchorAction(state, metres, position, scope) {
    if (!(metres > 0)) {
        return state.deployed
            ? { action: { kind: 'raise' }, state: { deployed: false } }
            : { action: { kind: 'none' }, state };
    }
    const radius = Math.round(metres * scope);
    if (!state.deployed) {
        // Cannot drop without knowing where the boat is; stay undeployed and try
        // again on the next frame rather than inventing a position.
        return position
            ? {
                action: { kind: 'drop', position, radius },
                state: { deployed: true, radius }
            }
            : { action: { kind: 'none' }, state };
    }
    if (radius !== state.radius) {
        return {
            action: { kind: 'setRadius', radius },
            state: { deployed: true, radius }
        };
    }
    return { action: { kind: 'none' }, state };
}
/** Hoeken's message when the operator raised the anchor behind our back. */
const NO_ANCHOR_DOWN = /no anchor is currently dropped/i;
function isAnchorGone(message) {
    return NO_ANCHOR_DOWN.test(message ?? '');
}
async function applyAnchorAction(app, action, source = exports.DEFAULT_ANCHOR_ALARM_SOURCE) {
    if (action.kind === 'none') {
        return { status: 'ok' };
    }
    const path = action.kind === 'setRadius' ? decode_1.ANCHOR_MAX_RADIUS_PATH : decode_1.ANCHOR_POSITION_PATH;
    const value = action.kind === 'drop'
        ? {
            latitude: action.position.latitude,
            longitude: action.position.longitude,
            // Hoeken's handler builds a circle zone out of this, so it has to be
            // present even though the anchor position itself does not need it.
            radius: action.radius
        }
        : action.kind === 'setRadius'
            ? action.radius
            : null;
    try {
        const reply = (await app.putPath(`${SELF_CONTEXT}.${path}`, value, () => undefined, source));
        const statusCode = reply?.statusCode;
        if (statusCode === undefined || statusCode === 200) {
            app.debug(`anchor alarm: ${action.kind} on ${path}`);
            return { status: 'ok' };
        }
        if (statusCode === 405) {
            app.debug(`nothing handles ${path} for ${source}`);
            return { status: 'unavailable' };
        }
        app.debug(`anchor alarm refused ${action.kind} on ${path}: ${statusCode} ${reply.message ?? ''}`.trim());
        return { status: 'refused', message: reply.message };
    }
    catch (error) {
        app.debug(`anchor alarm ${action.kind} on ${path} failed: ${error.message}`);
        return { status: 'unavailable' };
    }
}
/**
 * Tracks the anchor alarm's state and keeps it in step with the chain counter.
 *
 * Once nothing is listening the bridge stops trying, so a boat without an
 * anchor alarm is not making a doomed PUT on every frame.
 */
class AnchorAlarmBridge {
    constructor(app, scope, source = exports.DEFAULT_ANCHOR_ALARM_SOURCE, readInitialState) {
        this.app = app;
        this.scope = scope;
        this.source = source;
        this.readInitialState = readInitialState;
        this.state = exports.IDLE;
        this.disabled = false;
        /**
         * Set when the alarm says it has no anchor down even though we think one is.
         * That means somebody raised it by hand, so we stop nudging until the chain
         * comes all the way in and a new deployment is genuinely ours to make.
         */
        this.paused = false;
        this.initialized = false;
        this.initAttempts = 0;
        this.armed = readInitialState === undefined;
    }
    isDisabled() {
        return this.disabled;
    }
    initialize() {
        if (this.initialized) {
            return true;
        }
        if (!this.readInitialState) {
            this.initialized = true;
            return true;
        }
        const initial = this.readInitialState();
        if (initial === undefined) {
            // The alarm has not published its state yet (it may start after us), so
            // wait a few frames rather than treating silence as "no anchor down".
            this.initAttempts += 1;
            if (this.initAttempts < INITIAL_STATE_ATTEMPTS) {
                return false;
            }
        }
        this.initialized = true;
        if (initial?.deployed) {
            this.state = initial;
            this.paused = false;
        }
        else {
            // Starting with no anchor: only a genuine 0 -> positive edge may drop.
            this.armed = false;
        }
        return true;
    }
    async update(metres, position) {
        if (this.disabled) {
            return;
        }
        if (!this.initialize()) {
            return;
        }
        if (!(metres > 0)) {
            // Chain fully in. Whatever the alarm made of our raise, the anchor is up
            // and the next deployment is a fresh one, so reset rather than trusting
            // an acknowledgement we may never get.
            const wasDeployed = this.state.deployed;
            this.armed = true;
            this.paused = false;
            this.state = exports.IDLE;
            if (wasDeployed) {
                await applyAnchorAction(this.app, { kind: 'raise' }, this.source);
            }
            return;
        }
        if (this.paused) {
            return;
        }
        // A positive reading at startup is not proof that anything went out: the
        // counter may be holding the previous deployment's value. Wait for it to
        // pass through zero unless the alarm already has an anchor we adopted.
        if (!this.state.deployed && !this.armed) {
            return;
        }
        const { action, state } = planAnchorAction(this.state, metres, position, this.scope);
        if (action.kind === 'none') {
            this.state = state;
            return;
        }
        const result = await applyAnchorAction(this.app, action, this.source);
        switch (result.status) {
            case 'ok':
                this.state = state;
                return;
            case 'unavailable':
                this.disabled = true;
                this.app.debug(`no anchor alarm is listening as ${this.source}; not driving one any further`);
                return;
            case 'refused':
                // A refused drop is worth retrying — the boat may have no GPS fix yet,
                // and Hoeken's refuses to drop outside the requested zone.
                //
                // A refused resize is only permanent when the alarm says the anchor is
                // gone; that means the operator raised it by hand. "Boat is outside the
                // watch zone." and "no GPS position available" are transient, so retry
                // them on the next reading instead of freezing the old radius.
                if (action.kind === 'setRadius' && isAnchorGone(result.message)) {
                    this.paused = true;
                    this.app.debug('anchor alarm has no anchor down; leaving it alone until the chain comes in');
                }
                return;
        }
    }
    reset() {
        this.state = exports.IDLE;
        this.disabled = false;
        this.paused = false;
        this.initialized = false;
        this.initAttempts = 0;
        this.armed = this.readInitialState === undefined;
    }
}
exports.AnchorAlarmBridge = AnchorAlarmBridge;
