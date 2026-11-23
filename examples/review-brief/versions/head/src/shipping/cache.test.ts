import { describe, expect, it } from 'vitest'
import { ExpiringCache, shippingKey } from './cache'

describe('ExpiringCache', () => {
  it('forgets the entry after it expires', () => {
    let now = 0
    const cache = new ExpiringCache<number>(1000, 10, () => now)
    cache.write('a', 1)
    now = 1000
    expect(cache.read('a')).toBeUndefined()
  })

  it('deletes the least recently used entry when full', () => {
    const cache = new ExpiringCache<number>(1000, 2, () => 0)
    cache.write('a', 1)
    cache.write('b', 2)
    cache.read('a')
    cache.write('c', 3)
    expect(cache.read('a')).toBe(1)
    expect(cache.read('b')).toBeUndefined()
  })
})

describe('shippingKey', () => {
  it.each([
    ['01310100', 500, '01310:1'],
    ['01310999', 501, '01310:2'],
  ])('postal code %s with %i g becomes %s', (postalCode, weight, key) => {
    expect(shippingKey(postalCode, weight)).toBe(key)
  })
})
