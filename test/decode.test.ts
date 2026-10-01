import { expect } from 'chai'
import {
  CHAIN_COUNT_PAYLOAD_BYTES,
  chainDeployedMetres,
  decodeChainCount,
  QUICK_CHAIN_COUNT_CAN_ID,
  RODE_DEPLOYED_PATH
} from '../src/decode'

// A real chain count frame: 6C1#C1186B0000000200
//   talker 0x18C1 = 6337, chain 107, units 2 = Feet
const CHAIN_COUNT_FRAME = Buffer.from('C1186B0000000200', 'hex')

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
})

describe('constants', () => {
  it('uses the chain count CAN identifier as the PGN', () => {
    expect(QUICK_CHAIN_COUNT_CAN_ID).to.equal(0x6c1)
  })

  it('publishes the deployed chain under the Signal K anchor path', () => {
    expect(RODE_DEPLOYED_PATH).to.equal('navigation.anchor.rodeDeployed')
  })
})
