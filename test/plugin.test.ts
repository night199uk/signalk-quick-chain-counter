import { expect } from 'chai'
import quickChainCounter, {
  CONFIG_SCHEMA,
  DEFAULT_CAN_INTERFACE,
  frameToDelta,
  PLUGIN_ID,
  PluginApp
} from '../src/plugin'

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
})

describe('plugin lifecycle', () => {
  it('reports a readable error when the binding cannot be loaded', () => {
    const { app, calls } = fakeApp()
    const plugin = quickChainCounter(app)

    plugin.start({ canboatjsPath: '/nonexistent/canboatjs' })

    expect(calls.errors).to.have.length(1)
    expect(calls.errors[0]).to.contain('Could not read')
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
