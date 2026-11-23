import { describe, expect, it, vi } from 'vitest'
import { quoteShipping } from './quote'
import * as carrier from './carrier'

describe('quoteShipping', () => {
  it('rejects a postal code with fewer than 8 digits', async () => {
    await expect(quoteShipping('0131', [])).rejects.toThrow('Invalid postal code')
  })

  it('adds up the weight of all items', async () => {
    const spy = vi.spyOn(carrier, 'quoteFromCarrier').mockResolvedValue({ price: 10, days: 3 })
    await quoteShipping('01310-100', [{ weightInGrams: 200, quantity: 2 }, { weightInGrams: 100, quantity: 1 }])
    expect(spy).toHaveBeenCalledWith({ postalCode: '01310100', weightInGrams: 500 })
  })

  it('calls the carrier for every quote', async () => {
    const spy = vi.spyOn(carrier, 'quoteFromCarrier').mockResolvedValue({ price: 10, days: 3 })
    await quoteShipping('01310-100', [])
    await quoteShipping('01310-100', [])
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
