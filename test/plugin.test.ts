import { expect } from 'chai'
import quickChainCounter, {
  anyEngineRunning,
  canBusDataOverdue,
  CONFIG_SCHEMA,
  DEFAULT_CAN_INTERFACE,
  DEFAULT_CAN_TIMEOUT_SECONDS,
  DEFAULT_ENGINE_REVOLUTIONS_HZ,
  frameToDelta,
  PLUGIN_ID,
  PluginApp
} from '../src/plugin'
import {
  buildCanBusAlarmDelta,
  buildRodeLengthDelta,
  buildRodeLengthMetaDelta,
  CAN_BUS_NOTIFICATION_PATH,
  RODE_LENGTH_META
} from '../src/delta'
import { decodeChainCount } from '../src/decode'

const CHAIN_COUNT_FRAME = Buffer.from('C1186B0000000200', 'hex')

function fakeApp() {
  const calls = {
    status: [] as string[],
    errors: [] as string[],
    messages: [] as unknown[],
    debug: [] as unknown[],
    puts: [] as Array<{ path: string; value: unknown }>
  }
  let selfPosition: unknown = undefined
  const app: PluginApp & { setPosition(v: unknown): void } = {
    debug: (...args) => calls.debug.push(args),
    error: (...args) => calls.errors.push(args.join(' ')),
    setPluginStatus: (message) => calls.status.push(message),
    setPluginError: (message) => calls.errors.push(message),
    handleMessage: (_id, message) => calls.messages.push(message),
    getSelfPath: () => selfPosition,
    putPath: async (path, value) => {
      calls.puts.push({ path, value })
      return { statusCode: 200 }
    },
    setPosition: (v) => {
      selfPosition = v
    }
  }
  return { app, calls }
}

describe('plugin contract', () => {
  it('identifies itself the way the server expects', () => {
    const plugin = quickChainCounter(fakeApp().app)

    expect(plugin.id).to.equal(PLUGIN_ID)
    expect(plugin.name).to.be.a('string').that.is.not.empty
    expect(plugin.description).to.be.a('string').that.is.not.empty
    expect(plugin.start).to.be.a('function')
    expect(plugin.stop).to.be.a('function')
    expect(plugin.schema).to.be.a('function')
  })

  it('offers a CAN interface to configure, defaulting to can0', () => {
    const schema = quickChainCounter(fakeApp().app).schema() as typeof CONFIG_SCHEMA

    expect(schema.properties.canInterface.default).to.equal(
      DEFAULT_CAN_INTERFACE
    )
    expect(schema.properties.canInterface.type).to.equal('string')
  })

  it('waits for depth before setting the anchor by default', () => {
    const schema = quickChainCounter(fakeApp().app).schema() as typeof CONFIG_SCHEMA

    expect(schema.properties.requireDepthBeforeDrop.default).to.equal(true)
    expect(schema.properties.requireDepthBeforeDrop.type).to.equal('boolean')
  })

  it('configures the CAN-bus watchdog', () => {
    const schema = quickChainCounter(fakeApp().app).schema() as typeof CONFIG_SCHEMA

    expect(schema.properties.canTimeoutSeconds.default).to.equal(
      DEFAULT_CAN_TIMEOUT_SECONDS
    )
    expect(schema.properties.engineRevolutionsThreshold.default).to.equal(
      DEFAULT_ENGINE_REVOLUTIONS_HZ
    )
  })

  it('offers a chain unit override, defaulting to auto', () => {
    const schema = quickChainCounter(fakeApp().app).schema() as typeof CONFIG_SCHEMA

    expect(schema.properties.chainUnits.default).to.equal('auto')
    expect(schema.properties.chainUnits.enum).to.deep.equal([
      'auto',
      'meters',
      'feet'
    ])
  })
})

describe('plugin lifecycle', () => {
  it('reports a readable error when the binding cannot be loaded', () => {
    const { app, calls } = fakeApp()
    const plugin = quickChainCounter(app)

    plugin.start({ canboatjsPath: '/nonexistent/canboatjs' })

    expect(calls.errors).to.have.length(1)
    expect(calls.errors[0]).to.contain('Could not read')
    // The path metadata is claimed even when the bus cannot be opened; no
    // chain reading is published.
    expect(calls.messages).to.have.length(1)
    expect(calls.messages[0]).to.have.property('updates')
  })

  it('persists the metadata where the staleness enforcer reads it', () => {
    const { app, calls } = fakeApp()
    const defaults: Array<{ path: string; value: unknown }> = []
    app.setDefaultMetadata = async (path, value) => {
      defaults.push({ path, value })
      return true
    }

    quickChainCounter(app).start({ canboatjsPath: '/nonexistent/canboatjs' })

    expect(defaults).to.deep.equal([
      {
        path: 'navigation.anchor.rodeLength',
        value: RODE_LENGTH_META
      }
    ])
    // No transient meta delta is needed when the server can persist it.
    expect(calls.messages).to.be.empty
  })

  it('does not throw when stopped without having started', () => {
    const { app } = fakeApp()
    const plugin = quickChainCounter(app)

    expect(() => plugin.stop()).to.not.throw()
  })

  it('stops cleanly after a failed start', () => {
    const { app, calls } = fakeApp()
    const plugin = quickChainCounter(app)

    plugin.start({ canboatjsPath: '/nonexistent/canboatjs' })
    plugin.stop()

    expect(calls.status).to.contain('Stopped')
  })
})

describe('rode length metadata', () => {
  it('marks the reading as never stale and event-driven', () => {
    const delta = buildRodeLengthMetaDelta('2026-01-01T00:00:00.000Z')

    expect(delta.updates[0].meta[0].path).to.equal(
      'navigation.anchor.rodeLength'
    )
    expect(delta.updates[0].meta[0].value).to.deep.equal(RODE_LENGTH_META)
    expect(RODE_LENGTH_META.timeout).to.equal(0)
    expect(RODE_LENGTH_META.updateContract).to.equal('event')
    expect(RODE_LENGTH_META.units).to.equal('m')
  })
})

describe('anyEngineRunning', () => {
  it('is false without propulsion data', () => {
    expect(anyEngineRunning(undefined, 1)).to.equal(false)
  })

  it('is false when both engines are stopped', () => {
    expect(
      anyEngineRunning(
        {
          port: { revolutions: { value: 0 } },
          starboard: { revolutions: { value: 0.2 } }
        },
        1
      )
    ).to.equal(false)
  })

  it('is true when either engine is above the threshold', () => {
    expect(
      anyEngineRunning(
        {
          port: { revolutions: { value: 0 } },
          starboard: { revolutions: { value: 12 } }
        },
        1
      )
    ).to.equal(true)
  })

  it('accepts a bare revolutions number', () => {
    expect(anyEngineRunning({ port: { revolutions: 12 } }, 1)).to.equal(true)
  })
})

describe('canBusDataOverdue', () => {
  it('does not alarm while engines are off', () => {
    expect(canBusDataOverdue(100_000, 0, undefined, 30_000)).to.equal(false)
  })

  it('does not alarm during the first timeout after engine start', () => {
    expect(canBusDataOverdue(40_000, undefined, 20_000, 30_000)).to.equal(false)
  })

  it('alarms when the last frame is older than the timeout', () => {
    expect(canBusDataOverdue(100_000, 60_000, 10_000, 30_000)).to.equal(true)
  })

  it('gives a fresh engine start a full timeout even with an old frame', () => {
    expect(canBusDataOverdue(40_000, 1_000, 35_000, 30_000)).to.equal(false)
    expect(canBusDataOverdue(70_000, 1_000, 35_000, 30_000)).to.equal(true)
  })
})

describe('CAN bus notification', () => {
  it('publishes an alarm and clears it with null', () => {
    const on = buildCanBusAlarmDelta(
      true,
      'no frames',
      '2026-01-01T00:00:00.000Z'
    )
    expect(on.updates[0].values[0].path).to.equal(CAN_BUS_NOTIFICATION_PATH)
    expect(on.updates[0].values[0].value).to.deep.include({
      state: 'alarm',
      message: 'no frames'
    })

    const off = buildCanBusAlarmDelta(false)
    expect(off.updates[0].values[0].value).to.equal(null)
  })
})

describe('buildRodeLengthDelta', () => {
  it('publishes the metres it is given', () => {
    const chainCount = decodeChainCount(CHAIN_COUNT_FRAME)!
    const delta = buildRodeLengthDelta(chainCount, undefined, 48.87)

    expect(delta.updates[0].values[0].value).to.equal(48.87)
  })
})

describe('frameToDelta', () => {
  it('turns a chain count frame into a deployed chain length in metres', () => {
    const delta = frameToDelta(
      { id: 0x6c1, data: CHAIN_COUNT_FRAME },
      '2026-01-01T00:00:00.000Z'
    )

    expect(delta).to.not.equal(undefined)
    expect(delta!.updates[0].values[0].path).to.equal(
      'navigation.anchor.rodeLength'
    )
    // 107 feet, so 32.6136 m - not 107 m, which is the bug this guards.
    expect(delta!.updates[0].values[0].value).to.be.closeTo(32.6136, 1e-4)
    expect(delta!.updates[0].source!.pgn).to.equal(0x6c1)
    expect(delta!.updates[0].source!.src).to.equal(String(0x18c1))
    expect(delta!.updates[0].timestamp).to.equal('2026-01-01T00:00:00.000Z')
  })

  it('ignores a different identifier', () => {
    expect(
      frameToDelta({ id: 0x6c0, data: CHAIN_COUNT_FRAME })
    ).to.equal(undefined)
  })

  it('ignores a frame too short to decode', () => {
    expect(frameToDelta({ id: 0x6c1, data: Buffer.alloc(4) })).to.equal(
      undefined
    )
  })
})
