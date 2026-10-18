import {
    isJidBroadcast,
    isJidGroup,
    isJidNewsletter,
    isLidUser,
    isPnUser,
    jidDecode,
    type WAMessageKey,
    type WASocket,
} from "@whiskeysockets/baileys";

/**
 * What kind of conversation a `remoteJid` addresses:
 *
 * - `group`: a group chat (`…@g.us`).
 * - `direct`: a one-to-one chat, addressed either by phone number
 *   (`…@s.whatsapp.net`) or by WhatsApp's privacy-preserving LID
 *   (`…@lid`).
 * - `other`: status updates, broadcast lists, newsletters/channels and
 *   anything unknown — never interesting to the assistant.
 */
export type ChatKind = "group" | "direct" | "other";

/**
 * Classify a message's `remoteJid` into a {@link ChatKind}.
 *
 * @param jid The `remoteJid` of a message key, possibly missing.
 * @returns The conversation kind; `other` for missing or unknown JIDs.
 */
export function classifyChatJid(jid: string | null | undefined): ChatKind {
    if (!jid) {
        return "other";
    }
    if (isJidBroadcast(jid) || isJidNewsletter(jid)) {
        return "other";
    }
    if (isJidGroup(jid)) {
        return "group";
    }
    if (isPnUser(jid) || isLidUser(jid)) {
        return "direct";
    }
    return "other";
}

/**
 * Normalize a user-written phone number to the bare digits WhatsApp
 * uses in phone-number JIDs (E.164 without the leading `+`). Strips
 * `+`, spaces, dashes, dots, slashes and parentheses; a leading `00`
 * international prefix is dropped too.
 *
 * @param raw Phone number as written in config or typed by the user.
 * @returns The digits, or `null` when nothing digit-only remains.
 */
export function normalizePhoneNumber(raw: string | null | undefined): string | null {
    if (typeof raw !== "string") {
        return null;
    }
    const digits = raw.replace(/[\s+\-./()]/g, "").replace(/^00/, "");
    if (!/^\d+$/.test(digits)) {
        return null;
    }
    return digits;
}

/**
 * Extract the phone number from a phone-number JID
 * (`4917…:12@s.whatsapp.net` → `4917…`). The device suffix is dropped.
 *
 * @param jid Any JID, possibly missing.
 * @returns The phone number, or `null` when `jid` is not a PN user JID.
 */
export function phoneNumberFromJid(jid: string | null | undefined): string | null {
    if (!jid || !isPnUser(jid)) {
        return null;
    }
    return jidDecode(jid)?.user ?? null;
}

/**
 * Whether the sender's phone number matches the configured authorized
 * number. Both sides are compared in their normalized digit form.
 *
 * @param senderNumber The sender's phone number, or `null` if unknown.
 * @param authorizedNumber The configured authorized number (normalized).
 * @returns `true` only when both are known and equal.
 */
export function isAuthorizedSender(
    senderNumber: string | null,
    authorizedNumber: string | null,
): boolean {
    if (senderNumber === null || authorizedNumber === null) {
        return false;
    }
    return normalizePhoneNumber(senderNumber) === normalizePhoneNumber(authorizedNumber);
}

/**
 * Resolve the phone number of a one-to-one chat's counterpart. WhatsApp
 * increasingly addresses chats by LID instead of phone number, so the
 * lookup tries, in order: the `remoteJid` itself, baileys' `remoteJidAlt`
 * (the PN twin of a LID JID), and finally the socket's LID→PN mapping
 * store.
 *
 * @param sock The connected socket owning the LID mapping store.
 * @param key The message key of the direct message.
 * @returns The counterpart's phone number, or `null` when unknown.
 */
export async function resolveCounterpartNumber(
    sock: WASocket,
    key: WAMessageKey,
): Promise<string | null> {
    const direct = phoneNumberFromJid(key.remoteJid) ?? phoneNumberFromJid(key.remoteJidAlt);
    if (direct !== null) {
        return direct;
    }
    if (!key.remoteJid || !isLidUser(key.remoteJid)) {
        return null;
    }
    const pnJid = await sock.signalRepository.lidMapping.getPNForLID(key.remoteJid);
    return phoneNumberFromJid(pnJid);
}
