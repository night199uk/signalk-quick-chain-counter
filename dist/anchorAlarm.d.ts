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
 * Read the anchor alarm's current state from the Signal K tree.
 *
 * Returns undefined until the alarm has published anything, so a plugin that
 * starts before the alarm can wait a frame instead of mistaking "not started
 * yet" for "no anchor down".
 */
export declare function readAnchorAlarmState(getSelfPath: (path: string) => unknown): AnchorAlarmState | undefined;
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
 * - `refused`     an alarm answered but would not (502), with its reason. Some
 *                 refusals are transient (no GPS, boat outside the new zone)
 *                 and worth retrying; "no anchor is currently dropped" is not.
 * - `unavailable` nothing is listening (405), or the call threw — stop trying
 */
export type ApplyResult = {
    status: 'ok';
} | {
    status: 'refused';
    message?: string;
} | {
    status: 'unavailable';
};
export declare function applyAnchorAction(app: PutApp, action: AnchorAction, source?: string): Promise<ApplyResult>;
/**
 * Reads the alarm's current state so the bridge can adopt an anchor that
 * survived a plugin or server restart instead of dropping a new one over it.
 * Omit it to keep the old "first positive reading is a drop" behaviour.
 */
export type InitialStateReader = () => AnchorAlarmState | undefined;
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
    private readonly readInitialState?;
    private state;
    private disabled;
    /**
     * Set when the alarm says it has no anchor down even though we think one is.
     * That means somebody raised it by hand, so we stop nudging until the chain
     * comes all the way in and a new deployment is genuinely ours to make.
     */
    private paused;
    private initialized;
    private initAttempts;
    /**
     * False until the chain has been seen fully in. A plugin restart while the
     * counter holds a stale positive value must not look like a fresh drop.
     */
    private armed;
    constructor(app: PutApp, scope: number, source?: string, readInitialState?: InitialStateReader | undefined);
    isDisabled(): boolean;
    private initialize;
    update(metres: number, position: VesselPosition | undefined): Promise<void>;
    reset(): void;
}
