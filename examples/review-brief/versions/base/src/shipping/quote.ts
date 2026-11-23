import { quoteFromCarrier } from './carrier'
import type { Item } from '../cart/types'

export type Quote = {
  priceInCents: number
  deliveryDays: number
}

export async function quoteShipping(postalCode: string, items: Item[]): Promise<Quote> {
  const digits = postalCode.replace(/\D/g, '')
  if (digits.length !== 8) {
    throw new Error(`Invalid postal code: "${postalCode}"`)
  }

  const weightInGrams = items.reduce((total, item) => total + item.weightInGrams * item.quantity, 0)
  const response = await quoteFromCarrier({ postalCode: digits, weightInGrams })

  return {
    priceInCents: Math.round(response.price * 100),
    deliveryDays: response.days,
  }
}
