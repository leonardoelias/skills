import { quoteShipping } from '../shipping/quote'
import { formatBRL } from '../format'
import type { Item } from '../cart/types'

export async function shippingLine(postalCode: string, items: Item[]) {
  const quote = await quoteShipping(postalCode, items)
  return {
    label: 'Shipping',
    price: formatBRL(quote.priceInCents),
    detail: `${quote.deliveryDays} business days`,
  }
}
