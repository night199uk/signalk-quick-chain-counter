# Changelog

## 0.1.0

First release.

- Reads the Quick PCS chain count packet (`0x6C1`) directly from a SocketCAN
  interface, so chain counter data reaches Signal K without waiting for Quick
  support to land in canboat and canboatjs.
- Publishes `navigation.anchor.rodeDeployed` in metres, converting when the
  frame reports feet.
- No runtime dependencies: the native SocketCAN binding is taken from the
  `@canboat/canboatjs` the server already installed and built.
