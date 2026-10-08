import { VesselPosition } from './delta';
/** The plugin id the anchor alarm handlers are registered under by default. */
export declare const DEFAULT_ANCHOR_ALARM_SOURCE = "hoekens-anchor-alarm";
export type AnchorAction = {
    kind: 'drop';
    position: VesselPosition;
    radius: number;
} | {
    kind: 'setRadius';
    radius: number;
} | {
    kind: 'raise';
} | {
    kind: 'none';
};
export interface AnchorAlarmState {
    deployed: boolean;
    radius?: number;
}
export declare const IDLE: AnchorAlarmState;
/**
 * Decide what the anchor alarm should do about one chain counter reading.
 *
 * As the chain spools out the watch zone grows with it, so the alarm tracks the
 * swinging room the boat actually has. Only the drop is an edge: once the
 * anchor is down, an operator raising it by hand is left alone until the chain
 * comes all the way in and goes out again.
 */
export declare function planAnchorAction(state: AnchorAlarmState, metres: number, position: VesselPosition | undefined, scope: number): {
    action: AnchorAction;
    state: AnchorAlarmState;
};
/** The slice of the server API needed to drive another plugin. */
export interface PutApp {
    putPath(path: string, value: unknown, updateCb: (err?: Error) => void, source: string): Promise<unknown>;
    debug(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
/**
 * What came back from trying to drive the anchor alarm.
 *
 * - `ok`          the alarm accepted it
 * - `refused`     an alarm answered but would not (502) — worth retrying, the
 *                 boat may simply have no GPS fix yet
 * - `unavailable` nothing is listening (405), or the call threw — stop trying
 */
export type ApplyResult = 'ok' | 'refused' | 'unavailable';
export declare function applyAnchorAction(app: PutApp, action: AnchorAction, source?: string): Promise<ApplyResult>;
/**
 * Tracks the anchor alarm's state and keeps it in step with the chain counter.
 *
 * Once nothing is listening the bridge stops trying, so a boat without an
 * anchor alarm is not making a doomed PUT on every frame.
 */
export declare class AnchorAlarmBridge {
    private readonly app;
    private readonly scope;
    private readonly source;
    private state;
    private disabled;
    /**
     * Set when the alarm says it has no anchor down even though we think one is.
     * That means somebody raised it by hand, so we stop nudging until the chain
     * comes all the way in and a new deployment is genuinely ours to make.
     */
    private paused;
    constructor(app: PutApp, scope: number, source?: string);
    isDisabled(): boolean;
    update(metres: number, position: VesselPosition | undefined): Promise<void>;
    reset(): void;
}
