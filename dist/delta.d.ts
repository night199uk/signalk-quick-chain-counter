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
export interface SignalKDelta {
    updates: SignalKUpdate[];
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
export declare function buildRodeLengthDelta(chainCount: ChainCount, timestamp?: string): SignalKDelta;
/**
 * Read a `navigation.position` value, rejecting anything that is not a usable
 * latitude/longitude pair. Returns undefined rather than a partial position, so
 * a bad fix cannot become an anchor location.
 */
export declare function readVesselPosition(value: unknown): VesselPosition | undefined;
