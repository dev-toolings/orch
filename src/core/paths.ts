import { homedir } from "node:os";
import { join } from "node:path";

export const stateDir = () => process.env.ORCH_STATE ?? join(homedir(), ".local", "state", "orch");
