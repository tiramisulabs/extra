# seyfert/required-options-order

Discord rejects a slash command whose **required** option is declared *after* an optional one. seyfert v5 does not enforce option order at the type level, so this rule flags it inside `@Options({ ... })`.

Conservative: only seyfert `createXOption` builders are treated as options, and only a literal `required: true | false` is acted on. Anything dynamic — a `required` supplied by a variable, a spread, or shorthand — is treated as unknown and never assumed optional (no false positive).

## ✅ Valid

```ts
@Options({
  user: createStringOption({ description: 'User', required: true }),
  reason: createStringOption({ description: 'Reason' }), // optional after required — fine
})
```

## ❌ Invalid

```ts
@Options({
  reason: createStringOption({ description: 'Reason' }),         // optional
  user: createStringOption({ description: 'User', required: true }), // required after optional
})
```
