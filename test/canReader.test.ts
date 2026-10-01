import { expect } from 'chai'
import * as path from 'path'
import {
  CanReader,
  candidateLookupPaths,
  isChainCountFrame
} from '../src/canReader'

describe('isChainCountFrame', () => {
  it('accepts the chain count identifier', () => {
    expect(isChainCountFrame(0x6c1)).to.equal(true)
  })

  it('refuses neighbouring Quick identifiers', () => {
    expect(isChainCountFrame(0x6c0)).to.equal(false)
    expect(isChainCountFrame(0x6c2)).to.equal(false)
  })

  it('refuses an unrelated identifier', () => {
    expect(isChainCountFrame(0x18eeff01)).to.equal(false)
  })
})

describe('candidateLookupPaths', () => {
  it('includes node_modules directories, not bare paths', () => {
    const paths = candidateLookupPaths()

    expect(paths).to.not.be.empty
    for (const p of paths) {
      expect(path.basename(p), p).to.equal('node_modules')
    }
  })

  it('puts caller-supplied paths first and drops duplicates', () => {
    const extra = '/custom/node_modules'
    const paths = candidateLookupPaths([extra, extra])

    expect(paths[0]).to.equal(extra)
    expect(paths.filter((p) => p === extra)).to.have.length(1)
  })
})

describe('CanReader.start', () => {
  const noop = () => undefined

  function readerWith(addonDir: string) {
    return new CanReader({
      canInterface: 'can0',
      addonDir,
      onFrame: noop,
      onError: noop,
      debug: noop
    })
  }

  it('explains that there is no SocketCAN binding when canboatjs is absent', () => {
    // A directory that exists but holds no canboatjs install.
    expect(() => readerWith(path.join(__dirname, 'fixtures')).start()).to.throw(
      /Cannot find module|cannot find module/
    )
  })

  it('is safe to stop without having started', () => {
    expect(() => readerWith('/nonexistent').stop()).to.not.throw()
  })
})
