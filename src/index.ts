import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import {
    DEFAULT_HISTORY_HOURS,
    DEFAULT_MIN_REMAINING_PERCENT,
    DEFAULT_REFRESH_INTERVAL_MS,
    DEFAULT_WARNING_PERCENT,
    PROVIDER,
    STATUS_KEY,
} from './constants';
import {
    booleanFromEnvironment,
    buildSnapshot,
    formatDetailed,
    formatHealth,
    formatHistory,
    formatStatusLine,
    formatLimit,
    notifyLowUsage,
    numberFromEnvironment,
    parseAccountLabels,
    percentageFromEnvironment,
} from './presentation';
import { nextAvailableAccount, resolveActiveAccount, rotateAccountIfNeeded } from './routing';
import type { AccountView, Snapshot, UsageState } from './types';

function setUsageWidget(
    ctx: ExtensionContext,
    snapshot: Snapshot,
    usageState: UsageState,
    enabled: boolean,
): void {
    if (!ctx.hasUI) return;
    if (!enabled) {
        ctx.ui.setWidget(STATUS_KEY, undefined);
        return;
    }
    ctx.ui.setWidget(STATUS_KEY, [formatStatusLine(snapshot, usageState)], {
        placement: 'aboveEditor',
    });
}

export default function openaiAccountPool(pi: ExtensionAPI): void {
    const refreshIntervalMs =
        numberFromEnvironment(
            'OMP_OPENAI_ACCOUNT_REFRESH_SECONDS',
            DEFAULT_REFRESH_INTERVAL_MS / 1000,
        ) * 1000;
    const autoSwitch = booleanFromEnvironment('OMP_OPENAI_ACCOUNT_AUTO_SWITCH', true);
    const warningPercent = percentageFromEnvironment(
        'OMP_OPENAI_ACCOUNT_WARNING_PERCENT',
        DEFAULT_WARNING_PERCENT,
    );
    const minimumRemainingPercent = percentageFromEnvironment(
        'OMP_OPENAI_ACCOUNT_MIN_REMAINING_PERCENT',
        DEFAULT_MIN_REMAINING_PERCENT,
    );
    const labels = parseAccountLabels(process.env.OMP_OPENAI_ACCOUNT_LABELS);
    let statusEnabled = booleanFromEnvironment('OMP_OPENAI_ACCOUNT_STATUS', true);
    let lastRefreshAt = 0;
    let snapshot: Snapshot = { accounts: [], reports: [] };
    let refreshPromise: Promise<Snapshot> | undefined;
    const usageState: UsageState = { refreshFailed: false };
    const warnedLowUsageKeys = new Set<string>();

    const publish = (ctx: ExtensionContext, next: Snapshot, notifyWarnings: boolean): void => {
        setUsageWidget(ctx, next, usageState, statusEnabled);
        if (notifyWarnings) notifyLowUsage(ctx, next, warningPercent, warnedLowUsageKeys);
    };

    const refreshUsage = async (ctx: ExtensionContext, force = false): Promise<Snapshot> => {
        const now = Date.now();
        if (!force && now - lastRefreshAt < refreshIntervalMs && snapshot.accounts.length > 0) {
            const accounts = ctx.modelRegistry.authStorage.oauth.accounts(
                PROVIDER,
                ctx.sessionManager.getSessionId(),
            );
            snapshot = buildSnapshot(accounts, snapshot.reports, labels);
            publish(ctx, snapshot, false);
            return snapshot;
        }
        if (refreshPromise) return refreshPromise;

        refreshPromise = (async () => {
            const auth = ctx.modelRegistry.authStorage;
            const accounts = auth.oauth.accounts(PROVIDER, ctx.sessionManager.getSessionId());
            let reports = snapshot.reports;
            try {
                if (force) await auth.usage.invalidate(PROVIDER);
                const fetched = await auth.usage.reports();
                if (fetched === null) {
                    usageState.refreshFailed = true;
                } else {
                    reports = fetched.filter((report) => report.provider === PROVIDER);
                    usageState.fetchedAt = Date.now();
                    usageState.refreshFailed = false;
                }
            } catch (error) {
                usageState.refreshFailed = true;
                pi.logger.debug('OpenAI account usage refresh failed', { error: String(error) });
            }
            snapshot = buildSnapshot(accounts, reports, labels);
            lastRefreshAt = Date.now();
            publish(ctx, snapshot, true);
            return snapshot;
        })().finally(() => {
            refreshPromise = undefined;
        });

        return refreshPromise;
    };

    const showHealth = async (ctx: ExtensionContext): Promise<void> => {
        try {
            const auth = ctx.modelRegistry.authStorage;
            const results = await auth.health.check();
            const accounts = auth.oauth.accounts(PROVIDER, ctx.sessionManager.getSessionId());
            ctx.ui.notify(formatHealth(accounts, results, labels), 'info');
        } catch (error) {
            pi.logger.debug('OpenAI account health check failed', { error: String(error) });
            ctx.ui.notify('OpenAI account health check failed.', 'error');
        }
    };

    const showHistory = async (args: string, ctx: ExtensionContext): Promise<void> => {
        const parsedHours = Number(args.trim());
        const hours =
            Number.isFinite(parsedHours) && parsedHours > 0
                ? Math.min(720, Math.floor(parsedHours))
                : DEFAULT_HISTORY_HOURS;
        const entries = ctx.modelRegistry.authStorage.usage.history({
            provider: PROVIDER,
            sinceMs: Date.now() - hours * 60 * 60 * 1000,
        });
        ctx.ui.notify(formatHistory(entries, hours), 'info');
    };

    const toggleStatus = async (args: string, ctx: ExtensionContext): Promise<void> => {
        const requested = args.trim().toLowerCase();
        if (requested === 'on') statusEnabled = true;
        else if (requested === 'off') statusEnabled = false;
        else statusEnabled = !statusEnabled;
        setUsageWidget(ctx, snapshot, usageState, statusEnabled);
        ctx.ui.notify(`OpenAI status widget ${statusEnabled ? 'enabled' : 'disabled'}.`, 'info');
    };

    const showAccounts = async (args: string, ctx: ExtensionContext): Promise<void> => {
        const command = args.trim();
        if (command.toLowerCase() === 'check') {
            await showHealth(ctx);
            return;
        }
        if (command.toLowerCase() === 'status') {
            await toggleStatus('', ctx);
            return;
        }
        if (command.toLowerCase().startsWith('history')) {
            await showHistory(command.slice('history'.length), ctx);
            return;
        }
        const next = await refreshUsage(ctx, true);
        ctx.ui.notify(formatDetailed(next), 'info');
    };

    const selectAccount = async (args: string, ctx: ExtensionContext): Promise<void> => {
        const rawSelector = args.trim();
        const command = rawSelector.toLowerCase();
        if (command === 'status' || command.startsWith('status ')) {
            await toggleStatus(rawSelector.slice('status'.length), ctx);
            return;
        }
        if (command === 'check') {
            await showHealth(ctx);
            return;
        }
        if (command.startsWith('history')) {
            await showHistory(rawSelector.slice('history'.length), ctx);
            return;
        }

        const next = await refreshUsage(ctx, false);
        if (!rawSelector && !ctx.hasUI) {
            ctx.ui.notify(formatDetailed(next), 'info');
            return;
        }

        const auth = ctx.modelRegistry.authStorage;
        const sessionId = ctx.sessionManager.getSessionId();
        if (command === 'auto') {
            auth.sessions.release(PROVIDER, sessionId);
            await resolveActiveAccount(ctx, pi.logger);
            const accounts = auth.oauth.accounts(PROVIDER, sessionId);
            snapshot = buildSnapshot(accounts, next.reports, labels);
            publish(ctx, snapshot, false);
            ctx.ui.notify('OpenAI account routing is automatic.', 'info');
            return;
        }

        let selected: AccountView | undefined;
        if (!rawSelector) {
            const options = next.accounts.map((view) => ({
                label: `${view.account.position + 1}. ${view.label}`,
                description:
                    view.limits.length > 0
                        ? view.limits.map(formatLimit).join(' | ')
                        : 'usage unavailable',
            }));
            const choice = await ctx.ui.select('Select OpenAI account', options);
            selected = next.accounts.find(
                (view) => `${view.account.position + 1}. ${view.label}` === choice,
            );
            if (!choice || !selected) return;
        } else if (command === 'next') {
            const activePosition =
                next.accounts.find((view) => view.account.active)?.account.position ?? -1;
            selected = nextAvailableAccount(next.accounts, activePosition);
        } else if (/^\d+$/.test(rawSelector)) {
            selected = next.accounts.find(
                (view) => view.account.position === Number(rawSelector) - 1,
            );
        } else {
            selected = next.accounts.find((view) => {
                const normalized = rawSelector.toLowerCase();
                return (
                    view.account.email?.toLowerCase() === normalized ||
                    view.account.accountId?.toLowerCase() === normalized ||
                    view.label.toLowerCase() === normalized
                );
            });
        }

        if (!selected) {
            ctx.ui.notify(
                `Account not found or no available account matches "${rawSelector}".`,
                'error',
            );
            return;
        }

        const pinned = auth.sessions.pin(PROVIDER, sessionId, selected.account.credentialId);
        if (!pinned) {
            ctx.ui.notify(`Could not select ${selected.label}.`, 'error');
            return;
        }
        await resolveActiveAccount(ctx, pi.logger);
        const accounts = auth.oauth.accounts(PROVIDER, sessionId);
        snapshot = buildSnapshot(accounts, next.reports, labels);
        publish(ctx, snapshot, false);
        ctx.ui.notify(`OpenAI account selected: ${selected.label}.`, 'info');
    };

    const openAccountMenu = async (ctx: ExtensionContext): Promise<void> => {
        if (!ctx.hasUI) return;
        const choice = await ctx.ui.select('OpenAI Account Pool', [
            { label: 'Select account', description: 'Choose the active OpenAI account.' },
            { label: 'Refresh usage', description: 'Fetch current quota for every account.' },
            { label: 'Account health', description: 'Check authentication and usage endpoints.' },
            { label: 'Usage history', description: 'Show recent recorded usage snapshots.' },
            { label: 'Automatic routing', description: 'Release the current account pin.' },
            { label: 'Toggle status widget', description: 'Show or hide the compact status line.' },
        ]);
        if (choice === 'Select account') await selectAccount('', ctx);
        else if (choice === 'Refresh usage') await showAccounts('', ctx);
        else if (choice === 'Account health') await showHealth(ctx);
        else if (choice === 'Usage history') await showHistory('', ctx);
        else if (choice === 'Automatic routing') await selectAccount('auto', ctx);
        else if (choice === 'Toggle status widget') await toggleStatus('', ctx);
    };

    pi.registerCommand('openai-accounts', {
        description: 'Open the OpenAI account menu',
        handler: async (_args, ctx) => openAccountMenu(ctx),
    });

    pi.on('session_start', async (_event, ctx) => {
        await resolveActiveAccount(ctx, pi.logger);
        const next = await refreshUsage(ctx, true);
        const rotated = await rotateAccountIfNeeded(ctx, next, {
            autoSwitch,
            minimumRemainingPercent,
            labels,
            logger: pi.logger,
        });
        publish(ctx, rotated, false);
    });

    pi.on('turn_start', async (_event, ctx) => {
        await resolveActiveAccount(ctx, pi.logger);
        const next = await refreshUsage(ctx);
        const rotated = await rotateAccountIfNeeded(ctx, next, {
            autoSwitch,
            minimumRemainingPercent,
            labels,
            logger: pi.logger,
        });
        publish(ctx, rotated, false);
    });

    pi.on('turn_end', async (_event, ctx) => {
        await refreshUsage(ctx);
    });

    pi.on('auto_retry_end', async (_event, ctx) => {
        await refreshUsage(ctx);
    });

    pi.on('credential_disabled', async (_event, ctx) => {
        lastRefreshAt = 0;
        await refreshUsage(ctx, true);
    });

    pi.on('session_switch', async (_event, ctx) => {
        lastRefreshAt = 0;
        usageState.fetchedAt = undefined;
        usageState.refreshFailed = false;
        warnedLowUsageKeys.clear();
        snapshot = { accounts: [], reports: [] };
        await resolveActiveAccount(ctx, pi.logger);
        await refreshUsage(ctx, true);
    });

    pi.on('session_shutdown', async (_event, ctx) => {
        if (ctx.hasUI) ctx.ui.setWidget(STATUS_KEY, undefined);
    });
}
