/**
 * Operational Read Model — provider-neutral facts and read-only projection contracts
 * (NEST-113 / GitHub #109, first implementation slice of #108).
 *
 * This aggregator is the single public entry for operational contracts. Source readers
 * and projectors land later behind the same boundary; nothing here reads a live source,
 * derives a phase, detects anomalies or serves queries.
 */
export * from "./operations-facts";
export * from "./operations-projection";
