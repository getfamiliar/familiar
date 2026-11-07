import { useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { findPluginPage, PluginPage } from "@/components/plugin-page";
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
 * plugin page owning the current route (placeholder content otherwise).
 * The breadcrumb starts at the assistant's name and names the menu
 * entry of the current page; the document title is the assistant's name.
 *
 * @returns The app shell.
 */
export default function App() {
    const shell = useShell();
    const pathname = window.location.pathname;
    const active = shell === null ? null : findActiveMenuPath(shell.menu, pathname);
    const page = shell === null ? null : findPluginPage(shell.pages, pathname);
    const assistantName = shell?.assistantName ?? null;
    useEffect(() => {
        if (assistantName !== null) {
            document.title = assistantName;
        }
    }, [assistantName]);
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
                    {shell !== null && page !== null ? (
                        <PluginPage page={page} pathname={pathname} user={shell.user} />
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
