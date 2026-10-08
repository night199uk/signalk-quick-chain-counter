export interface CanFrame {
    id: number;
    data: Buffer;
}
/** Only the chain count identifier is of interest; see the file comment. */
export declare function isChainCountFrame(id: number): boolean;
/**
 * Candidate `node_modules` directories to search for canboatjs.
 *
 * A plugin's own resolution paths do not include the server's node_modules: the
 * server installs plugins under its config directory, which is a sibling of its
 * installation, not a parent. The server's own main module paths do, so they
 * lead the list.
 */
export declare function candidateLookupPaths(extra?: string[]): string[];
/** Locate @canboat/canboatjs, or undefined if it is not installed. */
export declare function resolveCanboatjsDir(extra?: string[]): string | undefined;
export interface CanReaderOptions {
    canInterface: string;
    /** Explicit @canboat/canboatjs location, if auto-detection is not wanted. */
    addonDir?: string;
    onFrame(frame: CanFrame): void;
    onError(error: Error): void;
    debug(...args: unknown[]): void;
}
/**
 * Opens one CAN interface and reports the chain count frames arriving on it.
 */
export declare class CanReader {
    private readonly options;
    private channel;
    constructor(options: CanReaderOptions);
    start(): void;
    stop(): void;
}
