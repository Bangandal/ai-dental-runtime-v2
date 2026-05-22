# Startup Entrypoint Audit

Date: 2026-05-22

## Files inspected

- `package.json`
- `Dockerfile` / `Dockerfile.*`
- `docker-compose.yml` / compose variants
- `tsconfig.json` / tsconfig variants
- `src/index.ts`

## Findings

1. `package.json` defines only one script:
   - `test`: `node --test tests/*.test.ts`
2. No Dockerfile is present in this repository.
3. No docker-compose/compose file is present in this repository.
4. No tsconfig file is present in this repository.
5. The only top-level source entry file is `src/index.ts`, which exports runtime bootstrap wiring:
   - `readRuntimeServerEnv`
   - `bootstrapRuntimeServer`

## Exact command currently run by this repository

From `package.json`, the exact runnable command in this repo is:

```bash
node --test tests/*.test.ts
```

There is no in-repo production container startup command defined via Docker/compose or npm `start` script.

## Runtime route wiring status

`/runtime/turn` registration is wired through:

- `bootstrapRuntimeServer(...)` in `src/index.ts`
- `registerRuntimeRoutes(...)` in `src/runtime/runtimeServerBootstrap.ts`
- `registerRuntimeTurnRoute(...)` in `src/runtime/runtimeTurnHttpRoute.ts`

Endpoint path and payload contract remain unchanged.
