import { AvatarSvg } from "@getfamiliar/avatar";
import type { WebAssistantIdentity, WebAuthPageView } from "@getfamiliar/shared";
import { cn } from "cn";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldSeparator } from "@/components/ui/field";

/**
 * A login-flow page in the look of the shadcn block `login-04`: a card
 * with the content on the left and a decorative panel on the right.
 * Rendered server-side to static markup and served without any script,
 * so everything interactive is a plain link or form; what the forms do
 * is decided by the core webserver.
 *
 * @param props.view The page the core decided to show.
 * @param props.assistant The assistant's name and avatar.
 * @returns The page body.
 */
export function AuthPage({
    view,
    assistant,
}: {
    readonly view: WebAuthPageView;
    readonly assistant: WebAssistantIdentity;
}) {
    const assistantName = assistant.name;
    return (
        <div className="flex min-h-svh flex-col items-center justify-center bg-muted p-6 md:p-10">
            <div className="w-full max-w-sm md:max-w-4xl">
                <div className="flex flex-col gap-6">
                    <Card className="overflow-hidden p-0">
                        <CardContent className="grid p-0 md:grid-cols-2">
                            <div className="p-6 md:p-8">
                                <AuthPageContent view={view} name={assistantName} />
                            </div>
                            <BrandPanel assistant={assistant} />
                        </CardContent>
                    </Card>
                    <FieldDescription className="px-6 text-center">
                        {assistantName} — your personal AI assistant.
                    </FieldDescription>
                </div>
            </div>
        </div>
    );
}

/**
 * The view-specific left half of the card.
 *
 * @param props.view The page to show.
 * @param props.name The assistant's name.
 * @returns Heading, text and actions.
 */
function AuthPageContent({
    view,
    name,
}: {
    readonly view: WebAuthPageView;
    readonly name: string;
}) {
    switch (view.kind) {
        case "signedIn":
            return (
                <FieldGroup>
                    <Heading title="You're signed in">
                        as{" "}
                        <span className="font-medium text-foreground">
                            {view.principal.displayName}
                        </span>
                    </Heading>
                    <FieldDescription className="text-center">
                        {view.principal.login} · via {view.principal.via}
                    </FieldDescription>
                    <Field>
                        <Button asChild>
                            <a href={view.continueUrl}>Continue to {name}</a>
                        </Button>
                    </Field>
                    <form method="post" action={view.logoutAction}>
                        <Field>
                            <Button type="submit" variant="outline">
                                Sign out
                            </Button>
                        </Field>
                    </form>
                </FieldGroup>
            );
        case "signedOut":
            return (
                <FieldGroup>
                    <Heading title={`Sign in to ${name}`}>You are not signed in.</Heading>
                    <ol className="flex list-none flex-col gap-4 text-sm">
                        <Step number={1}>
                            On the machine running familiar, run{" "}
                            <Command>{view.loginCommand}</Command>
                        </Step>
                        <Step number={2}>Open the printed link in this browser.</Step>
                    </ol>
                    <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
                        Or
                    </FieldSeparator>
                    <FieldDescription className="text-center">
                        Ask {name} in chat for a login link.
                    </FieldDescription>
                </FieldGroup>
            );
        case "confirmLoginLink":
            return (
                <form method="post" action={view.formAction}>
                    <FieldGroup>
                        <Heading title="Welcome back">Sign in to {name} in this browser.</Heading>
                        <Field>
                            <Button type="submit">Sign in</Button>
                        </Field>
                        <FieldDescription className="text-center">
                            This login link works only once.
                        </FieldDescription>
                    </FieldGroup>
                </form>
            );
        case "invalidLoginLink":
            return (
                <FieldGroup>
                    <Heading title="Link not valid">
                        This login link is invalid, already used or expired.
                    </Heading>
                    <FieldDescription className="text-center">
                        Run <Command>{view.loginCommand}</Command> for a new one, or ask {name} in
                        chat.
                    </FieldDescription>
                    <Field>
                        <Button asChild variant="outline">
                            <a href="/login">Back to sign in</a>
                        </Button>
                    </Field>
                </FieldGroup>
            );
    }
}

/**
 * Centered page heading with a short lead text.
 *
 * @param props.title Heading.
 * @param props.children Lead text.
 * @returns The heading block.
 */
function Heading({
    title,
    children,
}: {
    readonly title: string;
    readonly children: React.ReactNode;
}) {
    return (
        <div className="flex flex-col items-center gap-2 text-center">
            <h1 className="text-2xl font-bold">{title}</h1>
            <p className="text-balance text-muted-foreground">{children}</p>
        </div>
    );
}

/**
 * One numbered instruction.
 *
 * @param props.number Step number.
 * @param props.children Instruction.
 * @returns The list item.
 */
function Step({
    number,
    children,
}: {
    readonly number: number;
    readonly children: React.ReactNode;
}) {
    return (
        <li className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                {number}
            </span>
            <span className="pt-0.5">{children}</span>
        </li>
    );
}

/**
 * Inline shell command.
 *
 * @param props.children Command text.
 * @returns The code element.
 */
function Command({
    children,
    className,
}: {
    readonly children: React.ReactNode;
    readonly className?: string;
}) {
    return (
        <code
            className={cn(
                "whitespace-nowrap rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground",
                className,
            )}
        >
            {children}
        </code>
    );
}

/**
 * Right half of the card (hidden on small screens), in place of the
 * block's placeholder image.
 *
 * @param props.assistant The assistant's name and avatar.
 * @returns The decorative panel.
 */
function BrandPanel({ assistant }: { readonly assistant: WebAssistantIdentity }) {
    return (
        <div className="relative hidden flex-col items-center justify-center gap-4 bg-primary p-8 text-primary-foreground md:flex">
            <AvatarSvg
                config={assistant.avatar}
                className="size-32 rounded-full ring-4 ring-primary-foreground/15"
            />
            <div className="text-center">
                <p className="text-2xl font-semibold tracking-tight">{assistant.name}</p>
                <p className="text-sm text-primary-foreground/70">Loyal. Local. Markdown.</p>
            </div>
        </div>
    );
}
