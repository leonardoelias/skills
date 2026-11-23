import { quoteFromCarrier } from './carrier'
import { shippingCache, shippingKey } from './cache'
import type { Item } from '../cart/types'

export type Quote = {
  priceInCents: number
  deliveryDays: number
  // "cache" when the price came from a quote made less than 10 minutes ago.
  source: 'cache' | 'carrier'
}

export async function quoteShipping(postalCode: string, items: Item[]): Promise<Quote> {
  const digits = postalCode.replace(/\D/g, '')
  if (digits.length !== 8) {
    throw new Error(`Invalid postal code: "${postalCode}"`)
  }

  const weightInGrams = items.reduce((total, item) => total + item.weightInGrams * item.quantity, 0)
  const key = shippingKey(digits, weightInGrams)
  const cached = shippingCache.read(key)
  if (cached) return { ...cached, source: 'cache' }

  const response = await quoteFromCarrier({ postalCode: digits, weightInGrams })
  const quote = {
    priceInCents: Math.round(response.price * 100),
    deliveryDays: response.days,
  }
  shippingCache.write(key, quote)

  return { ...quote, source: 'carrier' }
}
