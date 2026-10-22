import { expect } from 'chai'
import {
  applyAnchorAction,
  AnchorAction,
  AnchorAlarmBridge,
  AnchorAlarmState,
  IDLE,
  planAnchorAction,
  PutApp,
  readAnchorAlarmState
} from '../src/anchorAlarm'
import { VesselPosition } from '../src/delta'

const HERE: VesselPosition = { latitude: 37.8199, longitude: -122.4783 }
const NO_POSITION = undefined

/**
 * Position is deliberately not optional here: a default argument would turn an
 * explicit `undefined` (meaning "no fix") back into a real position.
 */
function plan(
  state: AnchorAlarmState,
  metres: number,
  position: VesselPosition | undefined,
  scope = 1
) {
  return planAnchorAction(state, metres, position, scope)
}

describe('readAnchorAlarmState', () => {
  function reader(values: Record<string, unknown>) {
    return (path: string) => values[path]
  }

  it('waits until the alarm has published something', () => {
    expect(readAnchorAlarmState(() => undefined)).to.equal(undefined)
  })

  it('reads an anchor that is already down and its circle radius', () => {
    const state = readAnchorAlarmState(
      reader({
        'navigation.anchor.state.value': 'on',
        'navigation.anchor.position.value': { latitude: 1, longitude: 2 },
        'navigation.anchor.maxRadius.value': 48,
        'navigation.anchor.watchZone.value': { type: 'circle', radius: 48 }
      })
    )

    expect(state).to.deep.equal({ deployed: true, radius: 48 })
  })

  it('falls back to the watch zone radius', () => {
    const state = readAnchorAlarmState(
      reader({
        'navigation.anchor.state.value': 'on',
        'navigation.anchor.watchZone.value': { type: 'circle', radius: 32 }
      })
    )

    expect(state).to.deep.equal({ deployed: true, radius: 32 })
  })

  it('treats an off alarm as no anchor even if a position is retained', () => {
    const state = readAnchorAlarmState(
      reader({
        'navigation.anchor.state.value': 'off',
        'navigation.anchor.position.value': { latitude: 1, longitude: 2 }
      })
    )

    expect(state).to.deep.equal({ deployed: false })
  })

  it('uses the position when the alarm does not publish a state', () => {
    const state = readAnchorAlarmState(
      reader({
        'navigation.anchor.position.value': { latitude: 1, longitude: 2 }
      })
    )

    expect(state).to.deep.equal({ deployed: true })
  })
})

describe('planAnchorAction', () => {
  it('drops the anchor when the chain first goes out', () => {
    const { action, state } = plan(IDLE, 30, HERE)

    expect(action).to.deep.equal({ kind: 'drop', position: HERE, radius: 30 })
    expect(state).to.deep.equal({ deployed: true, radius: 30 })
  })

  it('waits for a position before dropping', () => {
    // Better to try again next frame than to invent where the boat is.
    const { action, state } = plan(IDLE, 30, NO_POSITION)

    expect(action).to.deep.equal({ kind: 'none' })
    expect(state.deployed).to.equal(false)
  })

  it('grows the zone as more chain goes out', () => {
    const { action, state } = plan({ deployed: true, radius: 30 }, 45, HERE)

    expect(action).to.deep.equal({ kind: 'setRadius', radius: 45 })
    expect(state).to.deep.equal({ deployed: true, radius: 45 })
  })

  it('shrinks the zone as chain comes back in', () => {
    const { action } = plan({ deployed: true, radius: 45 }, 20, HERE)

    expect(action).to.deep.equal({ kind: 'setRadius', radius: 20 })
  })

  it('says nothing while the length is unchanged', () => {
    expect(plan({ deployed: true, radius: 30 }, 30, HERE).action).to.deep.equal({
      kind: 'none'
    })
  })

  it('ignores sub-metre chatter', () => {
    // Chain counters wobble; the rounded radius absorbs it.
    expect(
      plan({ deployed: true, radius: 30 }, 30.4, HERE).action
    ).to.deep.equal({ kind: 'none' })
  })

  it('applies the scope to the radius', () => {
    const { action } = plan(IDLE, 30, HERE, 1.5)

    expect(action).to.deep.equal({ kind: 'drop', position: HERE, radius: 45 })
  })

  it('raises the anchor when the chain comes all the way in', () => {
    const { action, state } = plan({ deployed: true, radius: 30 }, 0, HERE)

    expect(action).to.deep.equal({ kind: 'raise' })
    expect(state.deployed).to.equal(false)
  })

  it('does nothing when the chain is already in', () => {
    expect(plan(IDLE, 0, HERE).action).to.deep.equal({ kind: 'none' })
  })
})

describe('applyAnchorAction', () => {
  function fakeApp(statusCode = 200, message?: string) {
    const calls: Array<{ path: string; value: unknown; source: string }> = []
    const app: PutApp = {
      putPath: async (path, value, _cb, source) => {
        calls.push({ path, value, source })
        return { statusCode, message }
      },
      debug: () => undefined,
      error: () => undefined
    }
    return { app, calls }
  }

  it('drops the anchor with the radius Hoeken builds a zone from', async () => {
    const { app, calls } = fakeApp()

    const result = await applyAnchorAction(app, {
      kind: 'drop',
      position: HERE,
      radius: 30
    })

    expect(result).to.deep.equal({ status: 'ok' })
    expect(calls).to.deep.equal([
      {
        path: 'vessels.self.navigation.anchor.position',
        value: {
          latitude: HERE.latitude,
          longitude: HERE.longitude,
          radius: 30
        },
        source: 'hoekens-anchor-alarm'
      }
    ])
  })

  it('raises the anchor by putting null', async () => {
    const { app, calls } = fakeApp()

    await applyAnchorAction(app, { kind: 'raise' })

    expect(calls).to.deep.equal([
      {
        path: 'vessels.self.navigation.anchor.position',
        value: null,
        source: 'hoekens-anchor-alarm'
      }
    ])
  })

  it('resizes the zone through maxRadius, not by re-dropping', async () => {
    const { app, calls } = fakeApp()

    await applyAnchorAction(app, { kind: 'setRadius', radius: 45 })

    expect(calls).to.deep.equal([
      {
        path: 'vessels.self.navigation.anchor.maxRadius',
        value: 45,
        source: 'hoekens-anchor-alarm'
      }
    ])
  })

  it('reports nothing listening as unavailable', async () => {
    const { app } = fakeApp(405)

    expect(await applyAnchorAction(app, { kind: 'raise' })).to.deep.equal({
      status: 'unavailable'
    })
  })

  it('carries the alarm message on a refusal', async () => {
    const { app } = fakeApp(502, 'Boat is outside the watch zone.')

    expect(
      await applyAnchorAction(app, { kind: 'drop', position: HERE, radius: 30 })
    ).to.deep.equal({
      status: 'refused',
      message: 'Boat is outside the watch zone.'
    })
  })
})

describe('AnchorAlarmBridge', () => {
  function fakeApp(statusCode = 200, message?: string) {
    const calls: Array<{ path: string; value: unknown; source: string }> = []
    const app: PutApp = {
      putPath: async (path, value, _cb, source) => {
        calls.push({ path, value, source })
        return { statusCode, message }
      },
      debug: () => undefined,
      error: () => undefined
    }
    return { app, calls }
  }

  it('drops once, then only resizes as the chain runs out', async () => {
    const { app, calls } = fakeApp()
    const bridge = new AnchorAlarmBridge(app, 1)

    await bridge.update(30, HERE)
    await bridge.update(30, HERE)
    await bridge.update(45, HERE)
    await bridge.update(0, HERE)

    expect(calls.map((c) => [c.path, typeof c.value])).to.deep.equal([
      ['vessels.self.navigation.anchor.position', 'object'],
      ['vessels.self.navigation.anchor.maxRadius', 'number'],
      ['vessels.self.navigation.anchor.position', 'object']
    ])
    expect(calls[2].value).to.equal(null)
  })

  it('stops trying once nothing is listening', async () => {
    const { app, calls } = fakeApp(405)
    const bridge = new AnchorAlarmBridge(app, 1)

    await bridge.update(30, HERE)
    await bridge.update(45, HERE)
    await bridge.update(0, HERE)

    expect(calls).to.have.length(1)
    expect(bridge.isDisabled()).to.equal(true)
  })

  it('retries a refused drop on the next reading', async () => {
    const { app, calls } = fakeApp(502)
    const bridge = new AnchorAlarmBridge(app, 1)

    await bridge.update(30, HERE)
    await bridge.update(30, HERE)

    // Both attempts are drops: the first was refused, so the state never moved
    // to deployed and the second tries again.
    expect(calls).to.have.length(2)
    expect(bridge.isDisabled()).to.equal(false)
  })

  it('stops resizing when the alarm says no anchor is down', async () => {
    // The operator raised it by hand while chain was still out. Fighting them
    // by re-dropping or re-resizing would be wrong.
    const { app, calls } = fakeApp()
    let statusCode = 200
    let message: string | undefined
    app.putPath = async (path, value) => {
      calls.push({ path, value, source: 'hoekens-anchor-alarm' })
      return { statusCode, message }
    }
    const bridge = new AnchorAlarmBridge(app, 1)

    await bridge.update(30, HERE) // drop, accepted
    statusCode = 502 // anchor raised by hand from here on
    message = 'no anchor is currently dropped'
    await bridge.update(45, HERE) // resize refused
    await bridge.update(60, HERE) // and we stop asking
    await bridge.update(75, HERE)

    expect(calls.map((c) => c.path)).to.deep.equal([
      'vessels.self.navigation.anchor.position',
      'vessels.self.navigation.anchor.maxRadius'
    ])
  })

  it('retries a resize refused because the boat is outside the zone', async () => {
    const { app, calls } = fakeApp()
    let statusCode = 200
    let message: string | undefined
    app.putPath = async (path, value) => {
      calls.push({ path, value, source: 'hoekens-anchor-alarm' })
      return { statusCode, message }
    }
    const bridge = new AnchorAlarmBridge(app, 1)

    await bridge.update(30, HERE) // drop
    statusCode = 502
    message = 'Boat is outside the watch zone.'
    await bridge.update(45, HERE) // transient refusal
    await bridge.update(60, HERE) // still worth trying

    expect(calls.map((c) => c.path)).to.deep.equal([
      'vessels.self.navigation.anchor.position',
      'vessels.self.navigation.anchor.maxRadius',
      'vessels.self.navigation.anchor.maxRadius'
    ])
  })

  it('takes over again after the chain has been all the way in', async () => {
    const { app, calls } = fakeApp()
    let statusCode = 200
    let message: string | undefined
    app.putPath = async (path, value) => {
      calls.push({ path, value, source: 'hoekens-anchor-alarm' })
      return { statusCode, message }
    }
    const bridge = new AnchorAlarmBridge(app, 1)

    await bridge.update(30, HERE)
    statusCode = 502
    message = 'no anchor is currently dropped'
    await bridge.update(45, HERE) // refused, paused
    await bridge.update(0, HERE) // chain in: forgiven
    statusCode = 200
    message = undefined
    await bridge.update(20, HERE) // a genuinely new deployment

    expect(calls[calls.length - 1].path).to.equal(
      'vessels.self.navigation.anchor.position'
    )
    expect(calls[calls.length - 1].value).to.deep.include({ radius: 20 })
  })

  it('adopts an anchor that is already down instead of re-dropping', async () => {
    const { app, calls } = fakeApp()
    const bridge = new AnchorAlarmBridge(app, 1, undefined, () => ({
      deployed: true,
      radius: 48
    }))

    await bridge.update(20, HERE)

    expect(calls).to.deep.equal([
      {
        path: 'vessels.self.navigation.anchor.maxRadius',
        value: 20,
        source: 'hoekens-anchor-alarm'
      }
    ])
  })

  it('waits for the alarm to publish its state', async () => {
    const { app, calls } = fakeApp()
    let initial: AnchorAlarmState | undefined
    const bridge = new AnchorAlarmBridge(app, 1, undefined, () => initial)

    await bridge.update(30, HERE)
    expect(calls).to.be.empty

    initial = { deployed: true, radius: 30 }
    await bridge.update(30, HERE) // adopted, nothing to change
    expect(calls).to.be.empty

    await bridge.update(45, HERE)
    expect(calls).to.deep.equal([
      {
        path: 'vessels.self.navigation.anchor.maxRadius',
        value: 45,
        source: 'hoekens-anchor-alarm'
      }
    ])
  })

  it('does not drop on a stale positive reading when the alarm is off', async () => {
    const { app, calls } = fakeApp()
    const bridge = new AnchorAlarmBridge(app, 1, undefined, () => ({
      deployed: false
    }))

    await bridge.update(30, HERE)
    expect(calls).to.be.empty

    await bridge.update(0, HERE) // chain seen in: now armed
    expect(calls).to.be.empty

    await bridge.update(30, HERE)
    expect(calls.map((c) => c.path)).to.deep.equal([
      'vessels.self.navigation.anchor.position'
    ])
  })

  it('drops normally when the alarm starts off and the chain starts in', async () => {
    const { app, calls } = fakeApp()
    const bridge = new AnchorAlarmBridge(app, 1, undefined, () => ({
      deployed: false
    }))

    await bridge.update(0, HERE)
    expect(calls).to.be.empty

    await bridge.update(30, HERE)
    expect(calls[0].value).to.deep.include({ radius: 30 })
  })

  it('raises an adopted anchor when the chain comes in', async () => {
    const { app, calls } = fakeApp()
    const bridge = new AnchorAlarmBridge(app, 1, undefined, () => ({
      deployed: true,
      radius: 30
    }))

    await bridge.update(0, HERE)

    expect(calls).to.deep.equal([
      {
        path: 'vessels.self.navigation.anchor.position',
        value: null,
        source: 'hoekens-anchor-alarm'
      }
    ])
  })

  it('does nothing at all when disabled', async () => {
    const { app, calls } = fakeApp()
    const bridge = new AnchorAlarmBridge(app, 1)

    await bridge.update(0, HERE)

    expect(calls).to.be.empty
  })

  it('forgets everything on reset', async () => {
    const { app } = fakeApp()
    const bridge = new AnchorAlarmBridge(app, 1)

    await bridge.update(30, HERE)
    bridge.reset()
    await bridge.update(30, HERE)

    expect(bridge.isDisabled()).to.equal(false)
  })
})
