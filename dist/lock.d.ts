export declare const repoLockPath: (repoRoot: string) => string;
export declare function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=lock.d.ts.map