import { homedir } from "node:os";
import { join } from "node:path";

export const stateDir = () => process.env.ORCH_STATE ?? join(homedir(), ".local", "state", "orch");
export const bunCacheDir = (state = stateDir()) => join(state, "cache", "bun");

// The lead's USER.md and MEMORY.md: reflect writes them, the session-start
// hook injects them.
export const leadMemoryDir = (state = stateDir()) => join(state, "kiba-memory");
