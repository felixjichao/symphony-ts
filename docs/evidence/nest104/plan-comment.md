## Symphony Implementation Plan (rev 1)

**Verdict:** `ready` ｜ **Revision:** `1` ｜ **Trigger:** `initial`

**Requirement Fingerprint:** `200f14c1fff88254e71136ed852142012b3526ef043205fb3145e4c6f33510f4`

### Plan Summary

1. Modify src/math.mjs only to add a new named export `nest104Double(value)` whose implementation returns `value * 2`, leaving all existing exports and implementations unchanged. 2. Update test/math.test.mjs to import `nest104Double` and add node:test coverage asserting the three specified behaviors: positive input 3 returns 6, negative input -2 returns -4, and zero returns 0. Keep the existing tests intact. 3. Do not add packages, alter package.json, change CI/workflow configuration, or fix unrelated existing code. 4. Validate the completed change with `npm test` followed by `npm run lint`; both must pass before delivery. Review the final diff to ensure it is limited to the requested implementation and test changes.

### Acceptance Criteria

- src/math.mjs exports `nest104Double` without removing or modifying existing exports.
- `nest104Double(3) === 6`.
- `nest104Double(-2) === -4`.
- `nest104Double(0) === 0`.
- node:test coverage explicitly exercises positive, negative, and zero inputs.
- `npm test` passes.
- `npm run lint` passes.
- No dependencies, package configuration, workflow configuration, or unrelated source behavior are changed.

### Risks & Considerations

- Editing the existing export set while adding the new function could accidentally remove or alter an existing synthetic dogfood export; keep the change additive.
- The repository contains existing synthetic functions whose naming or behavior may appear suspicious, but correcting them would violate the explicit no-unrelated-changes constraint.
- The local `gate` script runs only tests, whereas CI also runs lint; explicitly executing both requested commands avoids a change that passes tests but fails CI.

<details>
<summary>Structured Decision Payload</summary>

```json
{
  "schemaVersion": 1,
  "taskId": "github%3Afelixjichao%2Fsymphony-delivery-dogfood%2320:plan:1",
  "sessionId": "github:felixjichao/symphony-delivery-dogfood#20",
  "revision": 1,
  "createdAtMs": 1791715910181,
  "kind": "plan",
  "verdict": "ready",
  "content": {
    "plan": "1. Modify src/math.mjs only to add a new named export `nest104Double(value)` whose implementation returns `value * 2`, leaving all existing exports and implementations unchanged. 2. Update test/math.test.mjs to import `nest104Double` and add node:test coverage asserting the three specified behaviors: positive input 3 returns 6, negative input -2 returns -4, and zero returns 0. Keep the existing tests intact. 3. Do not add packages, alter package.json, change CI/workflow configuration, or fix unrelated existing code. 4. Validate the completed change with `npm test` followed by `npm run lint`; both must pass before delivery. Review the final diff to ensure it is limited to the requested implementation and test changes.",
    "acceptanceCriteria": [
      "src/math.mjs exports `nest104Double` without removing or modifying existing exports.",
      "`nest104Double(3) === 6`.",
      "`nest104Double(-2) === -4`.",
      "`nest104Double(0) === 0`.",
      "node:test coverage explicitly exercises positive, negative, and zero inputs.",
      "`npm test` passes.",
      "`npm run lint` passes.",
      "No dependencies, package configuration, workflow configuration, or unrelated source behavior are changed."
    ],
    "risks": [
      "Editing the existing export set while adding the new function could accidentally remove or alter an existing synthetic dogfood export; keep the change additive.",
      "The repository contains existing synthetic functions whose naming or behavior may appear suspicious, but correcting them would violate the explicit no-unrelated-changes constraint.",
      "The local `gate` script runs only tests, whereas CI also runs lint; explicitly executing both requested commands avoids a change that passes tests but fails CI."
    ],
    "clarifications": []
  }
}
```
</details>

<!-- symphony-plan-marker: {"schemaVersion":1,"repo":"felixjichao/symphony-delivery-dogfood","issueNumber":20,"sessionId":"github:felixjichao/symphony-delivery-dogfood#20","taskId":"github%3Afelixjichao%2Fsymphony-delivery-dogfood%2320:plan:1","revision":1,"triggerKind":"initial","fingerprint":"200f14c1fff88254e71136ed852142012b3526ef043205fb3145e4c6f33510f4","verdict":"ready"} -->
