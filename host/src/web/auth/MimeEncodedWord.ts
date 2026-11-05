/**
 * One RFC 2047 encoded word: `=?charset?Q|B?text?=`. The charset may carry
 * an RFC 2231 language suffix (`utf-8*de`), which is ignored.
 */
const ENCODED_WORD = /=\?([^?\s*]+)(?:\*[^?\s]*)?\?([QqBb])\?([^?\s]*)\?=/g;

/** Whitespace between two adjacent encoded words, which RFC 2047 says to drop. */
const GAP_BETWEEN_WORDS = /(\?=)\s+(?==\?)/g;

/**
 * Decode RFC 2047 encoded words in a header value. Proxies use them to
 * pass non-ASCII text through HTTP headers; Tailscale, for example, sends
 * `Tailscale-User-Name: =?utf-8?q?J=C3=BCrgen_Wei=C3=9F?=`. Plain text is
 * returned unchanged, and so is a word with an unknown charset or broken
 * encoding, so a malformed header never fails the request.
 *
 * @param value Raw header value.
 * @returns The decoded text.
 */
export function decodeMimeEncodedWords(value: string): string {
    if (!value.includes("=?")) {
        return value;
    }
    return value
        .replace(GAP_BETWEEN_WORDS, "$1")
        .replace(ENCODED_WORD, (word, charset: string, encoding: string, text: string) => {
            const bytes = encoding.toUpperCase() === "B" ? decodeBase64(text) : decodeQ(text);
            if (bytes === null) {
                return word;
            }
            try {
                return new TextDecoder(charset.toLowerCase(), { fatal: true }).decode(bytes);
            } catch {
                // Unknown charset or bytes invalid in it: keep the word as sent.
                return word;
            }
        });
}

/**
 * Decode the "Q" encoding: `_` is a space, `=XX` a hex byte.
 *
 * @param text Encoded text.
 * @returns The bytes, or null when an `=` escape is malformed.
 */
function decodeQ(text: string): Uint8Array | null {
    const bytes: number[] = [];
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === "_") {
            bytes.push(0x20);
        } else if (char === "=") {
            const hex = text.slice(index + 1, index + 3);
            if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
                return null;
            }
            bytes.push(Number.parseInt(hex, 16));
            index += 2;
        } else {
            bytes.push(text.charCodeAt(index));
        }
    }
    return Uint8Array.from(bytes);
}

/**
 * Decode the "B" encoding (base64).
 *
 * @param text Encoded text.
 * @returns The bytes, or null when it is not base64.
 */
function decodeBase64(text: string): Uint8Array | null {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
        return null;
    }
    return Uint8Array.from(Buffer.from(text, "base64"));
}
