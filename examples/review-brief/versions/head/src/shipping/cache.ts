const TEN_MINUTES = 10 * 60 * 1000
const MAX_ENTRIES = 5000

type Entry<T> = { value: T; expiresAt: number }

/** Keeps quotes for a short time. When full, it deletes the least recently used entry. */
export class ExpiringCache<T> {
  private entries = new Map<string, Entry<T>>()

  constructor(
    private ttlMs = TEN_MINUTES,
    private max = MAX_ENTRIES,
    private now = () => Date.now(),
  ) {}

  read(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }

    // Reinsert so the Map keeps the order of use: the first key is the least recently used.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  write(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}

/** 500 g bands: the carrier charges the same price within each band. */
export function shippingKey(postalCode: string, weightInGrams: number): string {
  const band = Math.ceil(weightInGrams / 500)
  return `${postalCode.slice(0, 5)}:${band}`
}

export const shippingCache = new ExpiringCache<{ priceInCents: number; deliveryDays: number }>()
