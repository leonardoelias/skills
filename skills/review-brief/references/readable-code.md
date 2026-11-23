# Blank lines in the shown code

The reader reads a blank line as "another step starts here". In the code on the page, write each function body as paragraphs: one paragraph per step of the logic, a blank line between steps, none inside a step. Without a reason, the lines stay together.

Code written by AI tends to err both ways: too dense in long functions (nothing after a guard, multi-line statements stuck to their neighbors) and too airy in short blocks (a blank line in a two-line block, between a value and its check).

On the page, blank lines do not count in the budget and you can change them as you like, as long as both sides of the diff stay the same. In the repository, touch only the lines that the task touches.

## Rules

When two rules conflict, the one above wins.

1. **Never** a blank line inside an object, a type literal, an interface, an enum, JSX children or an argument list; between `case` clauses; between a comment and its code; or before `break` or `continue`.
2. **The check stays with what it checks.** `const x = …` followed by a one-line guard about `x` (`if (!x) return`, `assert(x…)`, `expect(x…)`) is a single step, also when the declaration has several lines. A row of one-line guards stays together. The check closes the step: after it, another paragraph.
3. **A small block is one paragraph.** No blank line in a block of 2 or 3 one-line statements, in a nested block of 2 statements, or in a function body of 2 statements (unless one of them has 6 lines or more).
4. **After a guard, a new step.** A blank line after `if (…) return/throw/continue/break`, unless the next line is another one-line guard or completes the guard (`if (seen.has(id)) return` followed by `seen.add(id)`).
5. **Multi-line blocks stay apart.** A blank line before and after an `if` with braces, a loop, a `switch`, a `try` and a statement with a body (`items.map((item) => {…})`). Exceptions:
   - A one-line declaration used only by the next statement stays stuck to it when that statement has up to about 5 lines. Before a statement of 10 lines or more, separate them.
   - An `if` with braces that checks the value declared right above stays stuck to it when the value is not used after it.
6. **One-line statements:** a chain (each line uses the one above, or all use the same input) stays together. After an action (a call, an assignment), separate before a new declaration.
7. **The final `return`** is a paragraph of its own when the body already has paragraphs, unless it only passes on or wraps the result of the line above. In a short block, it stays with the line above.
8. **Comments:** a blank line before a comment that opens a step, never after it.

Outside functions: a blank line around each function, class, interface and multi-line declaration; one-line constants of the same kind stay together.

## Examples

Each "value and check" pair is one step; the `return` that only wraps the line above stays with it:

```ts
const order = orders.find(orderId)
if (!isPaid(order)) return undefined

const invoiceId = invoiceOfPayment(order.payment)
if (!invoiceId) return undefined

const invoice = invoices.find(invoiceId)
return isInvoice(invoice) ? invoice : undefined
```

Dense (as AI tends to write it):

```ts
const parts: string[] = []
for (const sort of sorts) {
  const column = columns.get(sort.field)
  if (!column?.sortable) continue
  const direction = sort.direction === 'desc' ? 'DESC' : 'ASC'
  parts.push(`${quote(column.name)} ${direction}`)
}
if (parts.length === 0) {
  return `ORDER BY ${quote(defaultColumn)}`
}
return `ORDER BY ${parts.join(', ')}`
```

In paragraphs: the accumulator is separate from the long loop, the guard closes a step inside the loop, the `if` with braces and the final `return` are paragraphs of their own.

```ts
const parts: string[] = []

for (const sort of sorts) {
  const column = columns.get(sort.field)
  if (!column?.sortable) continue

  const direction = sort.direction === 'desc' ? 'DESC' : 'ASC'
  parts.push(`${quote(column.name)} ${direction}`)
}

if (parts.length === 0) {
  return `ORDER BY ${quote(defaultColumn)}`
}

return `ORDER BY ${parts.join(', ')}`
```

A short loop stays with its accumulator:

```ts
const emails: string[] = []
for (const user of users) {
  const email = normalize(user.email)
  if (email) emails.push(email)
}

return { recipients: emails.join(', ') }
```

A `// ...` counts as the code that it leaves out. When the left-out code is a guard, separate after it:

```ts
export async function quoteShipping(postalCode: string, items: Item[]): Promise<Quote> {
  // ...

  const key = shippingKey(postalCode, weight)
  const cached = cache.read(key)
  if (cached) return { ...cached, source: 'cache' }

  // ...
}
```
