# Changelog

## 0.1.3

- Point the package repository/homepage/bugs metadata at
  `night199uk/signalk-quick-chain-counter`, so npm trusted-publishing
  provenance matches the workflow that builds the release.

## 0.1.2

- Decodes the gypsy lap length from `0x6C0` and multiplies the `0x6C1` lap
  count by it. The `0x6C1` value is a lap count, not a chain length; a 13.0-inch
  lap makes 148 laps 160.3 ft (48.87 m), not 148 ft.
- Adds a chain-units fallback override (`auto`/`meters`/`feet`) for devices
  that do not send `0x6C0`, with a total-chain sanity check in `auto`.

## 0.1.0

First release.

- Reads the Quick PCS chain count packet (`0x6C1`) directly from a SocketCAN
  interface, so chain counter data reaches Signal K without waiting for Quick
  support to land in canboat and canboatjs.
- Publishes `navigation.anchor.rodeLength` in metres, converting when the frame
  reports feet.
- Marks `navigation.anchor.rodeLength` as an event-driven, never-stale path
  (`timeout: 0`), so a steady chain length is not nulled by the server's
  staleness enforcer when the counter stops sending frames.
- Drives an anchor alarm from the chain counter: drops it when the chain goes
  out, grows and shrinks the watch zone as chain is let out and taken in, and
  raises it when the chain comes all the way in. Hoekens Anchor Alarm is
  declared under `signalk.requires` so the app store installs it too.
- Adopts an anchor that survived a plugin or server restart instead of
  re-dropping it at the boat's current position, and waits for a real
  0 → positive edge before treating a positive counter reading as a new
  deployment.
- Distinguishes a transient resize refusal (the boat is outside the new zone,
  or there is no GPS fix) from the operator raising the anchor, so a refused
  shrink is retried rather than leaving the old, larger radius in place.
- No runtime dependencies: the native SocketCAN binding is taken from the
  `@canboat/canboatjs` the server already installed and built.
