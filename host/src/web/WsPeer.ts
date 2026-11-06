import type { WebSocketPeer } from "@getfamiliar/shared";
import { type RawData, WebSocket } from "ws";

/**
 * Adapts a `ws` socket to the library-independent {@link WebSocketPeer}
 * plugins receive. Text frames arrive as string, binary frames as bytes;
 * the close handler runs exactly once, also when it is registered after
 * the socket already closed.
 */
export class WsPeer implements WebSocketPeer {
    private readonly ws: WebSocket;
    private messageHandler: ((data: string | Uint8Array) => void) | null = null;
    private closeHandler: ((code: number, reason: string) => void) | null = null;
    /** Close code and reason once the socket closed, else null. */
    private closedWith: { readonly code: number; readonly reason: string } | null = null;

    /**
     * @param ws The accepted socket.
     * @param onHandlerError Reports an exception thrown by a plugin handler.
     */
    constructor(
        ws: WebSocket,
        private readonly onHandlerError: (err: unknown) => void,
    ) {
        this.ws = ws;
        ws.on("message", (data: RawData, isBinary: boolean) => {
            const handler = this.messageHandler;
            if (handler === null) {
                return;
            }
            try {
                handler(isBinary ? toBytes(data) : toBytes(data).toString("utf8"));
            } catch (err) {
                this.onHandlerError(err);
            }
        });
        ws.on("close", (code: number, reason: Buffer) => {
            this.closedWith = { code, reason: reason.toString("utf8") };
            this.runCloseHandler();
        });
    }

    /** @inheritdoc */
    get bufferedAmount(): number {
        return this.ws.bufferedAmount;
    }

    /** @inheritdoc */
    get isOpen(): boolean {
        return this.ws.readyState === WebSocket.OPEN;
    }

    /** @inheritdoc */
    send(data: string | Uint8Array): void {
        if (this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        this.ws.send(data, { binary: typeof data !== "string" });
    }

    /** @inheritdoc */
    close(code = 1000, reason = ""): void {
        if (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED) {
            return;
        }
        this.ws.close(code, reason);
    }

    /** @inheritdoc */
    onMessage(handler: (data: string | Uint8Array) => void): void {
        this.messageHandler = handler;
    }

    /** @inheritdoc */
    onClose(handler: (code: number, reason: string) => void): void {
        this.closeHandler = handler;
        if (this.closedWith !== null) {
            this.runCloseHandler();
        }
    }

    /** Call the close handler once, if both it and the close are known. */
    private runCloseHandler(): void {
        const handler = this.closeHandler;
        const closed = this.closedWith;
        if (handler === null || closed === null) {
            return;
        }
        this.closeHandler = null;
        try {
            handler(closed.code, closed.reason);
        } catch (err) {
            this.onHandlerError(err);
        }
    }
}

/**
 * Normalize the `ws` payload variants to one Buffer.
 *
 * @param data Buffer, ArrayBuffer or fragment list.
 * @returns The bytes.
 */
function toBytes(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data);
    }
    return Buffer.from(data);
}
