# signalk-quick-chain-counter

A Signal K plugin that reads the **Quick PCS chain counter** straight off a
SocketCAN interface, publishes the deployed chain length, and uses it to drive
an anchor alarm.

## What it does

Quick windlasses report how much chain is out in a single CAN frame, message
type `0x6C1`. This plugin listens for that frame and then:

| | |
|---|---|
| **Publishes** | `navigation.anchor.rodeLength` — deployed chain length, in metres |
| **Drives** | your anchor alarm: drops it when the chain goes out, raises it when the chain comes in, and grows the watch zone as more chain is let out |

The chain length is in metres whatever the device reports: Quick says whether
the value is in metres or feet, and feet are converted rather than relabelled,
so 107 ft arrives as 32.6136 m and not 107 m.

## Why it exists

Quick support is not in a released version of canboat or canboatjs yet, so the
Signal K server cannot decode Quick frames itself. This plugin decodes the one
frame that is understood, and nothing else.

## Requirements

- Linux, with the Quick devices on a SocketCAN interface the server can open:

  ```sh
  sudo ip link set can0 up type can bitrate 250000
  ```

- A Signal K server, which supplies the SocketCAN binding (see below).
- [Hoekens Anchor
  Alarm](https://github.com/hoeken/hoekens-anchor-alarm), declared under
  `signalk.requires` so the app store installs it alongside this plugin and
  flags it when missing. Another plugin that accepts
  `navigation.anchor.position` will do instead — point the **Anchor alarm
  plugin id** setting at it.

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
| **Drive the anchor alarm** | on | Drop/raise/resize an anchor alarm from the chain counter |
| **Watch zone radius, as a multiple of the rode** | `1.0` | The alarm radius is the chain length times this |
| **Anchor alarm plugin id** | `hoekens-anchor-alarm` | Whose `navigation.anchor.position` handler to drive |
| **canboatjs location** | *(auto)* | Only set this if the automatic lookup fails |

## Driving the anchor alarm

Anchor watch is not something this plugin reimplements. It reports how much
chain is over the side and lets an anchor alarm own the drag alarm, the watch
zone and the session log.

Hoekens Anchor Alarm is declared under `signalk.requires`, so the app store
installs it with this plugin and warns when it is missing. It is not an npm
dependency: plugins are not npm dependencies of one another, and a second copy
installed under this plugin's `node_modules` would never be the one the server
had enabled anyway.

It talks to the alarm through the server's action handlers, which is why there
is no HTTP call, no port to discover and no JWT to obtain:

| Chain counter | What the alarm is asked to do |
|---|---|
| goes out (0 → positive) | drop the anchor at the boat's current position, with a circle zone of `rodeLength × radiusScope` |
| more chain out | resize the zone to the new chain length |
| more chain in | resize the zone back down |
| comes all the way in | raise the anchor |

**The drop is an edge, not a state.** If you raise the anchor by hand while
chain is still out, the plugin notices the alarm refusing to resize and leaves
it alone — it will not fight you by re-dropping. It takes over again after the
chain has been all the way in.

**The source is named deliberately.** The server records each PUT handler under
the id of the plugin that registered it, and rejects a PUT with no source as
ambiguous once more than one anchor alarm is installed. Hence the *Anchor alarm
plugin id* setting.

If nothing is listening on that id, the plugin says so once and stops driving an
alarm. Publishing the chain length is unaffected.

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

## Development

```sh
npm install
npm test          # mocha
npm run build     # tsc -> dist/
```

The decoder, the delta shaping, the anchor-alarm planning and the bridge are
unit tested. The native read path is not: it needs a real (or virtual) CAN
interface, which a build machine generally does not have.

## Licence

Apache-2.0.
