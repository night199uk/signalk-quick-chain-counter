import { ChainCount } from './decode';
export interface SignalKSource {
    label: string;
    type: string;
    pgn: number;
    src: string;
}
export interface SignalKUpdate {
    source?: SignalKSource;
    timestamp: string;
    values: Array<{
        path: string;
        value: unknown;
    }>;
}
/** Metadata is published in its own update, without a `values` array. */
export interface SignalKMetaUpdate {
    timestamp: string;
    meta: Array<{
        path: string;
        value: SignalKMetaValue;
    }>;
}
export interface SignalKMetaValue {
    units?: string;
    description?: string;
    /** Seconds before the server considers the value stale; 0 never expires. */
    timeout?: number | 'auto';
    /** Silence means the last reading still stands, not that it failed. */
    updateContract?: 'periodic' | 'event';
}
export interface SignalKDelta {
    updates: SignalKUpdate[];
}
export interface SignalKMetaDelta {
    updates: SignalKMetaUpdate[];
}
/** A vessel position, as `navigation.position` carries it. */
export interface VesselPosition {
    latitude: number;
    longitude: number;
}
/**
 * The source for anything this plugin publishes about the chain.
 *
 * The talker identifier is payload rather than a CAN source address, but it is
 * the closest thing to a device reference a Quick frame carries.
 */
export declare function quickSource(chainCount: ChainCount): SignalKSource;
/**
 * The deployed chain length, in metres.
 *
 * The anchor position, state and watch zone are the anchor alarm's to publish,
 * not ours; this is only the reading straight off the bus.
 */
export declare function buildRodeLengthDelta(chainCount: ChainCount, timestamp?: string, metres?: number): SignalKDelta;
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
export declare const RODE_LENGTH_META: SignalKMetaValue;
/**
 * The metadata delta for `navigation.anchor.rodeLength`.
 *
 * Published once when the plugin starts, rather than attached to every reading:
 * metadata is per path, and the chain counter can send several frames a second.
 */
export declare function buildRodeLengthMetaDelta(timestamp?: string): SignalKMetaDelta;
/**
 * Read a `navigation.position` value, rejecting anything that is not a usable
 * latitude/longitude pair. Returns undefined rather than a partial position, so
 * a bad fix cannot become an anchor location.
 */
export declare function readVesselPosition(value: unknown): VesselPosition | undefined;
