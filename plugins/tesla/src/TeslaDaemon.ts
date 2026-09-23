import type { HostContext } from "@getfamiliar/shared";
import { OwnerApiClient } from "./api/OwnerApiClient.js";
import { OwnershipClient } from "./api/OwnershipClient.js";
import { setActiveSession, type TeslaSession } from "./auth/ActiveSession.js";
import { TeslaAuth } from "./auth/TeslaAuth.js";
import { TokenStore, tokenFile } from "./auth/TokenStore.js";
import { readTeslaConfig } from "./Config.js";
import { describeError } from "./ErrorText.js";
import { DefaultVehicleStore, defaultVehicleFile } from "./state/DefaultVehicleStore.js";
import { cacheDirectory, VehicleDataCache } from "./state/VehicleDataCache.js";

/**
 * Assemble the plugin's session from the host context: token store,
 * auth, both API clients, and the two on-disk state stores.
 *
 * Shared by the daemon and by every CLI command, so `familiar tesla
 * status` sees exactly the same wiring the running daemon does.
 *
 * @param ctx Plugin host context.
 * @returns The assembled session.
 */
export function buildTeslaSession(ctx: HostContext): TeslaSession {
    const config = readTeslaConfig(ctx);
    const auth = new TeslaAuth(new TokenStore(tokenFile(ctx.dataDir)));
    const tokenProvider = () => auth.getAccessToken();
    return {
        auth,
        owner: new OwnerApiClient(tokenProvider),
        ownership: new OwnershipClient(tokenProvider, config),
        defaults: new DefaultVehicleStore(defaultVehicleFile(ctx.dataDir)),
        cache: new VehicleDataCache(cacheDirectory(ctx.dataDir)),
        config,
    };
}

/**
 * Boot the Tesla plugin: load the cached login, prove it still works,
 * and publish the session the tools resolve through.
 *
 * The daemon stays up regardless of login state — a missing or dead
 * token is logged and the tools report it with a message naming the
 * fix, rather than taking the host down over one plugin. There are no
 * pollers and no event sources: the plugin is purely tool-driven.
 *
 * @param ctx Plugin host context.
 */
export async function startTeslaDaemon(ctx: HostContext): Promise<void> {
    const session = buildTeslaSession(ctx);
    setActiveSession(session);

    const tokens = await session.auth.load();
    if (tokens === null) {
        ctx.logger.info(
            "tesla: no login cached at " +
                `${tokenFile(ctx.dataDir)}; run \`familiar tesla login\` to add one`,
        );
        return;
    }

    try {
        await session.auth.forceRefresh();
    } catch (err) {
        const reason = describeError(err);
        ctx.logger.warn(
            `tesla: cached login for ${tokens.email || "(unknown account)"} could not be ` +
                `refreshed (${reason}); tools will fail until \`familiar tesla login\` is re-run`,
        );
        return;
    }

    const current = await session.defaults.read();
    ctx.logger.info(
        `tesla: login for ${tokens.email || "(unknown account)"} is active; default vehicle is ` +
            (current === null
                ? "not set yet (resolved on first tool call)"
                : `${current.displayName || current.id} (${current.vin})`),
    );
}
