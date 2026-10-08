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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CanReader = void 0;
exports.isChainCountFrame = isChainCountFrame;
exports.candidateLookupPaths = candidateLookupPaths;
exports.resolveCanboatjsDir = resolveCanboatjsDir;
/**
 * Reads raw frames from a SocketCAN interface.
 *
 * The SocketCAN binding is taken from the @canboat/canboatjs that the Signal K
 * server already installed and built. That is deliberate: the server installs
 * plugins with `npm --save --ignore-scripts`, so a plugin can never build its
 * own native dependency at install time. canboatjs is a hard dependency of the
 * server, and its Dockerfile asserts the addon is present, so it is always
 * there to borrow.
 *
 * Configuration, along with the assumption the decoder relies on: this plugin
 * is pointed at the bus the Quick devices are on, and that bus carries Quick
 * traffic only. Every 0x6C1 frame seen there is therefore a Quick frame. Run
 * against a mixed bus and an extended frame that happens to carry the value
 * 0x6C1 would be accepted too; canboatjs' CanChannel does not report the
 * frame type, and a dedicated Quick bus makes that irrelevant.
 */
const path = __importStar(require("path"));
const decode_1 = require("./decode");
/** Only the chain count identifier is of interest; see the file comment. */
function isChainCountFrame(id) {
    return id === decode_1.QUICK_CHAIN_COUNT_CAN_ID;
}
/**
 * Candidate `node_modules` directories to search for canboatjs.
 *
 * A plugin's own resolution paths do not include the server's node_modules: the
 * server installs plugins under its config directory, which is a sibling of its
 * installation, not a parent. The server's own main module paths do, so they
 * lead the list.
 */
function candidateLookupPaths(extra = []) {
    const dirs = [];
    const add = (p) => {
        if (p && !dirs.includes(p)) {
            dirs.push(p);
        }
    };
    extra.forEach(add);
    if (require.main) {
        require.main.paths.forEach(add);
    }
    module.paths.forEach(add);
    // Walk up from whatever we know about the running process, in case the
    // module paths above are unavailable (a worker thread, an unusual launcher).
    const roots = [require.main?.filename, process.argv[1], process.cwd()];
    for (const root of roots) {
        if (!root) {
            continue;
        }
        let dir = path.dirname(root);
        for (let depth = 0; depth < 6; depth++) {
            add(path.join(dir, 'node_modules'));
            const parent = path.dirname(dir);
            if (parent === dir) {
                break;
            }
            dir = parent;
        }
    }
    return dirs;
}
/** Locate @canboat/canboatjs, or undefined if it is not installed. */
function resolveCanboatjsDir(extra = []) {
    try {
        const pkg = require.resolve('@canboat/canboatjs/package.json', {
            paths: candidateLookupPaths(extra)
        });
        return path.dirname(pkg);
    }
    catch {
        return undefined;
    }
}
function loadCanSocketModule(dir) {
    const entry = path.join(dir, 'dist', 'canSocket.js');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(entry);
    if (typeof mod.CanChannel !== 'function') {
        throw new Error(`${entry} does not export CanChannel`);
    }
    return mod;
}
/**
 * Opens one CAN interface and reports the chain count frames arriving on it.
 */
class CanReader {
    constructor(options) {
        this.options = options;
    }
    start() {
        const dir = this.options.addonDir || resolveCanboatjsDir();
        if (!dir) {
            throw new Error('@canboat/canboatjs was not found, so there is no SocketCAN binding to use');
        }
        const { CanChannel } = loadCanSocketModule(dir);
        this.options.debug(`using the SocketCAN binding from ${dir}`);
        this.channel = new CanChannel(this.options.canInterface);
        this.channel.addListener('onMessage', (frame) => {
            if (isChainCountFrame(frame.id)) {
                this.options.onFrame(frame);
            }
        });
        // The channel reports a bus error by stopping; surface it rather than
        // going quiet.
        this.channel.addListener('onStopped', (reason) => this.options.onError(new Error(reason)));
        this.channel.start();
    }
    stop() {
        if (this.channel) {
            this.channel.stop();
            this.channel = undefined;
        }
    }
}
exports.CanReader = CanReader;
