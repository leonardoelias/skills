import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shippingCache } from './cache'
import { quoteShipping } from './quote'
import * as carrier from './carrier'

describe('quoteShipping', () => {
  beforeEach(() => {
    shippingCache.clear()
    vi.restoreAllMocks()
  })

  it('rejects a postal code with fewer than 8 digits', async () => {
    await expect(quoteShipping('0131', [])).rejects.toThrow('Invalid postal code')
  })

  it('adds up the weight of all items', async () => {
    const spy = vi.spyOn(carrier, 'quoteFromCarrier').mockResolvedValue({ price: 10, days: 3 })
    await quoteShipping('01310-100', [{ weightInGrams: 200, quantity: 2 }, { weightInGrams: 100, quantity: 1 }])
    expect(spy).toHaveBeenCalledWith({ postalCode: '01310100', weightInGrams: 500 })
  })

  it('reuses the quote for the same postal code prefix and weight band', async () => {
    const spy = vi.spyOn(carrier, 'quoteFromCarrier').mockResolvedValue({ price: 10, days: 3 })
    const first = await quoteShipping('01310-100', [{ weightInGrams: 300, quantity: 1 }])
    const second = await quoteShipping('01310-999', [{ weightInGrams: 450, quantity: 1 }])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(first.source).toBe('carrier')
    expect(second.source).toBe('cache')
  })

  it('quotes the carrier again for another weight band', async () => {
    const spy = vi.spyOn(carrier, 'quoteFromCarrier').mockResolvedValue({ price: 10, days: 3 })
    await quoteShipping('01310-100', [{ weightInGrams: 300, quantity: 1 }])
    await quoteShipping('01310-100', [{ weightInGrams: 700, quantity: 1 }])
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
