## tl;dr
Before: every shipping quote in checkout called the carrier (~800 ms).
Now: the same combination of postal code prefix and weight band reuses the quote for 10 minutes.

## Motivation
The carrier allows 20 quotes per second, and checkout went over that on Black Friday (#471).

## Decisions
- **Key by the 5-digit postal code prefix** (implicit)
  - Why: 30 days of quotes show 97% equal prices within the same prefix.
  - Accepts: in the other 3%, the customer sees a neighbor's shipping price for up to 10 minutes; the carrier charges the real price on the label.
- **Cache in process memory, not in Redis** ([discussion](https://acme.slack.com/archives/C04SHIP/p1732200000123456))
  - Why: each instance already gets traffic from the whole country; the gain from sharing the cache is small.
  - Accepts: each new instance starts empty.
  - Alternatives: shared Redis (one more dependency in the checkout path).

## Out of scope
Invalidate the cache when the carrier changes its price table (next PR).

## How to test
1. Open checkout with the postal code 01310-100.
2. Switch to 01310-999 and see "Shipping (estimate)".
