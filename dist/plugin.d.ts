import { CanFrame } from './canReader';
import { SignalKDelta } from './delta';
export declare const PLUGIN_ID = "signalk-quick-chain-counter";
export declare const DEFAULT_CAN_INTERFACE = "can0";
/** Watch zone radius as a multiple of the rode out: the swinging room. */
export declare const DEFAULT_RADIUS_SCOPE = 1;
/** The slice of the server API this plugin uses. */
export interface PluginApp {
    debug(...args: unknown[]): void;
    error(...args: unknown[]): void;
    setPluginStatus(message: string): void;
    setPluginError(message: string): void;
    handleMessage(pluginId: string, message: unknown): void;
    getSelfPath(path: string): unknown;
    putPath(path: string, value: unknown, updateCb: (err?: Error) => void, source: string): Promise<unknown>;
}
export interface PluginConfig {
    canInterface?: string;
    canboatjsPath?: string;
    driveAnchorAlarm?: boolean;
    radiusScope?: number;
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
export default function quickChainCounter(app: PluginApp): QuickChainCounterPlugin;
