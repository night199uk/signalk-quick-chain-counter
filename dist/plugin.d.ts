import { CanFrame } from './canReader';
import { ChainUnitOverride } from './decode';
import { SignalKDelta, SignalKMetaValue } from './delta';
export declare const PLUGIN_ID = "signalk-quick-chain-counter";
export declare const DEFAULT_CAN_INTERFACE = "can0";
/** Watch zone radius as a multiple of the rode out: the swinging room. */
export declare const DEFAULT_RADIUS_SCOPE = 1;
/** Alarm if no 0x6C1 frame arrives for this long while an engine is running. */
export declare const DEFAULT_CAN_TIMEOUT_SECONDS = 30;
/** Revolutions (Hz) above which an engine counts as running. */
export declare const DEFAULT_ENGINE_REVOLUTIONS_HZ = 1;
/** The slice of the server API this plugin uses. */
export interface PluginApp {
    debug(...args: unknown[]): void;
    error(...args: unknown[]): void;
    setPluginStatus(message: string): void;
    setPluginError(message: string): void;
    handleMessage(pluginId: string, message: unknown): void;
    getSelfPath(path: string): unknown;
    /**
     * Persist default metadata for a path. Older servers do not expose this, in
     * which case the plugin falls back to publishing a meta delta.
     */
    setDefaultMetadata?(path: string, value: SignalKMetaValue): Promise<boolean>;
    putPath(path: string, value: unknown, updateCb: (err?: Error) => void, source: string): Promise<unknown>;
}
export interface PluginConfig {
    canInterface?: string;
    canboatjsPath?: string;
    driveAnchorAlarm?: boolean;
    radiusScope?: number;
    chainUnits?: ChainUnitOverride;
    requireDepthBeforeDrop?: boolean;
    canTimeoutSeconds?: number;
    engineRevolutionsThreshold?: number;
    anchorAlarmSource?: string;
}
export interface QuickChainCounterPlugin {
    id: string;
    name: string;
    description: string;
    schema(): object;
    start(config: PluginConfig): void;
    stop(): void;
}
export declare const CONFIG_SCHEMA: {
    type: string;
    properties: {
        canInterface: {
            type: string;
            title: string;
            description: string;
            default: string;
        };
        driveAnchorAlarm: {
            type: string;
            title: string;
            description: string;
            default: boolean;
        };
        radiusScope: {
            type: string;
            title: string;
            description: string;
            default: number;
        };
        chainUnits: {
            type: string;
            title: string;
            enum: string[];
            default: string;
            description: string;
        };
        requireDepthBeforeDrop: {
            type: string;
            title: string;
            description: string;
            default: boolean;
        };
        canTimeoutSeconds: {
            type: string;
            title: string;
            description: string;
            default: number;
        };
        engineRevolutionsThreshold: {
            type: string;
            title: string;
            description: string;
            default: number;
        };
        anchorAlarmSource: {
            type: string;
            title: string;
            description: string;
            default: string;
        };
        canboatjsPath: {
            type: string;
            title: string;
            description: string;
        };
    };
};
/**
 * Decode one raw frame into the delta for the deployed chain length.
 *
 * Returns undefined when the frame is not a chain count packet or is too short
 * to hold one, so a listener only has to ask once whether there is anything to
 * publish.
 */
export declare function frameToDelta(frame: CanFrame, timestamp?: string): SignalKDelta | undefined;
/**
 * True when any propulsion instance is turning above the threshold.
 *
 * Signal K stores `propulsion.<id>.revolutions` in Hz, so the default
 * threshold of 1 is 60 RPM.
 */
export declare function anyEngineRunning(propulsion: unknown, threshold: number): boolean;
/**
 * True when an engine has been running and no frame has arrived for the
 * timeout. The clock starts at whichever is later: the last frame or the
 * moment the engine started, so starting an engine does not alarm on a stale
 * frame from the previous run.
 */
export declare function canBusDataOverdue(now: number, lastFrameAt: number | undefined, engineRunningSince: number | undefined, timeoutMs: number): boolean;
export default function quickChainCounter(app: PluginApp): QuickChainCounterPlugin;
