import type { LockwireConfig } from "./types.js";
export declare function configPath(repoRoot: string): string;
export declare function readConfig(repoRoot: string): Promise<LockwireConfig>;
export declare function writeConfig(repoRoot: string, config: LockwireConfig): Promise<void>;
//# sourceMappingURL=config.d.ts.map