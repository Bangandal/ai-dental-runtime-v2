// R2a compatibility facade.
//
// The historical Runtime loop is intentionally frozen behind a legacy boundary so
// new Runtime/BookingKernel code does not keep growing inside the monolith. Existing
// imports remain stable while responsibilities are extracted behind smaller modules.
export * from "./runtimeAgentLoopLegacy.ts";
