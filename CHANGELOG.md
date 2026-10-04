# Changelog

## 0.1.0

First release.

- Reads the Quick PCS chain count packet (`0x6C1`) directly from a SocketCAN
  interface, so chain counter data reaches Signal K without waiting for Quick
  support to land in canboat and canboatjs.
- Publishes `navigation.anchor.rodeLength` in metres, converting when the frame
  reports feet.
- Drives an anchor alarm from the chain counter: drops it when the chain goes
  out, grows and shrinks the watch zone as chain is let out and taken in, and
  raises it when the chain comes all the way in. Hoekens Anchor Alarm is
  declared under `signalk.requires` so the app store installs it too.
- No runtime dependencies: the native SocketCAN binding is taken from the
  `@canboat/canboatjs` the server already installed and built.
