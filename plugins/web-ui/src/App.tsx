import { avatarToDataUrl } from "@getfamiliar/avatar";
import { useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { findPluginPage, PluginPage } from "@/components/plugin-page";
import { AVATAR_SETTINGS_ROUTE, AvatarSettings } from "@/components/settings/avatar-settings";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useShell } from "@/hooks/use-shell";
import { findActiveMenuPath } from "@/lib/menu";

/**
 * Root of the web UI: the collapsible-to-icons sidebar (shadcn block
 * `sidebar-07`) with the plugins' menu; the content area shows the
 * web UI's own settings pages or the plugin page owning the current route
 * (placeholder content otherwise). The breadcrumb starts at the
 * assistant's name and names the menu entry of the current page; the
 * document title is the assistant's name, the favicon its avatar.
 *
 * @returns The app shell.
 */
export default function App() {
    const { shell, setAssistantAvatar } = useShell();
    const pathname = window.location.pathname;
    const active = shell === null ? null : findActiveMenuPath(shell.menu, pathname);
    const isAvatarSettings = pathname === AVATAR_SETTINGS_ROUTE;
    const page = shell === null || isAvatarSettings ? null : findPluginPage(shell.pages, pathname);
    const assistantName = shell?.assistant.name ?? null;
    const avatar = shell?.assistant.avatar ?? null;
    useEffect(() => {
        if (assistantName !== null) {
            document.title = assistantName;
        }
    }, [assistantName]);
    useEffect(() => {
        if (avatar !== null) {
            setFavicon(avatarToDataUrl(avatar));
        }
    }, [avatar]);
    return (
        <TooltipProvider>
            <SidebarProvider>
                <AppSidebar shell={shell} pathname={pathname} />
                <SidebarInset
                    className={page === null ? undefined : "h-svh min-h-0 overflow-hidden"}
                >
                    <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
                        <div className="flex items-center gap-2 px-4">
                            <SidebarTrigger className="-ml-1" />
                            <Separator
                                orientation="vertical"
                                className="mr-2 data-vertical:h-4 data-vertical:self-auto"
                            />
                            <Breadcrumb>
                                <BreadcrumbList>
                                    <BreadcrumbItem className="hidden md:block">
                                        <BreadcrumbLink href="/">
                                            {assistantName ?? "\u00a0"}
                                        </BreadcrumbLink>
                                    </BreadcrumbItem>
                                    {active !== null && (
                                        <>
                                            <BreadcrumbSeparator className="hidden md:block" />
                                            {active.child === undefined ? (
                                                <BreadcrumbItem>
                                                    <BreadcrumbPage>{active.item}</BreadcrumbPage>
                                                </BreadcrumbItem>
                                            ) : (
                                                <>
                                                    <BreadcrumbItem className="hidden md:block">
                                                        {active.item}
                                                    </BreadcrumbItem>
                                                    <BreadcrumbSeparator className="hidden md:block" />
                                                    <BreadcrumbItem>
                                                        <BreadcrumbPage>
                                                            {active.child}
                                                        </BreadcrumbPage>
                                                    </BreadcrumbItem>
                                                </>
                                            )}
                                        </>
                                    )}
                                </BreadcrumbList>
                            </Breadcrumb>
                        </div>
                    </header>
                    {shell !== null && isAvatarSettings ? (
                        <AvatarSettings
                            savedAvatar={shell.assistant.avatar}
                            onSaved={setAssistantAvatar}
                        />
                    ) : shell !== null && page !== null ? (
                        <PluginPage
                            page={page}
                            pathname={pathname}
                            user={shell.user}
                            assistant={shell.assistant}
                        />
                    ) : (
                        <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
                            <div className="grid auto-rows-min gap-4 md:grid-cols-3">
                                <div className="aspect-video rounded-xl bg-muted/50" />
                                <div className="aspect-video rounded-xl bg-muted/50" />
                                <div className="aspect-video rounded-xl bg-muted/50" />
                            </div>
                            <div className="min-h-screen flex-1 rounded-xl bg-muted/50 md:min-h-min" />
                        </div>
                    )}
                </SidebarInset>
            </SidebarProvider>
        </TooltipProvider>
    );
}

/**
 * Point the document's icon at `href`, creating the `<link rel="icon">`
 * when the page has none.
 *
 * @param href Icon URL (here a `data:` URL).
 */
function setFavicon(href: string): void {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link === null) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.append(link);
    }
    link.type = "image/svg+xml";
    link.href = href;
}
