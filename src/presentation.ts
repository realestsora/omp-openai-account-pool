import type { UsageHistoryEntry, UsageLimit, UsageReport } from '@oh-my-pi/pi-ai';
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { PRIMARY_LIMIT_ID, PROVIDER, SECONDARY_LIMIT_ID } from './constants';
import type { AccountLabels, HealthResult, OAuthAccount, Snapshot, UsageState } from './types';

export function numberFromEnvironment(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function booleanFromEnvironment(name: string, fallback: boolean): boolean {
    const value = process.env[name]?.trim().toLowerCase();
    if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
    if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
    return fallback;
}

export function percentageFromEnvironment(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value) || value < 0) return fallback;
    return Math.min(100, value);
}

function asString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
}

function normalizeEmail(value: string | undefined): string | undefined {
    return value?.toLowerCase();
}

export function parseAccountLabels(value: string | undefined): AccountLabels {
    const labels: AccountLabels = {};
    for (const entry of value?.split(',') ?? []) {
        const separator = entry.indexOf('=');
        if (separator <= 0) continue;
        const identity = entry.slice(0, separator).trim().toLowerCase();
        const label = asString(entry.slice(separator + 1));
        if (identity && label) labels[identity] = label;
    }
    return labels;
}

function clampFraction(value: number): number {
    return Math.min(1, Math.max(0, value));
}

export function remainingFraction(limit: UsageLimit): number | undefined {
    const amount = limit.amount;
    if (typeof amount.remainingFraction === 'number') {
        return clampFraction(amount.remainingFraction);
    }
    if (
        typeof amount.remaining === 'number' &&
        typeof amount.limit === 'number' &&
        amount.limit > 0
    ) {
        return clampFraction(amount.remaining / amount.limit);
    }
    if (typeof amount.usedFraction === 'number') return clampFraction(1 - amount.usedFraction);
    if (amount.unit === 'percent' && typeof amount.used === 'number') {
        return clampFraction(1 - amount.used / 100);
    }
    return undefined;
}

function reportIdentity(report: UsageReport): { accountId?: string; email?: string } {
    const metadata = report.metadata ?? {};
    const accountId = asString(metadata.accountId);
    const email = normalizeEmail(asString(metadata.email));
    const scopedAccountId = report.limits
        .map((limit) => asString(limit.scope.accountId))
        .find(Boolean);
    return { accountId: accountId ?? scopedAccountId, email };
}

function matchesAccount(report: UsageReport, account: OAuthAccount): boolean {
    const identity = reportIdentity(report);
    if (account.accountId && identity.accountId) return account.accountId === identity.accountId;
    if (account.email && identity.email) {
        return normalizeEmail(account.email) === identity.email;
    }
    return false;
}

function findReport(
    reports: UsageReport[],
    account: OAuthAccount,
    accountCount: number,
): UsageReport | undefined {
    const exact = reports.find((report) => matchesAccount(report, account));
    if (exact) return exact;
    if (accountCount === 1 && reports.length === 1) return reports[0];
    return undefined;
}

function usageLimits(report: UsageReport | undefined): UsageLimit[] {
    if (!report) return [];
    const primary = report.limits.filter(
        (limit) => limit.id === PRIMARY_LIMIT_ID || limit.id === SECONDARY_LIMIT_ID,
    );
    const additional = report.limits.filter(
        (limit) =>
            limit.id !== PRIMARY_LIMIT_ID &&
            limit.id !== SECONDARY_LIMIT_ID &&
            limit.scope.shared === true,
    );
    return [...primary, ...additional];
}

function reportIsExhausted(report: UsageReport | undefined, limits: UsageLimit[]): boolean {
    if (!report) return false;
    const metadata = report.metadata ?? {};
    if (metadata.limitReached === true || metadata.allowed === false) return true;
    return limits.some((limit) => limit.status === 'exhausted');
}

export function accountLabel(account: OAuthAccount, labels: AccountLabels): string {
    const identities = [
        account.email?.toLowerCase(),
        account.accountId?.toLowerCase(),
        `#${account.position + 1}`,
    ];
    for (const identity of identities) {
        if (identity && labels[identity]) return labels[identity];
    }
    return account.email ?? account.accountId ?? `account ${account.position + 1}`;
}

export function buildSnapshot(
    accounts: OAuthAccount[],
    reports: UsageReport[],
    labels: AccountLabels,
): Snapshot {
    return {
        accounts: accounts.map((account) => {
            const report = findReport(reports, account, accounts.length);
            const limits = usageLimits(report);
            return {
                account,
                label: accountLabel(account, labels),
                report,
                limits,
                exhausted: reportIsExhausted(report, limits),
            };
        }),
        reports,
    };
}

function formatDuration(milliseconds: number): string {
    const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60_000));
    if (totalMinutes < 60) return `${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours < 24) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`;
}

export function formatLimit(limit: UsageLimit): string {
    const windowId = limit.scope.modelId ? limit.label : (limit.window?.id ?? limit.label);
    const remaining = remainingFraction(limit);
    const remainingText = remaining === undefined ? '?' : `${Math.round(remaining * 100)}%`;
    const resetAt = limit.window?.resetsAt;
    const resetText =
        typeof resetAt === 'number' && resetAt > Date.now()
            ? ` (reset ${formatDuration(resetAt - Date.now())})`
            : '';
    return `${windowId} ${remainingText}${resetText}`;
}

export function formatDetailed(snapshot: Snapshot): string {
    if (snapshot.accounts.length === 0) {
        return 'No stored OpenAI Codex OAuth accounts. Run /login openai-codex more than once to add accounts.';
    }

    const lines = [`OpenAI Codex accounts: ${snapshot.accounts.length}`];
    for (const view of snapshot.accounts) {
        const marker = view.account.active ? '*' : ' ';
        const limitText =
            view.limits.length > 0 ? view.limits.map(formatLimit).join(' | ') : 'usage unavailable';
        const state = view.exhausted ? ' | exhausted' : '';
        lines.push(`${marker} ${view.account.position + 1}. ${view.label} - ${limitText}${state}`);
    }
    lines.push('Use /openai-account <number|email|account-id|next|auto> to change routing.');
    return lines.join('\n');
}

function formatStatus(snapshot: Snapshot): string {
    if (snapshot.accounts.length === 0) return 'OpenAI: none';
    const active = snapshot.accounts.find((view) => view.account.active);
    if (!active) return `OpenAI: ${snapshot.accounts.length} accounts | active: none`;
    return `OpenAI: ${active.label}`;
}

function formatQuota(snapshot: Snapshot): string {
    const active = snapshot.accounts.find((view) => view.account.active);
    if (!active || active.limits.length === 0) return 'quota unavailable';
    return active.limits.map(formatLimit).join(' / ');
}

function formatElapsed(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function formatFreshness(state: UsageState): string {
    if (state.fetchedAt === undefined) return 'usage pending';
    const age = formatElapsed(Date.now() - state.fetchedAt);
    return state.refreshFailed ? `stale ${age}` : `updated ${age}`;
}

export function formatStatusLine(snapshot: Snapshot, usageState: UsageState): string {
    return `${formatStatus(snapshot)} | ${formatQuota(snapshot)} | ${formatFreshness(usageState)}`;
}

export function notifyLowUsage(
    ctx: ExtensionContext,
    snapshot: Snapshot,
    warningPercent: number,
    warnedKeys: Set<string>,
): void {
    if (!ctx.hasUI || warningPercent <= 0) return;
    const active = snapshot.accounts.find((view) => view.account.active);
    if (!active || active.exhausted) return;
    for (const limit of active.limits) {
        const remaining = remainingFraction(limit);
        if (remaining === undefined || remaining <= 0 || remaining * 100 > warningPercent) {
            continue;
        }
        const key = `${active.account.credentialId}:${limit.id}`;
        if (warnedKeys.has(key)) continue;
        warnedKeys.add(key);
        ctx.ui.notify(
            `OpenAI account ${active.label} has ${Math.round(remaining * 100)}% remaining on ${limit.label}.`,
            'warning',
        );
    }
}

export function formatHealth(
    accounts: OAuthAccount[],
    results: HealthResult[],
    labels: AccountLabels,
): string {
    const byId = new Map(
        results
            .filter((result) => result.provider === PROVIDER)
            .map((result) => [result.id, result]),
    );
    if (accounts.length === 0) return 'No stored OpenAI Codex OAuth accounts.';
    const lines = ['OpenAI account health:'];
    for (const account of accounts) {
        const result = byId.get(account.credentialId);
        const state = result?.ok === true ? 'ok' : result?.ok === false ? 'failed' : 'unknown';
        lines.push(`- ${accountLabel(account, labels)}: ${state}`);
    }
    return lines.join('\n');
}

export function formatHistory(entries: UsageHistoryEntry[], hours: number): string {
    if (entries.length === 0) {
        return `No OpenAI usage history in the last ${hours} hours.`;
    }
    const lines = [`OpenAI usage history: last ${hours} hours`];
    const ordered = [...entries].sort((left, right) => right.recordedAt - left.recordedAt);
    for (const entry of ordered.slice(0, 12)) {
        const identity = entry.email ?? entry.accountId ?? entry.accountKey;
        const used =
            entry.usedFraction === undefined
                ? '?'
                : `${Math.round(entry.usedFraction * 100)}% used`;
        const status = entry.status ? ` (${entry.status})` : '';
        const time = new Date(entry.recordedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        });
        lines.push(`${time} ${identity} - ${entry.windowLabel ?? entry.label}: ${used}${status}`);
    }
    return lines.join('\n');
}
