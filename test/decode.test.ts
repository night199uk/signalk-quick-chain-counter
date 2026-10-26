import { expect } from 'chai'
import {
  CHAIN_CONFIG_PAYLOAD_BYTES,
  CHAIN_COUNT_PAYLOAD_BYTES,
  chainDeployedMetres,
  chainDeployedMetresFromLap,
  decodeChainConfig,
  decodeChainCount,
  QUICK_CHAIN_CONFIG_CAN_ID,
  QUICK_CHAIN_COUNT_CAN_ID,
  resolveChainUnits,
  RODE_LENGTH_PATH
} from '../src/decode'

// A real chain count frame: 6C1#C1186B0000000200
//   talker 0x18C1 = 6337, lap count 107. That setup's 0x6C0 lap was 120
//   (12.0 in), so 107 laps was 107 ft - which is why the old code mistook the
//   count for feet.
const CHAIN_COUNT_FRAME = Buffer.from('C1186B0000000200', 'hex')

// A real configuration frame: 6C0#D245820001000100
//   talker 0x45D2 = 17874, gypsy lap 130 = 13.0 in
const CHAIN_CONFIG_FRAME = Buffer.from('D245820001000100', 'hex')

function frameWith(
  sourceAddress: number,
  chainDeployed: number,
  units: number
): Buffer {
  const data = Buffer.alloc(8)
  data.writeUInt16LE(sourceAddress, 0)
  data.writeUInt32LE(chainDeployed, 2)
  data.writeUInt16LE(units, 6)
  return data
}

describe('decodeChainCount', () => {
  it('decodes the talker, chain length and units', () => {
    const decoded = decodeChainCount(CHAIN_COUNT_FRAME)

    expect(decoded).to.not.equal(undefined)
    expect(decoded!.sourceAddress).to.equal(0x18c1)
    expect(decoded!.chainDeployed).to.equal(107)
    expect(decoded!.units).to.equal('Feet')
  })

  it('labels units 1 as Meters and 2 as Feet, as canboat spells them', () => {
    expect(decodeChainCount(frameWith(0, 0, 1))!.units).to.equal('Meters')
    expect(decodeChainCount(frameWith(0, 0, 2))!.units).to.equal('Feet')
  })

  it('keeps an unknown unit value as a number rather than guessing a label', () => {
    const decoded = decodeChainCount(frameWith(0, 0, 99))

    expect(decoded!.units).to.equal(99)
  })

  it('reads the chain length as an unsigned 32-bit value', () => {
    const decoded = decodeChainCount(frameWith(0, 0xffffffff, 1))

    expect(decoded!.chainDeployed).to.equal(0xffffffff)
  })

  it('ignores fields beyond the ones it knows', () => {
    const long = Buffer.concat([CHAIN_COUNT_FRAME, Buffer.from([0xff, 0xff])])

    expect(decodeChainCount(long)!.chainDeployed).to.equal(107)
  })

  it('refuses a truncated frame instead of decoding a partial one', () => {
    for (let length = 0; length < CHAIN_COUNT_PAYLOAD_BYTES; length++) {
      expect(
        decodeChainCount(CHAIN_COUNT_FRAME.subarray(0, length)),
        `${length} bytes`
      ).to.equal(undefined)
    }
  })
})

describe('decodeChainConfig', () => {
  it('decodes the gypsy lap in tenths of an inch', () => {
    const decoded = decodeChainConfig(CHAIN_CONFIG_FRAME)

    expect(decoded).to.not.equal(undefined)
    expect(decoded!.sourceAddress).to.equal(0x45d2)
    expect(decoded!.lapTenthsInch).to.equal(130)
    expect(decoded!.flags).to.deep.equal([1, 1])
  })

  it('refuses a truncated frame', () => {
    expect(
      decodeChainConfig(CHAIN_CONFIG_FRAME.subarray(0, CHAIN_CONFIG_PAYLOAD_BYTES - 1))
    ).to.equal(undefined)
  })
})

describe('chainDeployedMetresFromLap', () => {
  it('multiplies the lap count by the 0x6C0 lap length', () => {
    // 0x6C1#D245940000000000 is 148 laps; 0x6C0 says 130 (13.0 in).
    const count = decodeChainCount(
      Buffer.from('D245940000000000', 'hex')
    )!

    expect(chainDeployedMetresFromLap(count, 130)).to.be.closeTo(48.8696, 1e-4)
  })

  it('reproduces the original 12-inch lap case', () => {
    const count = decodeChainCount(CHAIN_COUNT_FRAME)!

    expect(chainDeployedMetresFromLap(count, 120)).to.be.closeTo(32.6136, 1e-4)
  })
})

describe('chainDeployedMetres', () => {
  it('converts feet to metres', () => {
    const decoded = decodeChainCount(frameWith(0x18c1, 107, 2))!

    expect(chainDeployedMetres(decoded)).to.be.closeTo(107 * 0.3048, 1e-9)
    expect(chainDeployedMetres(decoded)).to.be.closeTo(32.6136, 1e-4)
  })

  it('passes metres through unchanged', () => {
    const decoded = decodeChainCount(frameWith(0x18c1, 107, 1))!

    expect(chainDeployedMetres(decoded)).to.equal(107)
  })

  it('does not convert an unrecognised unit', () => {
    // Guessing here would be worse than relaying what the device said.
    const decoded = decodeChainCount(frameWith(0x18c1, 107, 99))!

    expect(chainDeployedMetres(decoded)).to.equal(107)
  })

  it('converts zero', () => {
    const decoded = decodeChainCount(frameWith(0, 0, 2))!

    expect(chainDeployedMetres(decoded)).to.equal(0)
  })

  it('honours an explicit feet override', () => {
    const decoded = decodeChainCount(frameWith(0x18c1, 148, 1))!

    expect(chainDeployedMetres(decoded, 'Feet')).to.be.closeTo(45.1104, 1e-4)
  })
})

describe('resolveChainUnits', () => {
  it('uses an explicit override instead of the frame label', () => {
    const decoded = decodeChainCount(frameWith(0, 148, 1))!

    expect(resolveChainUnits(decoded, 'feet')).to.equal('Feet')
    expect(resolveChainUnits(decoded, 'meters')).to.equal('Meters')
  })

  it('treats a value larger than the total chain as feet in auto', () => {
    // 148 cannot be metres when the boat carries 91.44 m.
    const decoded = decodeChainCount(frameWith(0, 148, 1))!

    expect(resolveChainUnits(decoded, 'auto', 91.44)).to.equal('Feet')
  })

  it('leaves a plausible value to the frame label', () => {
    const decoded = decodeChainCount(frameWith(0, 40, 1))!

    expect(resolveChainUnits(decoded, 'auto', 91.44)).to.equal(undefined)
  })

  it('does not override a frame that already says feet', () => {
    const decoded = decodeChainCount(frameWith(0, 148, 2))!

    expect(resolveChainUnits(decoded, 'auto', 91.44)).to.equal(undefined)
  })
})

describe('constants', () => {
  it('uses the chain count CAN identifier as the PGN', () => {
    expect(QUICK_CHAIN_COUNT_CAN_ID).to.equal(0x6c1)
  })

  it('uses the configuration CAN identifier for the gypsy lap', () => {
    expect(QUICK_CHAIN_CONFIG_CAN_ID).to.equal(0x6c0)
  })

  it('publishes the deployed chain under the anchor rode path', () => {
    // navigation.anchor.rodeLength is what the anchor alarm plugins use; the
    // specification's schema does not list it yet.
    expect(RODE_LENGTH_PATH).to.equal('navigation.anchor.rodeLength')
  })
})
