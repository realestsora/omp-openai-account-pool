import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { PROVIDER } from './constants';
import { buildSnapshot, remainingFraction } from './presentation';
import type { AccountLabels, AccountView, Snapshot } from './types';

export async function resolveActiveAccount(
    ctx: ExtensionContext,
    logger: ExtensionAPI['logger'],
): Promise<void> {
    const model = ctx.model?.provider === PROVIDER ? ctx.model : undefined;
    if (!model) return;
    const auth = ctx.modelRegistry.authStorage;
    if (
        auth.oauth
            .accounts(PROVIDER, ctx.sessionManager.getSessionId())
            .some((account) => account.active)
    ) {
        return;
    }
    try {
        await ctx.modelRegistry.getApiKeyWithCredentialForProvider(
            PROVIDER,
            ctx.sessionManager.getSessionId(),
            { modelId: model.id },
        );
    } catch (error) {
        logger.debug('OpenAI account resolution failed', { error: String(error) });
    }
}

function resetAtFor(view: AccountView): number | undefined {
    return view.limits.reduce<number | undefined>((latest, limit) => {
        const resetAt = limit.window?.resetsAt;
        if (typeof resetAt !== 'number') return latest;
        return latest === undefined ? resetAt : Math.max(latest, resetAt);
    }, undefined);
}

function minimumRemainingFraction(view: AccountView): number | undefined {
    const remaining = view.limits
        .map((limit) => remainingFraction(limit))
        .filter((value): value is number => value !== undefined);
    return remaining.length > 0 ? Math.min(...remaining) : undefined;
}

export function nextAvailableAccount(
    accounts: AccountView[],
    activePosition: number,
    minimumRemainingPercent = 0,
): AccountView | undefined {
    const ordered = [...accounts].sort(
        (left, right) => left.account.position - right.account.position,
    );
    const available = ordered.filter((view) => {
        if (view.exhausted) return false;
        if (minimumRemainingPercent <= 0) return true;
        const remaining = minimumRemainingFraction(view);
        return remaining === undefined || remaining * 100 > minimumRemainingPercent;
    });
    return (
        available.find((view) => view.account.position > activePosition) ??
        available.find((view) => view.account.position !== activePosition)
    );
}

export async function rotateAccountIfNeeded(
    ctx: ExtensionContext,
    snapshot: Snapshot,
    options: {
        autoSwitch: boolean;
        minimumRemainingPercent: number;
        labels: AccountLabels;
        logger: ExtensionAPI['logger'];
    },
): Promise<Snapshot> {
    if (!options.autoSwitch) return snapshot;
    const model = ctx.model?.provider === PROVIDER ? ctx.model : undefined;
    if (!model) return snapshot;
    const sessionId = ctx.sessionManager.getSessionId();
    const active = snapshot.accounts.find((view) => view.account.active);
    if (!active || snapshot.accounts.length < 2) return snapshot;

    const remaining = minimumRemainingFraction(active);
    const preemptive =
        !active.exhausted &&
        options.minimumRemainingPercent > 0 &&
        remaining !== undefined &&
        remaining * 100 <= options.minimumRemainingPercent;
    if (!active.exhausted && !preemptive) return snapshot;

    const auth = ctx.modelRegistry.authStorage;
    if (preemptive) {
        const candidate = nextAvailableAccount(
            snapshot.accounts.filter(
                (view) => view.account.credentialId !== active.account.credentialId,
            ),
            active.account.position,
            options.minimumRemainingPercent,
        );
        if (!candidate) return snapshot;
        const pinned = auth.sessions.pin(PROVIDER, sessionId, candidate.account.credentialId, {
            restoredAtMs: Date.now(),
        });
        if (!pinned) return snapshot;
        try {
            await ctx.modelRegistry.getApiKeyWithCredentialForProvider(PROVIDER, sessionId, {
                modelId: model.id,
            });
        } catch (error) {
            options.logger.debug('OpenAI preemptive account switch failed', {
                error: String(error),
            });
            return snapshot;
        }
    } else {
        const resetAt = resetAtFor(active);
        const retryAfterMs = resetAt === undefined ? undefined : Math.max(0, resetAt - Date.now());
        try {
            const result = await auth.limits.markReached(PROVIDER, sessionId, {
                credentialId: active.account.credentialId,
                modelId: model.id,
                baseUrl: model.baseUrl,
                retryAfterMs,
                providerTimed: retryAfterMs !== undefined,
            });
            if (!result.switched) return snapshot;
            await ctx.modelRegistry.getApiKeyWithCredentialForProvider(PROVIDER, sessionId, {
                modelId: model.id,
            });
        } catch (error) {
            options.logger.debug('OpenAI account rotation failed', { error: String(error) });
            return snapshot;
        }
    }

    const nextAccounts = auth.oauth.accounts(PROVIDER, sessionId);
    const nextSnapshot = buildSnapshot(nextAccounts, snapshot.reports, options.labels);
    const next = nextSnapshot.accounts.find((view) => view.account.active);
    if (ctx.hasUI && next && next.account.credentialId !== active.account.credentialId) {
        const reason = active.exhausted
            ? 'limit reached'
            : `remaining quota <= ${options.minimumRemainingPercent}%`;
        ctx.ui.notify(
            `OpenAI account ${active.label} ${reason}; switched to ${next.label}.`,
            'warning',
        );
    }
    return nextSnapshot;
}
