# signalk-quick-chain-counter

A Signal K plugin that reads the **Quick PCS chain counter** straight off a
SocketCAN interface and publishes the deployed chain length to Signal K.

## What it does

Quick windlasses report how much chain is out in a single CAN frame, message
type `0x6C1`. This plugin listens for that frame and publishes:

| Signal K path | Meaning |
|---|---|
| `navigation.anchor.rodeDeployed` | Length of chain currently deployed, in **metres** |

Quick reports the length in either metres or feet, and says which in the same
frame. Feet are converted; the value is never relabelled, so 107 ft arrives as
32.6136 m rather than 107 m.

## Why it exists

Quick support is not in a released version of canboat or canboatjs yet, so the
Signal K server cannot decode Quick frames itself. This plugin decodes the one
frame that is understood, and nothing else.

## Requirements

- Linux, with the Quick devices on a SocketCAN interface the server can open.
- A Signal K server, which is what supplies the SocketCAN binding (see below).
- The interface must exist and be up, for example:

  ```sh
  sudo ip link set can0 up type can bitrate 250000
  ```

## Install

Install it from the Signal K app store, or:

```sh
cd ~/.signalk
npm install signalk-quick-chain-counter
```

The plugin itself has **no dependencies**, so installation needs no compiler and
no network access beyond the package itself.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| **CAN interface** | `can0` | The interface the Quick devices are on |
| **canboatjs location** | *(auto)* | Only set this if the automatic lookup fails |

## The one assumption worth knowing

**Point this plugin at the bus the Quick devices are on, and nothing else.**

Quick identifiers are standard 11-bit CAN frames, and canboatjs' channel class
does not report whether a frame was standard or extended. On a dedicated Quick
bus that does not matter: every `0x6C1` frame there is a Quick frame. On a bus
carrying other traffic, an extended frame that happened to use the value
`0x6C1` would also be accepted. Keep the Quick devices on their own interface,
as the Quick protocol assumes, and this cannot arise.

## How it gets at the CAN bus

The native SocketCAN binding is **borrowed from the `@canboat/canboatjs` the
server already installed and built**, rather than declared as a dependency.

That is not an accident. The server installs plugins with
`npm --save --ignore-scripts`, so a plugin can never build a native dependency
at install time — a dependency that compiles an addon would arrive without it
and fail at startup. `@canboat/canboatjs` is a hard dependency of the server and
its own image build asserts the addon exists, so borrowing it is both simpler
and more reliable than shipping prebuilt binaries.

The lookup is dynamic, because a plugin's module resolution paths do not include
the server's `node_modules`: the server installs plugins under its config
directory, which is a sibling of its installation rather than a parent. The
server's own main-module paths do include it, so those are searched first.

If the lookup ever fails, the plugin reports it in its status and the
**canboatjs location** setting overrides the search.

## Development

```sh
npm install
npm test          # mocha
npm run build     # tsc -> dist/
```

The decoder, the delta shaping and the plugin lifecycle are unit tested. The
native read path is not: it needs a real (or virtual) CAN interface, which a
build machine generally does not have.

## Licence

Apache-2.0.
