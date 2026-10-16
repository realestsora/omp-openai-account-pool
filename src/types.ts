import type {
    OAuthAccountSummary,
    UsageHistoryEntry,
    UsageLimit,
    UsageReport,
} from '@oh-my-pi/pi-ai';
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';

export type OAuthAccount = OAuthAccountSummary;
export type AccountLabels = Record<string, string>;
export type UsageState = {
    fetchedAt?: number;
    refreshFailed: boolean;
};
export type AccountView = {
    account: OAuthAccount;
    label: string;
    report?: UsageReport;
    limits: UsageLimit[];
    exhausted: boolean;
};
export type Snapshot = {
    accounts: AccountView[];
    reports: UsageReport[];
};
export type Model = NonNullable<ExtensionContext['model']>;
export type HealthResult = {
    id: number;
    provider: string;
    ok: boolean | null;
};
export type { UsageHistoryEntry, UsageLimit, UsageReport };
