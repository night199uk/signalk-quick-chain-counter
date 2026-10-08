/**
 * Plugin entry point.
 *
 * The server loads a plugin with `require()` and takes `mod.default ?? mod`, so
 * this exports the factory function as the module itself.
 */
import quickChainCounter from './plugin';
export = quickChainCounter;
