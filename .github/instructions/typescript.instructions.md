---
description: "TypeScript coding conventions for strict mode, ES2022 target, NodeNext modules."
applyTo: "**/*.ts"
---

# TypeScript Conventions

- Use `import type` for type-only imports
- Prefer `async/await` over raw promises or callbacks
- Use named exports, one concern per file
- All parameters and return types must be explicitly typed (strict mode)
- Use template literal types and discriminated unions where appropriate
- Prefer `unknown` over `any` at trust boundaries; narrow with type guards
- Error messages must be actionable: include what failed and what the user should do
