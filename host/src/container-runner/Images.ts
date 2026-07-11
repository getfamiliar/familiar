import type { Logger } from "@getfamiliar/shared";
import { type Bootstrap, imageRef } from "../Bootstrap.js";
import { dockerExec, isImagePresent } from "../DockerTools.js";

/**
 * In `"pull"` image mode, ensure the version-pinned published image for
 * `imageName` is present locally and (re)tagged with its plain local
 * name, so every consumer that references the plain tag keeps working
 * unchanged. Pulls only when the versioned reference is missing (images
 * are immutable per version), then always re-points the local tag at it
 * — cheap, and correct after an `npm update` bumps {@link Bootstrap.imageTag}
 * while the old local tag still lingers.
 *
 * In `"build"` mode this is a no-op and returns `false`, signalling the
 * caller to build the image locally instead.
 *
 * @param boot bootstrap providing image mode, registry, and tag.
 * @param imageName the image's name, used both as local tag and registry name.
 * @param log logger for the pull step.
 * @returns `true` when the pull path handled the image, `false` when the caller should build.
 */
export async function pullImageIfNeeded(
    boot: Bootstrap,
    imageName: string,
    log: Logger,
): Promise<boolean> {
    if (boot.imageMode !== "pull") {
        return false;
    }
    const ref = imageRef(boot, imageName);
    if (!(await isImagePresent(ref))) {
        log.info(`pulling ${imageName} image ${ref}`);
        await dockerExec(["pull", ref]);
    }
    await dockerExec(["tag", ref, imageName]);
    return true;
}
