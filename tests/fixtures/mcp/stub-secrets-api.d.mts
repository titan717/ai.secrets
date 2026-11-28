export declare const IDS: Record<"dm" | "channel" | "dock" | "alice" | "bob" | "forbidden", string>;
export declare function startStubApi(o: { token: string }): Promise<{ url: string; requests: { method: string; path: string; query: Record<string, string>; auth?: string }[]; close(): Promise<void> }>;
