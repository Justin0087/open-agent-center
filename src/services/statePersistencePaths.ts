import path from "node:path";

export const DATA_DIR = path.resolve(process.cwd(), ".data");
export const JSON_STATE_FILE = path.join(DATA_DIR, "state.json");
export const SQLITE_STATE_FILE = path.join(DATA_DIR, "state.sqlite");